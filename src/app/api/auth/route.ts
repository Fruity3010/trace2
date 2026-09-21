// Web sign-in: GET status, POST phone + password (signs in, or creates the account), DELETE signs out.
import { NextResponse } from 'next/server';
import { freeLeft, normalizePhone, SESSION_COOKIE, sessionCookie, signedIn, signInOrUp, signOut } from '@/lib/auth';
import { webCaller } from '@/lib/caller';
import { rateLimit } from '@/lib/db';

export async function GET(req: Request) {
  return NextResponse.json({ signedIn: signedIn(req), freeLeft: freeLeft(req) });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const phone = normalizePhone(body?.phone);
  if (!phone) return NextResponse.json({ error: 'Enter a Nigerian phone number, like 0803 123 4567.' }, { status: 400 });
  const password = typeof body?.password === 'string' ? body.password : '';
  if (password.length < 6 || password.length > 200) return NextResponse.json({ error: 'Use a password of at least 6 characters.' }, { status: 400 });
  if (!rateLimit('sign_in', webCaller(req).key, 10)) return NextResponse.json({ error: 'Too many attempts. Try again in an hour.' }, { status: 429 });

  const result = signInOrUp(phone, password);
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 401 });
  const res = NextResponse.json({ signedIn: true });
  res.cookies.set(sessionCookie(result.token));
  return res;
}

export async function DELETE(req: Request) {
  signOut(req);
  const res = NextResponse.json({ signedIn: false });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
