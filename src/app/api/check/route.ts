// First-party check used by the TRACE app: name enquiry + risk signal.
import { NextResponse } from 'next/server';
import { allowUse, SIGN_IN_REQUIRED } from '@/lib/auth';
import { webCaller } from '@/lib/caller';
import { checkAccount } from '@/lib/engine';
import { resolveAccount } from '@/lib/paystack';
import { findBank, normalizeAccount } from '@/lib/shared';

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const accountNumber = normalizeAccount(body?.accountNumber);
  if (!accountNumber) return NextResponse.json({ error: 'Enter a 10-digit account number' }, { status: 400 });
  const bank = findBank(body?.bank);
  if (!allowUse(req)) return NextResponse.json(SIGN_IN_REQUIRED, { status: 401 });
  const intel = checkAccount(bank, accountNumber, 'web');
  // Sample reports are synthetic, but the number may belong to a real person: never pair them with a real name.
  const verification = intel.sampleData
    ? { status: 'unavailable', reason: 'sample' } as const
    : await resolveAccount(accountNumber, bank, webCaller(req).key);
  return NextResponse.json({ ...intel, verification });
}
