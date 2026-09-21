// Twilio WhatsApp webhook: form-encoded in, TwiML out. Same engine as the app and API.
//
// A short guided chat. Each chat's current step is kept in `wa_sessions`, keyed
// by a hash of the phone number, and expires after 10 minutes. One-line
// commands (CHECK 0123456789 GTBank) skip the questions.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AUDIO_TYPES, classifyReport, extractAccounts, IMAGE_TYPES, Language, LANGUAGES, localize, transcribeAudio } from '@/lib/ai';
import { after } from 'next/server';
import { asDemo, db, inDemo, rateLimit, resetDemo } from '@/lib/db';
import { checkAccount, peekAccount, reporterKey, submitReport } from '@/lib/engine';
import {
  attachReference, callScript, CARD_ADVICE, CaseFacts, cbnEscalation, demoFastForward, getCase, helpFor, institution,
  latestCase, markFiled, NEVER, nextStep, openCase, REFERENCE_NUDGE, urgency, writtenComplaint,
} from '@/lib/escalate';
import { resolveAccount } from '@/lib/paystack';
import { Bank, BANKS, CATEGORIES, Classification, findBank, formatDate, Intelligence, n, POPULAR_BANKS, Verification } from '@/lib/shared';

type Found = { accountNumber: string; bank: Bank | null; amount?: number | null; fromBank?: Bank | null };
/** Scam-flow details the victim gave before we asked for them ("I lost 100,000 naira", a receipt). */
type Pre = { amount?: number | null; victimBank?: Bank | null };
type State =
  | { step: 'menu' }
  | { step: 'check_number' }
  | { step: 'check_bank'; number: string }
  | { step: 'after_check'; number: string; bank: Bank }
  | { step: 'pick_found'; found: Found[]; purpose: 'check' | 'report' | 'escalate'; sentAt?: string; pre?: Pre }
  | { step: 'report_number' }
  | { step: 'report_bank'; number: string; story?: string }
  | { step: 'report_story'; number: string; bank: Bank }
  | { step: 'report_confirm'; number: string; bank: Bank; story: string; c: Classification; hasMedia: boolean }
  // Escalation: someone has already lost money. Helping them comes first; the
  // report falls out of the same answers at the end.
  | { step: 'esc_when'; pre?: Pre }
  | { step: 'esc_date'; pre?: Pre }
  | { step: 'esc_number'; sentAt: string; pre?: Pre }
  | { step: 'esc_bank'; sentAt: string; number: string; pre?: Pre }
  | { step: 'esc_amount'; f: Facts }
  | { step: 'esc_my_bank'; f: Facts }
  | { step: 'esc_call'; caseId: string; f: Facts }
  | { step: 'esc_written'; caseId: string; f: Facts }
  | { step: 'esc_story'; caseId: string; f: Facts }
  | { step: 'esc_reference'; caseId: string }
  | { step: 'pick_lang' };

type Facts = CaseFacts;

const SESSION_MS = 10 * 60_000;

/* ───────────── Messages ───────────── */

const WELCOME = `👋 Welcome to *TRACE* — check before you trust.

Reply with a number:
*1* Check an account before I pay
*2* I have sent money and something is wrong
*3* How TRACE works

Tip: you can also paste an account number, send a screenshot, or send a voice note.`;

const HOW = `*How TRACE works*

• We show what other people have reported about an account, and confirm the account name with the bank.
• Reports are signals, not proof. One person alone can never mark an account as high risk.
• Reporters stay anonymous. Your number is never shown.

• If you have already sent money, TRACE tells you who to call first and writes your complaint for you.

Shortcuts:
*CHECK 0123456789 GTBank*
*REPORT 0123456789 GTBank what happened*
*HELP ME* if you have already sent money
*STATUS* to check your case
*MENU* to start again`;

const BANK_MENU = POPULAR_BANKS.map((b, i) => `*${i + 1}* ${b}`).join('\n');
const askBank = (number: string) => `Which bank is *${number}* with?\n\n${BANK_MENU}\n\nOr type the bank name.`;

/**
 * Text that is sent exactly as written, whatever language the chat is in: account
 * names, the risk verdict, and what the person reads or sends to their bank or CBN.
 */
const keep = (s: string) => `⟦${s}⟧`;

const LANG_NAMES: Record<Language, string> = { English: 'English', 'Nigerian Pidgin': 'Pidgin', Yoruba: 'Yorùbá', Hausa: 'Hausa', Igbo: 'Igbo' };
const LANG_MENU = keep(`🌍 *Choose your language*\n\n${LANGUAGES.map((l, i) => `*${i + 1}* ${LANG_NAMES[l]}`).join('\n')}\n*${LANGUAGES.length + 1}* Automatic — follow what I type`);

/**
 * What TRACE already knows about the beneficiary account, folded into the case.
 * A bank treats "I think I was scammed" and "this account has 7 complaints against
 * it" very differently, so the victim gets to use the database on the call.
 */
function facts(sentAt: string, accountNumber: string, bank: Bank, pre?: Pre): Facts {
  const i = checkAccount(bank, accountNumber, 'whatsapp');
  return { accountNumber, bank, victimBank: pre?.victimBank ?? null, amount: pre?.amount ?? null, sentAt, reports: i.reports, reporters: i.uniqueReporters };
}

const ASK_MY_BANK = `Which bank did *you* send the money FROM?\n\n${BANK_MENU}\n\nOr type the bank name.`;

/**
 * The next scam-flow question, skipping whatever the victim already told us.
 * `first` is the step right after the account is known: it may ask the amount and
 * carries the warning when others have reported the account.
 */
function escNext(f: Facts, phone: string, first: boolean): [string, State] {
  const known = first && f.reports
    ? [`⚠️ *${n(f.reporters ?? 0)} ${f.reporters === 1 ? 'person has' : 'people have'} already reported this account.*`, 'Tell your bank that — it is not just your word.', '']
    : [];
  if (first && f.amount == null) {
    return [[...known, `How much did you send to ${f.accountNumber}?`, '', 'Just the amount, for example *45000*.', 'Reply *SKIP* if you would rather not say.'].join('\n'), { step: 'esc_amount', f }];
  }
  if (!f.victimBank) return [[...known, ASK_MY_BANK].join('\n'), { step: 'esc_my_bank', f }];
  const c = openCase({ ...f, reporter: phone });
  return [[...known, callStep(c.id, f)].join('\n'), { step: 'esc_call', caseId: c.id, f }];
}

/** A naira amount in free text: "₦45,000", "100,000 naira", "50k". A bare number is ignored — it may be an account number. */
function amountIn(text: string): number | null {
  for (const m of text.matchAll(/(₦|\bngn|\bn)?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k|m|thousand|million)?\s*(naira|ngn)?\b/gi)) {
    if (!m[1] && !m[3] && !m[4]) continue;
    const unit = m[3]?.toLowerCase();
    const value = Number(m[2].replace(/,/g, '')) * (unit === 'k' || unit === 'thousand' ? 1e3 : unit ? 1e6 : 1);
    if (value >= 1 && value < 1e10) return Math.round(value);
  }
  return null;
}

function nameLine(v: Verification, bank: Bank): string[] {
  if (v.status === 'verified') return [`✅ Account name: ${keep(`*${v.accountName}*`)}`, 'Does this match who you are paying? If not, stop.', ''];
  if (v.status === 'not_found') return [`⛔ *Account not found at ${bank}.*`, "Don't send money until you confirm the number and bank.", ''];
  if (v.reason === 'rate_limited') return ['ℹ️ Name check paused — too many lookups this hour.', ''];
  if (v.reason === 'error') return ["ℹ️ Couldn't confirm the account name right now. Check it in your bank app.", ''];
  if (v.reason === 'sample') return ['ℹ️ Sample data — name check skipped.', ''];
  return [];
}

function formatCheck(i: Intelligence, v: Verification, bank: Bank): string {
  if (v.status === 'not_found' && i.reports === 0) {
    return [`⛔ *Account not found*`, `${i.accountNumber} · ${bank}`, '', "This number doesn't match an account at that bank.", "Don't send money until you confirm the number and bank with the recipient.", '', 'Send another account number, or *MENU*.'].join('\n');
  }
  const icon = { HIGH: '🔴', MEDIUM: '🟠', LOW: '🟢' }[i.risk];
  const lines = [keep(`${icon} *${i.risk} RISK SIGNAL*`), `${i.accountNumber} · ${bank}`, '', ...nameLine(v, bank)];
  if (i.reports === 0) {
    lines.push('No reports found.', 'ℹ️ Not a guarantee — verify before you pay.');
  } else {
    lines.push(`${n(i.reports)} report${i.reports === 1 ? '' : 's'} from ${n(i.uniqueReporters)} ${i.uniqueReporters === 1 ? 'person' : 'people'}.`);
    if (i.patterns.length) lines.push('', 'Common reports:', ...i.patterns.slice(0, 2).map((p) => `• ${p.label}`));
    lines.push('', `Last reported: ${i.lastReportedAgo}`, '', '⚠️ Verify the recipient before sending money.');
  }
  if (i.disputed) lines.push('', 'ℹ️ The account holder has disputed these reports.');
  lines.push('', 'Reply *2* to report this account, or *MENU*.', '_Reports are signals, not proof._');
  return lines.join('\n');
}

/* ───────────── Input parsing ───────────── */

/** A bank from a menu number, a name, an alias, or a unique partial name. */
function parseBank(text: string): Bank | null {
  const t = text.trim();
  if (/^\d$/.test(t)) return POPULAR_BANKS[Number(t) - 1] ?? null;
  const exact = findBank(t);
  if (exact) return exact;
  const q = t.toLowerCase();
  if (q.length < 3) return null;
  const partial = BANKS.filter((b) => b.toLowerCase().includes(q));
  return partial.length === 1 ? partial[0] : null;
}

/**
 * Someone opening with "I was scammed" in their own words. Matched on meaning-bearing
 * words (English, Pidgin, and common Yoruba/Hausa/Igbo terms), diacritics stripped.
 * Only used where no other answer is expected, so it can't swallow a story mid-flow.
 */
const SCAM_WORDS = /\b(scam\w*|fraud\w*|defraud\w*|dup(e|ed|ing)|419|swindl\w*|con ?man|conned|stole|stolen|robbed|chop(ped)? my money|took my money|lost (my )?money|sent (the |my )?money|(don|done) send (the |my )?money|paid .* (blocked|disappeared)|block(ed)? me|yahoo ?boy|wayo|jibiti|damfara|aghugho)\b/;
function soundsScammed(text: string): boolean {
  return SCAM_WORDS.test(text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase());
}

/** A 10-digit account number anywhere in the text, tolerating spaces or dashes between digits. */
function findNumber(text: string): { number: string; rest: string } | null {
  const joined = text.replace(/(\d)[\s-](?=\d)/g, '$1');
  const m = joined.match(/(?<!\d)\d{10}(?!\d)/);
  return m ? { number: m[0], rest: joined.replace(m[0], ' ').replace(/\s+/g, ' ').trim() } : null;
}

/** Bank name at the start of `words`, up to 4 words long. */
function leadingBank(words: string[]): { bank: Bank | null; rest: string[] } {
  for (let k = Math.min(4, words.length); k >= 1; k--) {
    const bank = findBank(words.slice(0, k).join(' '));
    if (bank) return { bank, rest: words.slice(k) };
  }
  return { bank: null, rest: words };
}

/* ───────────── Sessions ───────────── */

function load(phone: string): State {
  const row = db().prepare('SELECT state, updated_at FROM wa_sessions WHERE phone = ?').get(phone) as { state: string; updated_at: string } | undefined;
  if (!row || Date.now() - Date.parse(row.updated_at) > SESSION_MS) return { step: 'menu' };
  return JSON.parse(row.state) as State;
}

function save(phone: string, s: State) {
  db().prepare('INSERT INTO wa_sessions VALUES (?, ?, ?) ON CONFLICT(phone) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at')
    .run(phone, JSON.stringify(s), new Date().toISOString());
}

function getLang(phone: string): { lang: Language; pinned: boolean } {
  const row = db().prepare('SELECT lang, pinned FROM wa_prefs WHERE phone = ?').get(phone) as { lang: string; pinned: number } | undefined;
  return { lang: LANGUAGES.find((l) => l === row?.lang) ?? 'English', pinned: !!row?.pinned };
}

function setLang(phone: string, lang: Language, pinned: boolean) {
  db().prepare('INSERT INTO wa_prefs (phone, lang, pinned) VALUES (?, ?, ?) ON CONFLICT(phone) DO UPDATE SET lang = excluded.lang, pinned = excluded.pinned')
    .run(phone, lang, pinned ? 1 : 0);
}

/**
 * The reply in the chat's language. A message with a few real words can switch the
 * language; "1", "YES" or "gtb" can't, so the chat keeps the language it has.
 * Kept text (keep()) is never sent for translation. Any failure sends English.
 */
async function finish(phone: string, userText: string, reply: string, timeoutMs: number): Promise<string> {
  const english = reply.replace(/[⟦⟧]/g, '');
  const { lang, pinned } = getLang(phone);
  const detect = !pinned && (userText.match(/\p{L}{2,}/gu)?.length ?? 0) >= 3;
  if ((!detect && lang === 'English') || timeoutMs < 800) return english;

  // Split around kept text: even indexes are translated, odd ones are sent as written.
  const parts = reply.split(/⟦([\s\S]*?)⟧/);
  const idx = parts.flatMap((p, i) => (i % 2 === 0 && /\p{L}/u.test(p) ? [i] : []));
  // Detecting may switch language, so everything goes; otherwise only lines not yet cached.
  const todo = detect ? idx : idx.filter((i) => !translated.has(`${lang}\n${parts[i]}`));
  let target = lang;
  if (todo.length) {
    const out = await localize(detect ? userText : '', lang, todo.map((i) => parts[i]), timeoutMs);
    if (!out) return english;
    target = out.language;
    if (detect && target !== lang) setLang(phone, target, false);
    if (target === 'English') return english;
    // An earlier translation wins, so a line reads the same every time.
    todo.forEach((i, j) => { if (!translated.has(`${target}\n${parts[i]}`)) remember(`${target}\n${parts[i]}`, out.segments[j]); });
  }
  idx.forEach((i) => { parts[i] = translated.get(`${target}\n${parts[i]}`) ?? parts[i]; });
  return parts.join('');
}

// Same English line → same translation every time, and no second Gemini call for it.
// ponytail: in-memory, lost on restart; persist it (or ship reviewed translations) if that matters.
const translated = new Map<string, string>();
function remember(key: string, value: string) {
  translated.set(key, value);
  if (translated.size > 5000) translated.delete(translated.keys().next().value!);
}

/* ───────────── Demo mode ───────────── */

const DEMO_MS = 3 * 3_600_000;
const DEMO_TAG = '🎬 _Demo_\n\n';
const DEMO_INTRO = `🎬 *TRACE demo mode*

A fresh sample world: the accounts, reports, names and bank contacts are made up, and nothing here touches real data.

Try:
• *0123456789 GTBank* — high risk
• *1234567890 Kuda* — medium risk
• *2222333344 Access Bank* — low risk
• A screenshot of an account number
• *I was scammed* — the first-hour rescue
• *STATUS* after sending *REF 12345* — skips ahead to the CBN escalation
• A voice note, in any language
• *LANGUAGE* to switch language

Send *DEMO* again to reset, *DEMO OFF* to leave. It ends by itself after 3 hours.`;

function demoOn(phone: string): boolean {
  const row = db().prepare('SELECT demo_until FROM wa_prefs WHERE phone = ?').get(phone) as { demo_until: string | null } | undefined;
  return !!row?.demo_until && Date.parse(row.demo_until) > Date.now();
}

function setDemo(phone: string, on: boolean) {
  db().prepare("INSERT INTO wa_prefs (phone, lang, demo_until) VALUES (?, 'English', ?) ON CONFLICT(phone) DO UPDATE SET demo_until = excluded.demo_until")
    .run(phone, on ? new Date(Date.now() + DEMO_MS).toISOString() : null);
}

/** A made-up but stable account name for a sample account, shown only in demo mode. */
function demoName(number: string): string {
  const first = ['CHINEDU', 'AMAKA', 'TUNDE', 'FATIMA', 'EMEKA', 'BLESSING', 'IBRAHIM', 'NGOZI', 'SEGUN', 'HALIMA'];
  const last = ['OKAFOR', 'ADEYEMI', 'BELLO', 'EZE', 'OGUNDIPE', 'MUSA', 'NWOSU', 'ABUBAKAR', 'ADEBAYO', 'OKORO'];
  const h = [...number].reduce((a, d) => a * 31 + Number(d), 7);
  return `${first[h % 10]} ${last[Math.floor(h / 10) % 10]}`;
}

/* ───────────── Conversation ───────────── */

type Media = { url: string; type: string } | null;

async function check(number: string, bank: Bank, phone: string): Promise<[string, State]> {
  const intel = checkAccount(bank, number, 'whatsapp');
  // Sample reports are synthetic, but the number may belong to a real person: never pair them with a real name.
  const v: Verification = !intel.sampleData ? await resolveAccount(number, bank, phone)
    : inDemo() ? { status: 'verified', accountName: demoName(number) }
    : { status: 'unavailable', reason: 'sample' };
  return [formatCheck(intel, v, bank), v.status === 'not_found' && intel.reports === 0 ? { step: 'check_number' } : { step: 'after_check', number, bank }];
}

async function confirmReport(number: string, bank: Bank, story: string, hasMedia: boolean, phone: string): Promise<[string, State]> {
  if (!peekAccount(bank, number).sampleData && (await resolveAccount(number, bank, phone)).status === 'not_found') {
    return [`⛔ ${number} doesn't match an account at ${bank}. Please check the number and send it again.`, { step: 'report_number' }];
  }
  const c = await classifyReport(story);
  return [[
    'We understood this as:',
    `*${CATEGORIES[c.category]}*`,
    `_${c.summary}_`,
    '',
    `Account: ${number} · ${bank}`,
    `Language: ${c.language}`,
    ...(c.needsClarification && c.clarifyingQuestion ? ['', `❓ ${c.clarifyingQuestion}`, 'Send more detail, or reply YES to submit anyway.'] : []),
    '',
    'Reply *YES* to submit, *EDIT* to rewrite, or send a screenshot as evidence first.',
  ].join('\n'), { step: 'report_confirm', number, bank, story, c, hasMedia }];
}

/* ───────────── Escalation: after the money has gone ───────────── */

const ASK_WHEN = `Sorry this happened. Let's move fast — money can sometimes still be stopped.

*When did you send it?*
*1* Less than an hour ago
*2* Today
*3* Earlier`;

/** Step 1 is always the phone call: it is the only thing that can still freeze the money. */
function callStep(caseId: string, f: Facts): string {
  const u = urgency(f.sentAt);
  const desk = helpFor(f.victimBank);
  const lines = [
    `⏱️ *${u.headline}*`,
    u.detail,
    '',
    desk?.phone
      ? `📞 *Call ${f.victimBank}: ${desk.phone}*\n_${desk.source === 'demo' ? "Demo number. Real ones are verified from the bank's own website" : `Checked ${formatDate(desk.verifiedOn)}`}_`
      : `📞 *Call ${f.victimBank ?? 'your bank'} now.*\n${CARD_ADVICE}`,
    '',
    '*Say exactly this:*',
    '',
    keep(callScript(f).map((l) => `_${l}_`).join('\n')),
    '',
    `⚠️ ${REFERENCE_NUDGE}`,
    '',
    'Reply *DONE* when you have called.',
  ];
  return lines.join('\n');
}

/** Step 2: the same complaint in writing, so the bank cannot later say it was never told. */
function writtenStep(caseId: string, f: Facts): string {
  const desk = helpFor(f.victimBank);
  const body = writtenComplaint(f, caseId);
  const lines = [
    '✍️ *Now put it in writing.*',
    'This is your proof that you told them, and when.',
    '',
    'Copy everything between the lines and send it to your bank:',
    keep(`────────────────\n${body}\n────────────────`),
    '',
  ];
  if (desk?.email) lines.push(`📧 Email: ${desk.email}`);
  if (desk?.whatsapp) lines.push(`💬 WhatsApp: ${desk.whatsapp}`);
  if (!desk?.email && !desk?.whatsapp) lines.push('Send it to your bank on WhatsApp, by email, or hand it in at your branch.', 'Get the address from your banking app — not from a web search.');
  lines.push(
    '',
    `Your TRACE case is *${caseId}*.`,
    '',
    'When your bank gives you a complaint reference, send it here like this:',
    '*REF 12345*',
    '',
    'Now — can you tell us what happened? It warns the next person.',
  );
  return lines.join('\n');
}

function statusStep(phone: string): string {
  const found = latestCase(phone);
  const c = found && demoFastForward(found);
  if (!c) return 'You have no open case. Reply *2* if you have sent money and something is wrong.';
  const s = nextStep(c);
  const lines = [`*Case ${c.id}*`, `${c.account_number}${c.bank ? ` · ${c.bank}` : ''}`, '', `*${s.title}*`, ...s.body];
  if (s.step === 'escalate') {
    const cbn = institution('cbn');
    lines.push(
      '',
      'Copy this and send it to CBN Consumer Protection:',
      keep(`────────────────\n${cbnEscalation(c)}\n────────────────`),
      '',
      cbn.verified && cbn.email ? `📧 ${cbn.email}` : 'Get their contact from cbn.gov.ng — the official site only.',
    );
  }
  lines.push('', 'Reply *MENU* to start again.');
  return lines.join('\n');
}

const NEVER_BLOCK = ['', '🚫 *Remember:*', ...NEVER.map((x) => `• ${x}`)].join('\n');

function twilioAuth(): Record<string, string> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  return sid && token ? { authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}` } : {};
}

/** Media a person sent, or null. The download is a redirect to Twilio's CDN, ~2.5 s measured from Lagos. */
async function download(media: NonNullable<Media>, timeoutMs: number): Promise<Buffer | null> {
  // Only fetch from Twilio's media hosts, so a forged request can't make the server fetch arbitrary URLs.
  let host = '';
  try { host = new URL(media.url).hostname; } catch { /* invalid URL */ }
  if (!/(^|\.)twilio\.com$|(^|\.)twiliocdn\.com$/.test(host)) return null;
  try {
    const res = await fetch(media.url, { headers: twilioAuth(), signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

async function readImage(media: Media, phone: string): Promise<Found[] | string> {
  if (!media || !IMAGE_TYPES.test(media.type)) return 'Please send a photo or screenshot (JPG or PNG), or a voice note.';
  if (!rateLimit('extract', phone, 30)) return 'Too many screenshots this hour. Please type the account number.';
  // Twilio waits 15 s for a reply, so the download and image reading share 13 s of it.
  const deadline = Date.now() + 13_000;
  try {
    const image = await download(media, 8000);
    if (!image) return "I couldn't open that image. Please type the account number.";
    const found = await extractAccounts(image, media.type, Math.max(2000, deadline - Date.now()));
    if (!found) return "I couldn't read that image in time. Please type the account number.";
    if (!found.length) return "I couldn't find an account number in that image. Please type it.";
    return found;
  } catch {
    return "I couldn't open that image. Please type the account number.";
  }
}

async function converse(text: string, media: Media, phone: string): Promise<[string, State]> {
  const state = load(phone);
  const upper = text.trim().toUpperCase();
  const words = text.trim().split(/\s+/).filter(Boolean);

  // Always available.
  if (['MENU', 'CANCEL', 'HI', 'HELLO', 'HEY', 'START', 'STOP'].includes(upper)) return [WELCOME, { step: 'menu' }];
  if (['LANGUAGE', 'LANG', 'EDE', 'ÈDÈ', 'HARSHE', 'ASUSU', 'ASỤSỤ'].includes(upper)) return [LANG_MENU, { step: 'pick_lang' }];
  if (upper === 'HELP') return [HOW, state];
  if (upper === 'STATUS') return [statusStep(phone), state];
  if (['HELP ME', 'HELPME', 'SCAMMED', 'I HAVE BEEN SCAMMED'].includes(upper)) return [ASK_WHEN, { step: 'esc_when' }];

  // A complaint reference can arrive at any point — it is the thing every later step needs.
  if (upper.startsWith('REF ')) {
    const ref = text.trim().slice(4).trim();
    const c = state.step === 'esc_reference' ? getCase(state.caseId) : latestCase(phone);
    if (!c) return ['You have no open case yet. Reply *2* if you have sent money and something is wrong.', state];
    if (ref.length < 3) return ['Send it like this: *REF 12345*', state];
    attachReference(c.id, ref);
    return [[
      `✅ Reference *${ref}* saved to case *${c.id}*.`,
      '',
      'Your complaint is now on record with a date. If your bank goes quiet, reply *STATUS* and TRACE will write your CBN escalation for you.',
      '',
      'Reply *MENU* to start again.',
    ].join('\n'), { step: 'menu' }];
  }

  // Evidence while confirming a report.
  if (media && state.step === 'report_confirm') {
    return ['📎 Screenshot attached as evidence.\n\nReply *YES* to submit.', { ...state, hasMedia: true }];
  }

  // A screenshot anywhere else: read account numbers from it, then confirm.
  if (media) {
    const found = await readImage(media, phone);
    if (typeof found === 'string') return [found, state];
    const purpose = state.step === 'report_number' ? 'report' : state.step === 'esc_number' ? 'escalate' : 'check';
    const [sentAt, pre] = state.step === 'esc_number' ? [state.sentAt, state.pre] : [undefined, undefined];
    const list = found.map((f, i) => `*${i + 1}* ${f.accountNumber}${f.bank ? ` · ${f.bank}` : ''}`).join('\n');
    return [
      found.length === 1
        ? `I found this in your image:\n\n${found[0].accountNumber}${found[0].bank ? ` · ${found[0].bank}` : ''}\n\nIs that right? Reply *YES*, or type the correct number.`
        : `I found these in your image:\n\n${list}\n\nReply with the number of the right one, or type the account number.`,
      { step: 'pick_found', found, purpose, sentAt, pre },
    ];
  }

  // One-line shortcuts.
  if (upper.startsWith('CHECK ') || upper.startsWith('REPORT ')) {
    const isCheck = upper.startsWith('CHECK ');
    const hit = findNumber(words.slice(1).join(' '));
    if (!hit) return [`Send *${isCheck ? 'CHECK' : 'REPORT'}* followed by a 10-digit account number.`, { step: isCheck ? 'check_number' : 'report_number' }];
    const { bank, rest } = leadingBank(hit.rest ? hit.rest.split(' ') : []);
    const story = rest.join(' ');
    if (isCheck) return bank ? check(hit.number, bank, phone) : [askBank(hit.number), { step: 'check_bank', number: hit.number }];
    if (!bank) return [askBank(hit.number), { step: 'report_bank', number: hit.number, story: story || undefined }];
    return story.length >= 10
      ? confirmReport(hit.number, bank, story, false, phone)
      : ['What happened? Type it or send a voice note, in any language.', { step: 'report_story', number: hit.number, bank }];
  }

  switch (state.step) {
    case 'menu': {
      if (upper === '1') return ['Send the account number you want to check.\n\nOr send a screenshot showing it.', { step: 'check_number' }];
      if (upper === '2') return [ASK_WHEN, { step: 'esc_when' }];
      if (upper === '3') return [HOW, state];
      const hit = findNumber(text);
      if (hit) {
        const { bank } = leadingBank(hit.rest ? hit.rest.split(' ') : []);
        return bank ? check(hit.number, bank, phone) : [askBank(hit.number), { step: 'check_bank', number: hit.number }];
      }
      if (soundsScammed(text)) return [ASK_WHEN, { step: 'esc_when', pre: { amount: amountIn(text) } }];
      return [WELCOME, { step: 'menu' }];
    }

    case 'check_number':
    case 'report_number': {
      const hit = findNumber(text);
      if (!hit) return ['That doesn\'t look like a 10-digit account number. Please try again, or send *MENU*.', state];
      // "9137751577 opay": the bank came with the number, so don't ask for it.
      const bank = hit.rest ? parseBank(hit.rest) : null;
      if (bank) return state.step === 'check_number'
        ? check(hit.number, bank, phone)
        : ['What happened? Type it or send a voice note, in any language.', { step: 'report_story', number: hit.number, bank }];
      return [askBank(hit.number), state.step === 'check_number' ? { step: 'check_bank', number: hit.number } : { step: 'report_bank', number: hit.number }];
    }

    case 'check_bank':
    case 'report_bank': {
      const bank = parseBank(text);
      if (!bank) return [`I didn't recognise that bank. Reply with a number:\n\n${BANK_MENU}\n\nOr type the full bank name.`, state];
      if (state.step === 'check_bank') return check(state.number, bank, phone);
      if (state.story && state.story.length >= 10) return confirmReport(state.number, bank, state.story, false, phone);
      return ['What happened? Type it or send a voice note, in any language.', { step: 'report_story', number: state.number, bank }];
    }

    case 'after_check': {
      if (upper === '2') return ['What happened with this account? Type it or send a voice note, in any language.', { step: 'report_story', number: state.number, bank: state.bank }];
      const hit = findNumber(text);
      if (hit) return [askBank(hit.number), { step: 'check_bank', number: hit.number }];
      if (soundsScammed(text)) return [ASK_WHEN, { step: 'esc_when', pre: { amount: amountIn(text) } }];
      return [WELCOME, { step: 'menu' }];
    }

    case 'pick_lang': {
      const k = Number(upper);
      if (!Number.isInteger(k) || k < 1 || k > LANGUAGES.length + 1) return [LANG_MENU, state];
      setLang(phone, LANGUAGES[k - 1] ?? 'English', k <= LANGUAGES.length);
      return [k <= LANGUAGES.length ? WELCOME : `✅ OK — I'll reply in the language you write in.\n\n${WELCOME}`, { step: 'menu' }];
    }

    case 'pick_found': {
      const pick = /^\d$/.test(upper) ? state.found[Number(upper) - 1] : upper === 'YES' && state.found.length === 1 ? state.found[0] : null;
      const typed = pick ? null : findNumber(text);
      const chosen: Found | null = pick ?? (typed ? { accountNumber: typed.number, bank: null } : null);
      if (!chosen) return ['Reply *YES*, the number of the right account, or type the account number.', state];
      if (state.purpose === 'escalate') {
        const sentAt = state.sentAt ?? new Date().toISOString();
        // A receipt's own amount and sending bank beat what was said earlier.
        const pre = { amount: chosen.amount ?? state.pre?.amount, victimBank: chosen.fromBank ?? state.pre?.victimBank };
        return chosen.bank
          ? escNext(facts(sentAt, chosen.accountNumber, chosen.bank, pre), phone, true)
          : [askBank(chosen.accountNumber), { step: 'esc_bank', sentAt, number: chosen.accountNumber, pre }];
      }
      if (!chosen.bank) {
        return [askBank(chosen.accountNumber), state.purpose === 'check' ? { step: 'check_bank', number: chosen.accountNumber } : { step: 'report_bank', number: chosen.accountNumber }];
      }
      return state.purpose === 'check'
        ? check(chosen.accountNumber, chosen.bank, phone)
        : ['What happened? Type it or send a voice note, in any language.', { step: 'report_story', number: chosen.accountNumber, bank: chosen.bank }];
    }

    case 'report_story': {
      if (text.trim().length < 10) return ['Please tell us a little more about what happened.', state];
      return confirmReport(state.number, state.bank, text.trim(), false, phone);
    }

    /* ── Escalation ── */

    case 'esc_when': {
      const now = Date.now();
      if (upper === '1') return ['What account number did you send the money to?\n\nOr send a screenshot of the transfer.', { step: 'esc_number', sentAt: new Date(now - 30 * 60_000).toISOString(), pre: state.pre }];
      if (upper === '2') return ['What account number did you send the money to?\n\nOr send a screenshot of the transfer.', { step: 'esc_number', sentAt: new Date(now - 6 * 3_600_000).toISOString(), pre: state.pre }];
      if (upper === '3') return ['What date did you send it? For example *15/09/2026*.', { step: 'esc_date', pre: state.pre }];
      return [ASK_WHEN, state];
    }

    case 'esc_date': {
      const m = text.trim().match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
      if (!m) return ['Please send the date like this: *15/09/2026*.', state];
      const year = Number(m[3].length === 2 ? `20${m[3]}` : m[3]);
      const d = new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[1]), 12));
      if (Number.isNaN(d.getTime()) || d.getTime() > Date.now()) return ['That date does not look right. Please send it like *15/09/2026*.', state];
      return ['What account number did you send the money to?\n\nOr send a screenshot of the transfer.', { step: 'esc_number', sentAt: d.toISOString(), pre: state.pre }];
    }

    case 'esc_number': {
      const hit = findNumber(text);
      if (!hit) return ["That doesn't look like a 10-digit account number. Please try again.", state];
      const { bank } = leadingBank(hit.rest ? hit.rest.split(' ') : []);
      if (bank) return escNext(facts(state.sentAt, hit.number, bank, state.pre), phone, true);
      return [askBank(hit.number), { step: 'esc_bank', sentAt: state.sentAt, number: hit.number, pre: state.pre }];
    }

    case 'esc_bank': {
      const bank = parseBank(text);
      if (!bank) return [`I didn't recognise that bank. Reply with a number:\n\n${BANK_MENU}\n\nOr type the full bank name.`, state];
      return escNext(facts(state.sentAt, state.number, bank, state.pre), phone, true);
    }

    case 'esc_amount': {
      const amount = upper === 'SKIP' ? null : amountIn(`₦${text}`) ?? (Number(text.replace(/[^\d]/g, '')) || null);
      return escNext({ ...state.f, amount }, phone, false);
    }

    case 'esc_my_bank': {
      const victimBank = parseBank(text);
      if (!victimBank) return [`I didn't recognise that bank. Reply with a number:\n\n${BANK_MENU}\n\nOr type the full bank name.`, state];
      const f = { ...state.f, victimBank };
      const c = openCase({ ...f, reporter: phone });
      return [callStep(c.id, f), { step: 'esc_call', caseId: c.id, f }];
    }

    case 'esc_call': {
      if (upper !== 'DONE' && upper !== 'YES' && upper !== 'OK') {
        return ['When you have called your bank, reply *DONE*.\n\nIf you cannot get through, reply *DONE* anyway and we will put the complaint in writing.', state];
      }
      markFiled(state.caseId);
      return [writtenStep(state.caseId, state.f), { step: 'esc_story', caseId: state.caseId, f: state.f }];
    }

    case 'esc_written':
    case 'esc_story': {
      if (text.trim().length < 10) return ['Tell us in a sentence or two what happened, in any language. It warns the next person.', state];
      const c = await classifyReport(text.trim());
      const r = submitReport({
        accountNumber: state.f.accountNumber, bank: state.f.bank, classification: c,
        reporter: phone, channel: 'whatsapp', hasMedia: false,
      });
      db().prepare('UPDATE cases SET report_id = ? WHERE id = ?').run(r.id, state.caseId);
      return [[
        `✅ *Report ${r.id}* added — thank you.`,
        `Case *${state.caseId}* is open.`,
        '',
        'Others checking this account will now see your report. Your number is never shown.',
        NEVER_BLOCK,
        '',
        'Send *REF* and your complaint number when your bank gives it to you.',
        'Reply *STATUS* any time to see your case.',
      ].join('\n'), { step: 'menu' }];
    }

    case 'esc_reference': {
      return ['Send it like this: *REF 12345*', state];
    }

    case 'report_confirm': {
      if (upper === 'EDIT') return ['OK — tell us again what happened.', { step: 'report_story', number: state.number, bank: state.bank }];
      if (upper !== 'YES') return confirmReport(state.number, state.bank, `${state.story} ${text.trim()}`.slice(0, 4000), state.hasMedia, phone);
      const r = submitReport({ accountNumber: state.number, bank: state.bank, classification: state.c, reporter: phone, channel: 'whatsapp', hasMedia: state.hasMedia });
      const status = {
        added: '✅ Added to TRACE intelligence',
        duplicate: 'ℹ️ Not counted: you already reported this account recently',
        limited: '⏸️ Not counted: daily report limit reached',
        needs_detail: '✏️ Not counted yet: needs more detail',
        removed: 'Removed',
      }[r.status];
      return [[
        `*Report ${r.id}*`,
        status,
        ...(r.status === 'needs_detail' && r.statusReason ? [r.statusReason] : []),
        '',
        '🔒 Your number is never shown.',
        'Thank you for helping keep others safe.',
        '',
        'Send *MENU* to start again.',
      ].join('\n'), { step: 'menu' }];
    }
  }
}

/* ───────────── Twilio ───────────── */

const xml = (s: string) => s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** https://www.twilio.com/docs/usage/security#validating-requests */
function validTwilio(req: Request, params: URLSearchParams): boolean {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return process.env.NODE_ENV !== 'production'; // never accept unsigned requests in production
  const sig = req.headers.get('x-twilio-signature') ?? '';
  const u = new URL(req.url);
  const url = `${req.headers.get('x-forwarded-proto') ?? u.protocol.replace(':', '')}://${req.headers.get('x-forwarded-host') ?? req.headers.get('host')}${u.pathname}${u.search}`;
  const payload = url + [...params.keys()].sort().map((k) => k + params.get(k)).join('');
  const expected = createHmac('sha1', token).update(payload).digest('base64');
  return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

/**
 * Twilio's WhatsApp typing indicator. Fire-and-forget: the reply must never wait on
 * it, and a failure here is cosmetic. Worth having because a check with a live
 * Paystack lookup plus a Gemini classification is a second or two of silence.
 */
function typing(messageSid: string): void {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token || process.env.TWILIO_TYPING_INDICATOR !== 'true') return;
  fetch('https://messaging.twilio.com/v3/Indicators/Typing.json', {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ channel: 'WHATSAPP', messageId: messageSid }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => { /* cosmetic only */ });
}

const run = <T>(fn: () => T): T => fn();

/** A reply sent outside the webhook response (Twilio Messages API). */
async function sendWhatsApp(from: string, to: string, body: string): Promise<void> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  if (!sid || !from || !to) return;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: twilioAuth(),
    body: new URLSearchParams({ From: from, To: to, Body: body.slice(0, 1600) }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res?.ok) console.error('whatsapp send failed', res?.status);
}

export async function POST(req: Request) {
  const started = Date.now();
  const params = new URLSearchParams(await req.text());
  if (!validTwilio(req, params)) return new Response('Invalid signature', { status: 403 });

  const sid = params.get('MessageSid');
  if (sid) typing(sid);

  const from = params.get('From') ?? '';
  let reply = 'Sorry, something went wrong. Please send *MENU* to start again.';
  if (from) {
    const phone = reporterKey('phone', from);
    const media = Number(params.get('NumMedia') ?? 0) > 0 && params.get('MediaUrl0')
      ? { url: params.get('MediaUrl0')!, type: params.get('MediaContentType0') ?? '' }
      : null;
    // A voice note is transcribed and then handled exactly like typed text. Download,
    // transcription, name check and classification together can outrun Twilio's 15 s
    // webhook wait, so answer now with nothing and send the reply as its own message.
    if (media && AUDIO_TYPES.test(media.type)) {
      const botNumber = params.get('To') ?? '';
      const demo = demoOn(phone);
      after(() => (demo ? asDemo : run)(async () => {
        let out = "I couldn't hear that voice note. Please type your message instead.";
        try {
          if (!rateLimit('voice', phone, 30)) out = 'Too many voice notes this hour. Please type your message.';
          else {
            const audio = await download(media, 15_000);
            const said = audio && await transcribeAudio(audio, media.type);
            if (said) {
              const [text, next] = await converse(said, null, phone);
              save(phone, next);
              out = `🎤 _"${said.length > 300 ? `${said.slice(0, 300)}…` : said}"_\n\n${await finish(phone, said, text, 8000)}`;
            }
          }
        } catch (e) {
          console.error('whatsapp voice', e);
        }
        await sendWhatsApp(botNumber, from, demo ? DEMO_TAG + out : out);
      }));
      return new Response('<?xml version="1.0" encoding="UTF-8"?><Response/>', { headers: { 'content-type': 'text/xml' } });
    }
    try {
      const body = (params.get('Body') ?? '').slice(0, 1000);
      const command = body.trim().toUpperCase();
      if (command === 'DEMO') {
        // ponytail: one shared demo world; DEMO from any chat resets it for everyone in demo.
        setDemo(phone, true);
        resetDemo();
        reply = DEMO_INTRO;
      } else if (['DEMO OFF', 'END DEMO', 'EXIT DEMO', 'STOP DEMO'].includes(command)) {
        setDemo(phone, false);
        reply = `Demo ended. You're back on live TRACE.\n\n${WELCOME}`;
      } else {
        const demo = demoOn(phone);
        reply = await (demo ? asDemo : run)(async () => {
          const [text, next] = await converse(body, media, phone);
          save(phone, next);
          // Whatever is left of Twilio's 15 s wait (1 s spare), capped so translation never dominates.
          return finish(phone, body, text, Math.min(5000, 14_000 - (Date.now() - started)));
        });
        if (demo) reply = DEMO_TAG + reply;
      }
    } catch (e) {
      console.error('whatsapp', e);
    }
  }
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${xml(reply)}</Message></Response>`, {
    headers: { 'content-type': 'text/xml' },
  });
}
