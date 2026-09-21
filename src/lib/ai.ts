// Gemini does language work only: classify, summarise, translate, describe
// patterns. Every call has a deterministic offline fallback so the demo
// never breaks on a missing key, slow network or malformed JSON.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { secret } from './db';
import { clusters } from './engine';
import { Bank, CATEGORIES, CATEGORY_KEYS, Category, Classification, findBank, normalizeAccount, Tag, TAGS } from './shared';

const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
const TIMEOUT_MS = 8000;

type Part = { text: string } | { inline_data: { mime_type: string; data: string } };

async function gemini(system: string, user: string | Part[], schema: object, timeoutMs = TIMEOUT_MS): Promise<unknown> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Race a hard deadline as well as aborting: the caller must get an answer on time
  // even if the network stack ignores the abort.
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => { ctrl.abort(); resolve(null); }, timeoutMs);
  });
  const call = (async () => {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
        method: 'POST',
        signal: ctrl.signal,
        cache: 'no-store',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: typeof user === 'string' ? [{ text: user }] : user }],
          generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: schema },
        }),
      });
      if (!res.ok) return null;
      const raw = (await res.json())?.candidates?.[0]?.content?.parts?.[0]?.text;
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null; // timeout, network, bad JSON — all end the same way
    }
  })();
  try {
    return await Promise.race([call, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

const str = (x: unknown, max = 400) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, max) : null);
const strs = (x: unknown, max = 6) => (Array.isArray(x) ? x.map((v) => str(v, 160)).filter((v): v is string => !!v).slice(0, max) : []);

/* ───────────────────────── Report classification ───────────────────────── */

const CLASSIFY_PROMPT = `You structure scam reports for TRACE, a Nigerian fraud-intelligence service for bank accounts.

The reporter may write in English, Nigerian Pidgin, Yoruba, Hausa, Igbo or a mix. Read for meaning.

Return:
- category: one of ${CATEGORY_KEYS.join(', ')}.
- severity: low, medium or high. High when money was lost and the recipient became unreachable, or large sums are involved.
- summary: ONE neutral English sentence in the passive voice describing what the reporter says happened, e.g. "Payment was made for an iPhone and the recipient became unresponsive after receiving payment."
- tags: 0 to 3 items chosen ONLY from this list: ${TAGS.join('; ')}.
- keyFacts: 2 to 4 short English facts stated by the reporter (item, amount, platform, what happened after payment).
- accountRelated: true if money was sent to, or requested into, a bank account.
- needsClarification: true only if it is unclear whether any payment or scam occurred.
- clarifyingQuestion: one short, respectful question when needsClarification is true, else null.
- language: the name of the language the report was written in.

RULES: Describe what the reporter says, never state it as proven fact. Never call anyone a scammer, criminal or fraudster. Never include names, phone numbers or other personal data in summary or keyFacts. Return JSON only.`;

const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: CATEGORY_KEYS },
    severity: { type: 'string', enum: ['low', 'medium', 'high'] },
    summary: { type: 'string' },
    tags: { type: 'array', items: { type: 'string', enum: TAGS } },
    keyFacts: { type: 'array', items: { type: 'string' } },
    accountRelated: { type: 'boolean' },
    needsClarification: { type: 'boolean' },
    clarifyingQuestion: { type: 'string', nullable: true },
    language: { type: 'string' },
  },
  required: ['category', 'severity', 'summary', 'tags', 'keyFacts', 'accountRelated', 'needsClarification', 'language'],
};

function validateClassification(x: unknown): Omit<Classification, 'accountNumber' | 'source'> | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const category = CATEGORY_KEYS.includes(o.category as Category) ? (o.category as Category) : null;
  const severity = ['low', 'medium', 'high'].includes(o.severity as string) ? (o.severity as Classification['severity']) : null;
  const summary = str(o.summary);
  if (!category || !severity || !summary || typeof o.accountRelated !== 'boolean' || typeof o.needsClarification !== 'boolean') return null;
  return {
    category, severity, summary,
    tags: validTags(o.tags),
    keyFacts: strs(o.keyFacts),
    accountRelated: o.accountRelated,
    needsClarification: o.needsClarification,
    clarifyingQuestion: o.needsClarification ? str(o.clarifyingQuestion, 200) : null,
    language: str(o.language, 40) ?? 'English',
  };
}

const validTags = (x: unknown): Tag[] =>
  Array.isArray(x) ? [...new Set(x.filter((t): t is Tag => TAGS.includes(t as Tag)))].slice(0, 3) : [];

const RULES: [Category, RegExp][] = [
  ['investment_fraud', /invest|returns|roi\b|crypto|forex|trading|profit|double your/i],
  ['loan_scam', /\bloan|processing fee/i],
  ['job_scam', /\bjob\b|recruit|employment|training fee/i],
  ['romance_scam', /dating|girlfriend|boyfriend|relationship|love\b/i],
  ['impersonation', /customer care|pretend|impersonat|posing as|claimed to be|\bbvn\b/i],
  ['fake_delivery', /dispatch|courier|waybill|logistics|clearance fee|delivery (company|fee|service)/i],
  ['fake_online_store', /online (store|shop|boutique)|website|web ?store/i],
  ['marketplace_fraud', /iphone|phone|laptop|seller|sold|bought|buy|marketplace|jiji|ps5|airpods|goods|item|product|wayar|mo san|na biya|akwụrụ|i pay/i],
];

const UNRESPONSIVE = /blocked? me|stopped (responding|replying)|disappear|unreachable|went silent|cut contact|dí mi|toshe|gbochiri/i;

function detectLanguage(t: string): string {
  if (/[ụịṅ]|akwụrụ|\bego\b/i.test(t)) return 'Igbo';
  if (/[ṣẹọ]|\bowó|mo san/i.test(t)) return 'Yoruba';
  if (/[ɗƙ]|kuɗi|na biya/i.test(t)) return 'Hausa';
  if (/\b(dem|wey|abeg|e don|e collect|i pay)\b/i.test(t)) return 'Nigerian Pidgin';
  return 'English';
}

export function classifyOffline(text: string): Omit<Classification, 'accountNumber' | 'source'> {
  const category = RULES.find(([, re]) => re.test(text))?.[0] ?? 'other';
  const unresponsive = UNRESPONSIVE.test(text);
  const item = (text.match(/iphone(?:\s?\d+(?:\s?pro)?)?/i) ?? text.match(/laptop|ps5|airpods|generator|phone|shoes|sneakers|wayar/i))?.[0];
  const itemLabel = item ? (/iphone/i.test(item) ? item.replace(/iphone/i, 'iPhone') : /wayar/i.test(item) ? 'phone' : item.toLowerCase()) : null;
  const amount = text.match(/(?:₦|N|NGN)\s?([\d,]{3,})/)?.[1];
  const money = /paid|pay|sent|transfer|money|owó|kuɗi|ego|₦|naira/i.test(text);
  const needsClarification = category === 'other' && !money;

  const outcome = unresponsive ? 'the recipient became unresponsive after receiving payment' : 'the goods or service were not provided';
  const summary = {
    marketplace_fraud: `Payment was made for ${itemLabel ? `an ${itemLabel}`.replace(/^an ([^aeiouAEIOU])/, 'a $1') : 'an item'} and ${outcome}.`,
    fake_online_store: `An order was paid for through an online store and ${outcome}.`,
    investment_fraud: 'Money was sent for an investment and the promised returns or withdrawals were not provided.',
    fake_delivery: 'A delivery-related fee was requested and paid, and no genuine delivery took place.',
    impersonation: 'The reporter was asked to transfer money by someone claiming to represent a trusted party.',
    loan_scam: 'An upfront fee was requested before a loan would be released, and the loan was not provided.',
    job_scam: 'A fee was requested as a condition of a job offer.',
    romance_scam: 'Money was requested within an online relationship and contact was later cut.',
    other: money ? 'A payment was made and the reporter describes a problem afterwards.' : 'The reporter describes a possible issue with an account.',
  }[category];

  return {
    category,
    severity: needsClarification ? 'low' : unresponsive || (amount && Number(amount.replace(/,/g, '')) >= 100_000) ? 'high' : 'medium',
    summary,
    tags: ([
      unresponsive && 'Account became unresponsive',
      /blocked? me|dí mi|toshe|gbochiri/i.test(text) && 'Blocked after payment',
      ['marketplace_fraud', 'fake_online_store', 'other'].includes(category) && money && 'Payment not fulfilled',
      /fee|charge/i.test(text) && 'Requested extra fees',
      /withdraw/i.test(text) && 'Withdrawals blocked',
      /fake (receipt|alert|payment|screenshot)/i.test(text) && 'Fake payment proof',
    ].filter(Boolean) as Tag[]).slice(0, 3),
    keyFacts: [
      money && 'Money was sent to the recipient',
      itemLabel && `Item: ${itemLabel}`,
      amount && `Amount: ₦${amount}`,
      unresponsive && 'Recipient became unresponsive after payment',
    ].filter((f): f is string => !!f),
    accountRelated: money,
    needsClarification,
    clarifyingQuestion: needsClarification ? 'Did you send money to this account? If so, what was the payment for?' : null,
    language: detectLanguage(text),
  };
}

export async function classifyReport(text: string): Promise<Classification> {
  const input = text.slice(0, 4000);
  // Extracted by application code, not the model: the account number is a fact, not an interpretation.
  const accountNumber = input.match(/\b\d{10}\b/)?.[0] ?? null;
  const ai = validateClassification(await gemini(CLASSIFY_PROMPT, input, CLASSIFY_SCHEMA));
  return ai
    ? { ...ai, accountRelated: ai.accountRelated || !!accountNumber, accountNumber, source: 'gemini' }
    : { ...classifyOffline(input), accountNumber, source: 'offline' };
}

/* ───────────────────────── Pattern detection ───────────────────────── */

const PATTERN_PROMPT = `You are an analyst for TRACE, a fraud-intelligence service. You receive clusters of anonymised community scam reports.

For each cluster, describe the recurring pattern in the reports:
- id: echo the cluster id.
- name: short pattern name, e.g. "Electronics non-delivery via social media sellers".
- theme: a lowercase phrase completing "N reports appear related to ...", e.g. "marketplace transactions involving electronics and non-delivery after payment". No numbers.
- characteristics: 3 or 4 short common characteristics.
- suggestedAction: one sentence recommending a verification or review step for the TRACE review team.

RULES: Identify patterns only. Never declare anyone guilty, never call anyone a scammer. Return JSON only.`;

const PATTERN_SCHEMA = {
  type: 'object',
  properties: {
    patterns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' }, name: { type: 'string' }, theme: { type: 'string' },
          characteristics: { type: 'array', items: { type: 'string' } }, suggestedAction: { type: 'string' },
        },
        required: ['id', 'name', 'theme', 'characteristics', 'suggestedAction'],
      },
    },
  },
  required: ['patterns'],
};

const OFFLINE_PATTERN: Record<Category, { name: string; theme: string; action: string }> = {
  marketplace_fraud: { name: 'Electronics non-delivery via social sellers', theme: 'marketplace transactions involving electronics and non-delivery after payment', action: 'Prioritise review of accounts with repeat electronics reports and request order screenshots from reporters.' },
  investment_fraud: { name: 'Guaranteed-returns investment schemes', theme: 'investment offers promising high returns followed by blocked withdrawals', action: 'Cross-check reported accounts against known investment-scheme clusters before escalating to partner banks.' },
  fake_delivery: { name: 'Advance delivery or clearance fees', theme: 'delivery or clearance fees requested for parcels that never arrive', action: 'Review whether the same account appears across multiple unsolicited delivery-fee reports.' },
  fake_online_store: { name: 'Short-lived online storefronts', theme: 'online stores that accept transfers and then go offline', action: 'Verify whether store pages linked to these accounts are still active.' },
  impersonation: { name: 'Trusted-party impersonation', theme: 'requests to move money by people claiming to represent banks or relatives', action: 'Flag for partner-bank review, as these reports often involve multiple receiving accounts.' },
  loan_scam: { name: 'Upfront loan fees', theme: 'loan offers requiring fees before disbursement', action: 'Check reported accounts against licensed lender lists.' },
  job_scam: { name: 'Pay-to-work job offers', theme: 'job offers that require training or kit fees', action: 'Review job-offer reports for shared wording and receiving accounts.' },
  romance_scam: { name: 'Relationship-based money requests', theme: 'online relationships followed by urgent money requests', action: 'Review with care; reporters may need support resources.' },
  other: { name: 'Unfulfilled payments', theme: 'payments for services that were not provided', action: 'Request more detail from reporters before drawing conclusions.' },
};

export async function detectPatterns() {
  const cs = clusters(3);
  const ai = await gemini(
    PATTERN_PROMPT,
    JSON.stringify(cs.map((c) => ({ id: c.category, label: c.label, commonTags: c.topTags, sampleReports: c.samples }))),
    PATTERN_SCHEMA,
  );
  const byId = new Map(
    (Array.isArray((ai as { patterns?: unknown })?.patterns) ? (ai as { patterns: Record<string, unknown>[] }).patterns : [])
      .map((p) => [p.id, p] as const),
  );

  let source: 'gemini' | 'offline' = byId.size ? 'gemini' : 'offline';
  const patterns = cs.map((c) => {
    const p = byId.get(c.category);
    const name = str(p?.name, 80), theme = str(p?.theme, 160), action = str(p?.suggestedAction, 240);
    const off = OFFLINE_PATTERN[c.category];
    if (!name || !theme || !action) source = 'offline';
    return {
      category: c.category,
      label: CATEGORIES[c.category],
      relatedReports: c.count, // counted by the engine, never by the model
      name: name ?? off.name,
      summary: `${c.count} reports appear related to ${(theme ?? off.theme).replace(/\.$/, '')}.`,
      characteristics: p && strs(p.characteristics, 4).length ? strs(p.characteristics, 4) : c.topTags,
      suggestedAction: action ?? off.action,
    };
  });
  return { source, patterns };
}

/**
 * The classify endpoint signs what it returned, so a report submission can
 * prove its classification came from TRACE without a second AI call.
 */
export function signClassification(text: string, c: Classification): string {
  return createHmac('sha256', secret()).update(JSON.stringify([text, c])).digest('hex');
}

export function verifyClassification(text: string, c: Classification, token: string): boolean {
  const expected = Buffer.from(signClassification(text, c));
  const got = Buffer.from(String(token));
  return expected.length === got.length && timingSafeEqual(expected, got);
}

/* ───────────────────────── Screenshot reading ───────────────────────── */

const EXTRACT_PROMPT = `You read screenshots and photos that Nigerians receive when asked to pay someone: chat messages, social media posts, invoices, bank app screens.

Find every Nigerian bank account number shown as a place to send money. Account numbers have 10 digits, often written with spaces or dashes (e.g. "0123 456 789"). For each, give the digits and the bank name written near it, or null if no bank is shown.

If the image is a transfer receipt or debit alert, also give, for that account, the amount sent in naira (a plain number) and the bank or app it was sent FROM (the sender's bank, not the recipient's). Otherwise leave both null.

Never return phone numbers (11 digits starting with 0, or starting with +234), amounts, dates or reference codes as account numbers. Copy digits exactly and never invent a missing digit. Return JSON only.`;

const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    accounts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          accountNumber: { type: 'string' },
          bankName: { type: 'string', nullable: true },
          amountSent: { type: 'number', nullable: true },
          senderBank: { type: 'string', nullable: true },
        },
        required: ['accountNumber'],
      },
    },
  },
  required: ['accounts'],
};

/* ───────────────────────── Replying in the user's language ───────────────────────── */

export const LANGUAGES = ['English', 'Nigerian Pidgin', 'Yoruba', 'Hausa', 'Igbo'] as const;
export type Language = (typeof LANGUAGES)[number];

const LOCALIZE_PROMPT = `You are the voice of TRACE, a Nigerian WhatsApp service that helps people check a bank account before paying, and get help after a scam.

You receive the user's latest message (may be empty), the chat's current language, and the bot's reply split into text segments.

Return:
- language: the language the user's message is written in, one of: ${LANGUAGES.join(', ')}. English mixed with Pidgin counts as Nigerian Pidgin. If the message is empty, too short or unclear, return the current language.
- segments: every reply segment translated into that language, same count, same order. If the language is English, return the segments unchanged.

When translating: keep WhatsApp formatting exactly (*bold*, _italic_, line breaks, emoji, bullets, numbering, leading and trailing spaces). Never change digits, account numbers, amounts, dates, case IDs, bank names or people's names. Keep the words a user must type in English and in bold: YES, EDIT, MENU, SKIP, DONE, REF, STATUS, HELP ME, CHECK, REPORT, LANGUAGE. Keep the meaning exact; never soften a warning. Use plain, warm, everyday language a stressed person understands. Return JSON only.`;

/**
 * Detects the user's language and translates the bot's reply into it, in one call.
 * Language work only: the reply's facts were decided by code before this runs.
 * Returns null on any failure, and the caller sends the English reply.
 */
export async function localize(userText: string, current: Language, segments: string[], timeoutMs: number): Promise<{ language: Language; segments: string[] } | null> {
  const ai = await gemini(LOCALIZE_PROMPT, JSON.stringify({ userMessage: userText.slice(0, 1000), currentLanguage: current, segments }), {
    type: 'object',
    properties: {
      language: { type: 'string', enum: [...LANGUAGES] },
      segments: { type: 'array', items: { type: 'string' } },
    },
    required: ['language', 'segments'],
  }, timeoutMs) as { language?: unknown; segments?: unknown } | null;
  const language = LANGUAGES.find((l) => l === ai?.language);
  const out = ai?.segments;
  if (!language || !Array.isArray(out) || out.length !== segments.length || out.some((s) => typeof s !== 'string')) return null;
  return { language, segments: out as string[] };
}

export const IMAGE_TYPES =/^image\/(png|jpeg|webp|heic|heif)$/;
// WhatsApp voice notes arrive as audio/ogg (Opus). AMR isn't something Gemini reads.
export const AUDIO_TYPES = /^audio\/(ogg|opus|mpeg|mp3|mp4|aac|wav|x-wav|flac|webm)\b/;

const TRANSCRIBE_PROMPT = `Transcribe this voice note word for word, in the language it was spoken: English, Nigerian Pidgin, Yoruba, Hausa, Igbo or a mix. Do not translate, summarise, correct or add anything. Return JSON only.`;

/**
 * The words spoken in a voice note, or null when transcribing isn't possible.
 * Audio is processed in memory and never stored; the transcript is treated exactly
 * like a typed message, so classification (and language detection) happen as usual.
 */
export async function transcribeAudio(audio: Buffer, mime: string, timeoutMs = 20_000): Promise<string | null> {
  const type = mime.split(';')[0].trim().toLowerCase();
  if (!AUDIO_TYPES.test(type) || audio.length > 5 * 1024 * 1024) return null;
  const ai = await gemini(TRANSCRIBE_PROMPT, [
    { inline_data: { mime_type: type, data: audio.toString('base64') } },
    { text: 'Transcribe this voice note.' },
  ], { type: 'object', properties: { transcript: { type: 'string' } }, required: ['transcript'] }, timeoutMs) as { transcript?: unknown } | null;
  return str(ai?.transcript, 4000);
}

/**
 * Account numbers found in an image. The user must confirm before anything is
 * checked or reported: a single misread digit would point at someone else's account.
 * Returns null when reading isn't possible (no Gemini key, timeout, unreadable).
 */
export async function extractAccounts(image: Buffer, mime: string, timeoutMs = 15_000): Promise<{ accountNumber: string; bank: Bank | null; amount: number | null; fromBank: Bank | null }[] | null> {
  if (!IMAGE_TYPES.test(mime) || image.length > 8 * 1024 * 1024) return null;
  const ai = await gemini(EXTRACT_PROMPT, [
    { inline_data: { mime_type: mime, data: image.toString('base64') } },
    { text: 'List the account numbers in this image.' },
  ], EXTRACT_SCHEMA, timeoutMs) as { accounts?: { accountNumber?: unknown; bankName?: unknown; amountSent?: unknown; senderBank?: unknown }[] } | null;
  if (!ai || !Array.isArray(ai.accounts)) return null;
  const seen = new Set<string>();
  return ai.accounts.flatMap((a) => {
    const accountNumber = normalizeAccount(typeof a.accountNumber === 'string' ? a.accountNumber : '');
    if (!accountNumber || seen.has(accountNumber)) return [];
    seen.add(accountNumber);
    const amount = typeof a.amountSent === 'number' && a.amountSent >= 1 ? Math.round(a.amountSent) : null;
    return [{ accountNumber, bank: findBank(a.bankName), amount, fromBank: findBank(a.senderBank) }];
  }).slice(0, 5);
}
