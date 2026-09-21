// Web accounts: a phone number and a password, needed only after the free checks
// and reports run out. The phone is stored as a keyed hash, like every other
// identifier in TRACE; passwords are scrypt-hashed; sessions are random tokens
// in an httpOnly cookie, stored as a SHA-256 hash.
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { webCaller } from './caller';
import { db } from './db';
import { reporterKey } from './engine';

export const FREE_USES = 5;
export const SESSION_COOKIE = 'trace_session';
const SESSION_DAYS = 365;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Nigerian mobile number in any common form (0803…, 234803…, +234 803…) → +234XXXXXXXXXX, or null. */
export function normalizePhone(raw: unknown): string | null {
  const d = String(raw ?? '').replace(/\D/g, '');
  const local = d.startsWith('234') ? d.slice(3) : d.startsWith('0') ? d.slice(1) : d;
  return /^[789]\d{9}$/.test(local) ? `+234${local}` : null;
}

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(password, salt, 64).toString('hex')}`;
}

function passwordMatches(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  const got = scryptSync(password, Buffer.from(salt, 'hex'), 64);
  return timingSafeEqual(got, Buffer.from(hash, 'hex'));
}

/**
 * Sign in, or create the account if this phone has none. One form for both, so
 * nobody has to know which one they need.
 */
export function signInOrUp(phone: string, password: string): { token: string } | { error: string } {
  const key = reporterKey('phone', phone);
  const user = db().prepare('SELECT id, password FROM users WHERE phone = ?').get(key) as { id: string; password: string } | undefined;
  let userId: string;
  if (user) {
    if (!passwordMatches(password, user.password)) return { error: 'Wrong password for this phone number.' };
    userId = user.id;
  } else {
    userId = randomUUID();
    db().prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run(userId, key, hashPassword(password), new Date().toISOString());
  }
  const token = randomBytes(32).toString('base64url');
  db().prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(sha256(token), userId, new Date().toISOString());
  return { token };
}

function sessionToken(req: Request): string | null {
  const m = (req.headers.get('cookie') ?? '').match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  return m ? m[1] : null;
}

export function signedIn(req: Request): boolean {
  const token = sessionToken(req);
  if (!token) return false;
  const row = db().prepare('SELECT created_at FROM sessions WHERE token = ?').get(sha256(token)) as { created_at: string } | undefined;
  return !!row && Date.now() - Date.parse(row.created_at) < SESSION_DAYS * 86_400_000;
}

export function signOut(req: Request) {
  const token = sessionToken(req);
  if (token) db().prepare('DELETE FROM sessions WHERE token = ?').run(sha256(token));
}

export const sessionCookie = (token: string) => ({
  name: SESSION_COOKIE, value: token, httpOnly: true, sameSite: 'lax' as const, path: '/',
  secure: process.env.NODE_ENV === 'production', maxAge: SESSION_DAYS * 86_400,
});

/** Free checks and reports this device has left. */
export function freeLeft(req: Request): number {
  const row = db().prepare('SELECT n FROM free_uses WHERE caller = ?').get(webCaller(req).key) as { n: number } | undefined;
  return Math.max(0, FREE_USES - (row?.n ?? 0));
}

/**
 * Counts one check or report. False once the free ones are used and nobody is signed in.
 * ponytail: counted per device ID, so clearing site data resets it; tie it to IP ranges if abuse shows up.
 */
export function allowUse(req: Request): boolean {
  if (signedIn(req)) return true;
  if (freeLeft(req) === 0) return false;
  db().prepare('INSERT INTO free_uses VALUES (?, 1) ON CONFLICT(caller) DO UPDATE SET n = n + 1').run(webCaller(req).key);
  return true;
}

export const SIGN_IN_REQUIRED = { error: `You've used your ${FREE_USES} free checks and reports. Sign in to keep going — it's free.`, signIn: true };
