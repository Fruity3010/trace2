// Storage: Node's built-in SQLite, one file under ./data. No database service.
//
// Privacy by structure: `reports` (public intelligence) holds only an opaque
// HMAC of the reporter. Optional names/contact details live in
// `reporter_contacts` and are never read by the intelligence engine.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { seedSample } from './seed';

export const DATA_DIR = process.env.TRACE_DATA_DIR ?? path.join(process.cwd(), 'data');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  account_number TEXT NOT NULL,
  bank TEXT,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  summary TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  language TEXT,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  reporter TEXT NOT NULL,
  channel TEXT NOT NULL,
  region TEXT,
  status TEXT NOT NULL,
  status_reason TEXT,
  source TEXT NOT NULL DEFAULT 'offline',
  sample INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reports_account ON reports (account_number, status);
CREATE INDEX IF NOT EXISTS reports_reporter ON reports (reporter, created_at);

CREATE TABLE IF NOT EXISTS reporter_contacts (
  report_id TEXT PRIMARY KEY REFERENCES reports(id) ON DELETE CASCADE,
  name TEXT,
  contact TEXT
);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  stored_as TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_number TEXT NOT NULL,
  channel TEXT NOT NULL,
  risk TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS disputes (
  id TEXT PRIMARY KEY,
  account_number TEXT NOT NULL,
  bank TEXT,
  reason TEXT NOT NULL,
  contact TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  resolution TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS disputes_account ON disputes (account_number, status);

-- An escalation a victim has opened against their own bank. The reporter column is
-- the same opaque HMAC used by reports, so a case is never linked to a person either.
CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  account_number TEXT NOT NULL,
  bank TEXT,
  victim_bank TEXT,
  amount INTEGER,
  sent_at TEXT NOT NULL,
  reporter TEXT NOT NULL,
  report_id TEXT REFERENCES reports(id) ON DELETE SET NULL,
  reference TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  filed_at TEXT,
  responded_at TEXT,
  outcome TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cases_reporter ON cases (reporter, created_at);
CREATE INDEX IF NOT EXISTS cases_account ON cases (account_number);

CREATE TABLE IF NOT EXISTS rate_limits (bucket TEXT NOT NULL, caller TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS rate_limits_lookup ON rate_limits (bucket, caller, created_at);

-- Web accounts. phone is a keyed hash, never the number itself; sessions.token is a SHA-256 of the cookie.
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, phone TEXT NOT NULL UNIQUE, password TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL);
-- Checks and reports used before signing in, per hashed device.
CREATE TABLE IF NOT EXISTS free_uses (caller TEXT PRIMARY KEY, n INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS wa_sessions (phone TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at TEXT NOT NULL);
-- A chat's reply language outlives its 10-minute session. pinned = chosen with LANGUAGE, so detection leaves it alone.
CREATE TABLE IF NOT EXISTS wa_prefs (phone TEXT PRIMARY KEY, lang TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, demo_until TEXT);
`;

declare global {
  // Survives dev hot reloads so we don't open a new handle per edit.
  var __traceDb: DatabaseSync | undefined;
  var __traceDemoDb: DatabaseSync | undefined;
}

function open(file: string, seed: boolean): DatabaseSync {
  mkdirSync(path.join(DATA_DIR, 'evidence'), { recursive: true });
  const d = new DatabaseSync(path.join(DATA_DIR, file));
  d.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  d.exec(SCHEMA);

  if (!d.prepare("SELECT 1 FROM meta WHERE key = 'seeded'").get()) {
    d.exec('BEGIN');
    if (seed) seedSample(d);
    d.prepare("INSERT INTO meta VALUES ('seeded', ?)").run(new Date().toISOString());
    d.exec('COMMIT');
  }
  return d;
}

/*
 * Demo mode (WhatsApp "DEMO"): the same code runs against data/demo.db, a throwaway
 * copy seeded with sample data, so a pitch can report, escalate and repeat without
 * touching real intelligence. Every db() call inside asDemo() goes there.
 */
const demo = new AsyncLocalStorage<true>();
export const asDemo = <T>(fn: () => T): T => demo.run(true, fn);
export const inDemo = () => demo.getStore() === true;

/** Throws the demo world away; the next demo db() call reseeds it. */
export function resetDemo() {
  globalThis.__traceDemoDb?.close();
  globalThis.__traceDemoDb = undefined;
  for (const s of ['', '-wal', '-shm']) rmSync(path.join(DATA_DIR, `demo.db${s}`), { force: true });
}

export function db(): DatabaseSync {
  if (inDemo()) return (globalThis.__traceDemoDb ??= open('demo.db', true));
  return (globalThis.__traceDb ??= open('trace.db', process.env.TRACE_SEED_SAMPLE !== 'false'));
}

/** Server secret for hashing reporter identifiers. Env wins; otherwise generated once and stored. */
export function secret(): string {
  if (process.env.TRACE_SECRET) return process.env.TRACE_SECRET;
  const row = db().prepare("SELECT value FROM meta WHERE key = 'secret'").get() as { value: string } | undefined;
  if (row) return row.value;
  const s = randomBytes(32).toString('hex');
  db().prepare("INSERT INTO meta VALUES ('secret', ?)").run(s);
  return s;
}

/** Sliding one-hour window. `caller` must already be a hashed key. */
export function rateLimit(bucket: string, caller: string, perHour: number): boolean {
  const d = db();
  const now = Date.now();
  const used = (d.prepare('SELECT COUNT(*) AS n FROM rate_limits WHERE bucket = ? AND caller = ? AND created_at >= ?')
    .get(bucket, caller, new Date(now - 3_600_000).toISOString()) as { n: number }).n;
  if (used >= perHour) return false;
  d.prepare('INSERT INTO rate_limits VALUES (?, ?, ?)').run(bucket, caller, new Date(now).toISOString());
  // ponytail: prunes on write; move to a scheduled job if traffic gets heavy.
  d.prepare('DELETE FROM rate_limits WHERE created_at < ?').run(new Date(now - 86_400_000).toISOString());
  return true;
}
