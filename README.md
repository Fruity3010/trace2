# TRACE — Check before you trust

> **Every scam leaves a trace. Its victims are that trace.**

Before you pay, your bank shows you a name. It won't tell you that three people sent
money to that same name last week and never heard back. That history already exists, but
it lives with the victims, scattered across WhatsApp groups, X threads and complaints
stuck inside banks, where nobody can look it up before paying.

**TRACE puts that history in one place.** Check a Nigerian account before you send money
and see the name *and* its record: how many people have reported it, what happened to
them, and a clear, explainable risk signal. If the money has already gone, TRACE walks
you through the first hour: who to call, what to say, and how to escalate when your bank
goes quiet. Every report becomes the warning the next person sees.

**Live demo:** https://trace2-lake.vercel.app — try GTBank `0123456789` (sample account, HIGH risk)

Built for the *Information you can trust* capstone — **Safety, Reporting & Protection**
track, with a strong **Transparency & Accountability** cross-over (see [bank response
tracking](#after-the-money-has-gone--the-first-hour)).

---

## The problem

In Nigeria, paying a stranger means a bank transfer to a 10-digit account number you
have never seen before: a marketplace seller, a "delivery agent", a landlord, an
investment "manager". Transfers are instant and practically irreversible.

The information that would protect you already exists, but it is scattered and hidden:

- **Your bank shows a name, not a history.** Name enquiry confirms who owns the account.
  A scammer's account has a real name too, so a matching name proves nothing.
- **Victims know.** Everyone who lost money to an account knows it's bad. They warn
  each other in WhatsApp groups, on X and Nairaland, but there is no place to look an
  account up *before* paying, so the next person pays anyway.
- **Banks know, but don't share.** Complaints about a beneficiary account stay inside
  each bank. The person about to pay sees nothing.
- **After a loss, nobody tells you what to do.** Money can sometimes be frozen with a
  PND (Post No Debit) order, but only if the victim's *own* bank acts within hours.
  Most people don't know this, lose time filling web forms, or call a fake "helpline"
  and get scammed twice.
- **Complaints disappear.** Banks have a fixed time to respond before a complaint can
  go to the CBN, but people rarely know the deadline or how to escalate.

## The solution

One engine, three doors: a **web app** (installable PWA, phone and desktop), a
**WhatsApp bot** (text, screenshots and voice notes, five languages), and a
**partner API** banks and fintechs can call from their own transfer screen.

1. **Check.** Enter an account number, or send a screenshot of the payment details.
   TRACE shows:
   - **Whose name is on the account** (via Paystack name enquiry), so you can compare
     it with who you think you're paying. A number that doesn't exist gets a strong
     "don't send money" warning.
   - **A risk signal** — LOW / MEDIUM / HIGH with a 0–100 score, the number of
     independent reporters, evidence, common patterns and when it was last reported.
     Every part of the score is shown and explained. It never calls anyone a scammer.
2. **Report.** Describe what happened in your own words, in your own language, by
   typing or voice note. AI turns it into a structured report; automated trust rules
   decide whether it counts.
3. **Get help (the first hour).** A guided ladder: call your bank *now* with a ready
   script asking for a PND → the same complaint in writing → record the bank's
   reference → `STATUS` tells you when the bank is out of time and hands you a
   pre-filled CBN escalation letter.
4. **Dispute.** An account holder who believes they were reported unfairly can
   dispute; that is the only thing a human reviews.

Staff see emerging fraud clusters and **how quickly each bank acknowledges fraud
complaints** in `/intel` — making bank behaviour visible, not just scammers.

## How this meets the challenge constraints

| Constraint | How TRACE handles it |
|---|---|
| **Trust & verification** | Account names come from the banking network (Paystack), not from users. Scores are deterministic and explained line by line; a report is never presented as proof. **One reporter alone can never push an account above LOW; two never above MEDIUM.** Every result shows when the account was last reported. Help contacts are shown only with a `source` URL and a `verifiedOn` date — unverified means "use the number on the back of your card". |
| **Low bandwidth / basic devices** | Full service over WhatsApp, which most people already have and many data plans bundle. The web app is a light, installable PWA with a service worker. No images or heavy scripts needed for a check. |
| **Accessibility & literacy** | Voice notes anywhere you can type. Screenshots instead of copying digits. Numbered menus. Risk is always colour + icon + words, never colour alone. Plain, neutral language. |
| **Privacy & security** | Reporters are stored only as a keyed hash (HMAC) of their device or phone number. Names looked up are shown to the person checking and **never stored**, never attached to reports, never returned by the partner API. Evidence files are private and never served. Audio and images sent for reading are processed in memory and discarded. WhatsApp webhooks are signature-verified. |
| **Multilingual** | The WhatsApp bot answers in English, Nigerian Pidgin, Yorùbá, Hausa or Igbo, detected automatically. Reports in any of them are classified into the same categories. Legal text (the call script, complaint, CBN letter) is deliberately kept in English because that's what the bank must receive. |
| **Local relevance** | Built around Nigerian realities: NUBAN account numbers, 279 banks incl. microfinance banks and fintechs (OPay, Moniepoint, PalmPay, Kuda…), PND orders, CBN complaint rules. Banks, contacts and deadlines live in data files (`banks.json`, `help.json`), so another country is a data change, not a rewrite. |
| **Clear next steps** | Every result ends in an action: don't pay / verify the name / report / get help. After a loss, TRACE gives the exact words to say on the phone, the written complaint, and the escalation letter with dates filled in. |

## How AI is used

### Inside the product — AI does language, never judgement

TRACE uses Google Gemini (`gemini-flash-lite-latest` by default) for language tasks
only:

| Task | Where |
|---|---|
| **Classify reports** — free-text story → category, summary, tags from a fixed list, detected language | `classifyReport` in `src/lib/ai.ts` |
| **Read screenshots** — pull the account number and bank from a payment screenshot | `extractAccounts` |
| **Transcribe voice notes** word for word in the language spoken | `transcribeAudio` |
| **Translate bot replies** into Pidgin, Yorùbá, Hausa or Igbo | `localize` |
| **Describe fraud patterns** for staff in `/intel` | `detectPatterns` |

Hard rules, enforced in code:

1. **AI never decides risk.** Scores, thresholds, duplicate detection and whether a
   report is accepted are deterministic code in `src/lib/engine.ts`. The call
   script, complaint and escalation advice in `src/lib/escalate.ts` are fixed text —
   Gemini is never asked what a victim should do.
2. **AI failure never breaks a flow.** Every call has a hard deadline and an offline
   fallback (a deterministic keyword classifier; English if translation fails; "please
   type the number" if a screenshot can't be read). The test suite runs with AI off.
3. **A human confirms what AI read.** A misread digit would point at someone else's
   account, so screenshot results are always confirmed before a check runs.
4. **AI output can't be forged.** Classifications are signed server-side
   (`signClassification`), so a client can't submit a report with a made-up category.

### Building it — AI coding tools

The idea and the product decisions are ours; TRACE was *built* with **Claude Code**
(Anthropic's AI coding agent) working in the terminal as a pair programmer:

- **From idea to working product in days.** An MVP on day one, then — at our request
  — it was turned from a demo into a real product: SQLite storage, automated trust
  rules, real Paystack and Twilio integrations, and an end-to-end test script
  (`npm run check`) that exercises scoring, trust rules, disputes, API auth, WhatsApp
  signature rejection and multilingual classification on a throwaway database.
- **Humans steered, AI executed.** We rejected the AI's first visual design as "too AI
  generic" and supplied our own mockup for the final look; questioned whether reports
  should need human review (they don't — the trust rules do the job); cut the check,
  report and help flows down to the fewest possible steps for people under stress; and
  pushed for WhatsApp voice notes, local languages and the "first hour" recovery flow.
- **Guardrails written down for the AI.** The rules above ("AI never scores", "sample
  data never gets a real name", "nobody is called a scammer") were recorded as
  project rules, so every later change by the coding agent had to respect them.
- **AI-assisted verification.** The agent drove the real app in Chrome at desktop and
  phone widths, ran the checks after each change, and tested WhatsApp end to end
  through a real Twilio sandbox.

---

## Run it locally

Stack: Next.js 16 · TypeScript · Tailwind · Node.js built-in SQLite (`node:sqlite`) · Gemini · Paystack · Twilio.
Requires Node **22.13+**.

```bash
npm install
cp .env.example .env.local   # set ADMIN_PASSWORD at least; every other key is optional
npm run dev                  # http://localhost:3000
npm run build && npm run check   # end-to-end checks on an isolated server and throwaway database
```

Without API keys TRACE still runs: AI falls back to the offline classifier and the
name check is skipped. Data lives in `./data/trace.db`; private evidence uploads in
`./data/evidence/`. On first run the database is seeded with **sample reports**
(marked `sample = 1`) so checks return results. Remove them with
`npm run db:clear-sample`, or start empty with `TRACE_SEED_SAMPLE=false`.

Sample accounts: `0123456789` GTBank (HIGH) · `1234567890` Kuda (MEDIUM) ·
`8123456780` OPay (HIGH) · `2222333344` Access Bank (LOW).

## Technical details

### Account name check (Paystack)
With `PAYSTACK_SECRET_KEY` set, every check first asks Paystack's Resolve Account
Number API who owns the account:
- **Found** → the account name is shown so the person can compare it with who they're paying.
- **Not found** → a strong "don't send money" warning; reports on that number are refused (almost always a typo).
- **Unavailable** (timeout, rate limit) → the check continues without a name.

Names are shown only to the person checking. They are never stored, never
attached to reports, and never returned by the partner API. Lookups are limited
to 20 per device / WhatsApp number per hour. Accounts with **sample** reports skip
the lookup, so synthetic reports are never shown next to a real person's name.

The bank list (`src/lib/banks.json`, 279 banks incl. microfinance banks and
fintechs) is a snapshot of Paystack's `GET /bank?country=nigeria`.

### Screenshots
People can send a screenshot instead of typing (web Check page, or WhatsApp).
Gemini reads the account number and bank; the person always confirms before
anything is checked, because one misread digit would point at someone else.
If the image is a transfer receipt or debit alert, it also reads the amount sent and
the bank it was sent from, so the first-hour flow doesn't ask for them again.
Images used for reading are processed in memory and not stored.

### Voice notes
On WhatsApp, people can send a voice note anywhere they could type: what happened,
an account number, a bank. Gemini transcribes it word for word in the language spoken
(no translation), and the transcript is then handled exactly like typed text; the report's
language is detected during classification and shown on the confirmation. Because download,
transcription, name check and classification can outrun Twilio's 15 s webhook wait, the
webhook answers empty and the reply is sent afterwards through the Twilio Messages API
(needs both Twilio credentials). Audio is processed in memory and not stored.

### Demo mode (WhatsApp, for pitching)
Send **DEMO** to the bot. That chat switches to `data/demo.db`, a throwaway copy seeded
with sample data, for 3 hours (or until **DEMO OFF**). The same code runs (`asDemo()` in
`db.ts` routes every query there), so reports, cases and rate limits all work and are
reset by sending DEMO again. Real data is never touched. What demo adds:
- sample accounts show a made-up account name (live never names them);
- the first-hour flow shows a visibly fake fraud desk (`0700 000 DEMO`, `*.demo` emails);
- `STATUS` moves the case back 15 days, so the CBN escalation can be shown live.
Every demo reply starts with 🎬 _Demo_. Real account numbers still get a real Paystack lookup.

### Languages (WhatsApp)
The bot replies in the language the person writes in: English, Nigerian Pidgin, Yorùbá,
Hausa or Igbo. A message with three or more words can switch the chat's language; short
replies (`1`, `YES`, `gtb`) keep it. `LANGUAGE` picks one by hand, which detection then
leaves alone (option 6 goes back to automatic). Gemini detects and translates in one
call, within what's left of Twilio's 15 s wait; any failure sends English.

Never translated: account names, the risk verdict line, the bank call script, the written
complaint and the CBN letter. Those are marked with `keep()` in the route and are sent as
written. Translations are cached in memory so a line reads the same every time. They
are machine translations and should be reviewed by native speakers.

### After the money has gone — "the first hour"
WhatsApp option **2** (or `HELP ME`), or **Get help** on the web (`/help`). Only the victim's own bank can get a **PND**
(Post No Debit) placed on the beneficiary account, and only quickly, so the flow
leads with a phone call and the exact words to say, then puts the same complaint in
writing, then asks what happened — the report is a byproduct of getting help.

On WhatsApp the flow only asks for what it doesn't already know. An amount in the
opening message ("I was scammed of 100000", "₦45k", "100,000 naira", typed or spoken)
is kept, and so are a receipt's amount and sending bank. A bare number counts as an
amount unless it could be something else: an account or phone number, a date or a year.

`REF <number>` stores the bank's complaint reference; `STATUS` re-checks the case and,
once the bank has run out of time, prints a CBN escalation with the date and reference
already in it. A stored reference also counts as evidence on the linked report: an
institution acknowledged the complaint under the victim's own name.

On the web, `/help` runs the same ladder through `POST /api/cases` and
`POST /api/cases/[id]` (`filed`, `story`, `reference`, `resolved`). The page renders
`caseView()` from `escalate.ts`, so web and WhatsApp can't give different advice.
Cases belong to the device id (like reports); another device gets a 404. The page also
lists the police cybercrime centre and EFCC, showing their contacts only once verified
in `help.json`.

Fraud-desk contacts live in `src/lib/help.json` and are shown **only** with a `source`
and a `verifiedOn` date. Unverified is treated as missing, and TRACE says to use the
number on the back of the card — a fake helpline is a common second scam.

### How reports are trusted (no human queue)
Every report is processed automatically and immediately:
1. **Classified** — Gemini (or offline fallback) picks a category, summary and tags from a fixed list.
2. **Automated checks** — rate limit (5 per reporter per day), duplicate (same reporter + account within 30 days), and needs-detail (no scam or payment identified).
3. **Added to intelligence** — counts toward the account's score straight away.

The score itself enforces corroboration: **one reporter alone can never raise an
account above LOW, two never above MEDIUM.** The only human review is an
account holder's **dispute**, handled by staff in `/intel`.

### Score (0–100, deterministic — AI never sets it)
Volume ≤30 (max 2 counted per reporter) · unique reporters ≤20 · evidence ≤15 ·
pattern corroboration ≤15 · recency ≤10 · consistency ≤10.
0–29 LOW · 30–69 MEDIUM · 70–100 HIGH. A report is not proof of wrongdoing.

### Channels
| | Endpoint | Auth |
|---|---|---|
| Web app | `POST /api/check`, `/api/reports`, `/api/disputes`, `/api/cases` | device ID (stored only as a keyed hash) |
| Partner API | `POST /v1/check-account` | `Authorization: Bearer <key>` from `TRACE_API_KEYS` |
| WhatsApp | `POST /api/whatsapp` (Twilio webhook, TwiML) | `X-Twilio-Signature` via `TWILIO_AUTH_TOKEN` |
| Staff | `/intel`, `/api/admin/*`, `/api/ai/patterns` | HTTP Basic, `ADMIN_PASSWORD` |

WhatsApp is a short guided chat (state kept per hashed phone number for 10 minutes):
"hi" → menu (1 Check · 2 Report · 3 How TRACE works) → account number or screenshot →
bank (numbered list or typed name) → result with account name. Reporting continues with
"what happened?" → AI summary → YES to submit. Shortcuts still work:
`CHECK 0123456789 GTBank`, `REPORT 0123456789 GTBank what happened`, `MENU`.
To connect: expose the server over HTTPS (e.g. `ngrok http 3217`) and set the Twilio
sandbox "When a message comes in" URL to `https://<host>/api/whatsapp` (POST). Free
ngrok gives a new host each restart, so update Twilio each time. Don't use the Vercel
deployment for WhatsApp; see [Hosting](#hosting).

### Privacy
- `reports` holds only an HMAC of the reporter's device ID or phone number.
- Optional names/contact details live in `reporter_contacts`, never read by the engine or any public page.
- Evidence files are stored privately and never served.

### Hosting
Runs anywhere with Node 22.13+ and a persistent disk (VPS, your own machine):
`npm run build && npm start`.

The public demo runs on Vercel's free tier with `TRACE_DATA_DIR=/tmp`. Serverless
storage is temporary, so the demo resets to sample data from time to time; a real
deployment would use a persistent disk or swap SQLite for a hosted database.

**WhatsApp needs a persistent server.** Vercel runs several short-lived instances, each
with its own `/tmp`, and a chat's place in the conversation is stored in SQLite. When
two messages land on different instances, the second one starts from the menu. The
most visible symptom is a screenshot sent mid "I was scammed" coming back as a plain
risk check. Until the database is hosted (Turso would be the drop-in), point Twilio
at a machine with a disk: `npm run build && PORT=3217 npm start`, then `ngrok http 3217`.

## Status

A working proof of concept, not a launched product. Before real users: a TRACE-owned
Paystack key, verified bank fraud-desk contacts in `src/lib/help.json`, and native-speaker
review of the Yorùbá, Hausa and Igbo text.
