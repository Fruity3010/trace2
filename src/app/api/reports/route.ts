import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { verifyClassification } from '@/lib/ai';
import { allowUse, SIGN_IN_REQUIRED } from '@/lib/auth';
import { DATA_DIR } from '@/lib/db';
import { addEvidence, peekAccount, reporterKey, reportsFor, submitReport } from '@/lib/engine';
import { resolveAccount } from '@/lib/paystack';
import { Classification, findBank, normalizeAccount } from '@/lib/shared';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FILES = 4;
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = /^(image\/(png|jpeg|webp|heic|gif)|audio\/[\w.+-]+|application\/pdf|text\/plain|application\/msword|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document)$/;
const EXT: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/heic': '.heic', 'image/gif': '.gif', 'application/pdf': '.pdf', 'text/plain': '.txt' };

const device = (req: Request) => {
  const id = req.headers.get('x-trace-device') ?? '';
  return UUID.test(id) ? reporterKey('device', id) : null;
};

export async function GET(req: Request) {
  const reporter = device(req);
  if (!reporter) return NextResponse.json({ error: 'Missing device id' }, { status: 400 });
  return NextResponse.json(reportsFor(reporter));
}

export async function POST(req: Request) {
  const reporter = device(req);
  if (!reporter) return NextResponse.json({ error: 'Missing device id' }, { status: 400 });

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: 'Invalid form' }, { status: 400 });

  const accountNumber = normalizeAccount(form.get('accountNumber'));
  if (!accountNumber) return NextResponse.json({ error: 'Enter the 10-digit account number you paid' }, { status: 400 });

  const text = String(form.get('text') ?? '');
  let classification: Classification;
  try {
    classification = JSON.parse(String(form.get('classification')));
  } catch {
    return NextResponse.json({ error: 'Invalid classification' }, { status: 400 });
  }
  if (!verifyClassification(text, classification, String(form.get('token') ?? ''))) {
    return NextResponse.json({ error: 'Report must be classified by TRACE before submitting' }, { status: 400 });
  }

  const files = form.getAll('evidence').filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length > MAX_FILES) return NextResponse.json({ error: `Up to ${MAX_FILES} evidence files` }, { status: 400 });
  for (const f of files) {
    if (f.size > MAX_BYTES) return NextResponse.json({ error: `${f.name} is larger than 5 MB` }, { status: 400 });
    if (!ALLOWED.test(f.type)) return NextResponse.json({ error: `${f.name}: unsupported file type` }, { status: 400 });
  }

  const bank = findBank(form.get('bank'));
  if (!bank) return NextResponse.json({ error: 'Choose the bank you paid' }, { status: 400 });
  // A number that doesn't exist at that bank is almost always a typo; don't let it become a report.
  // Sample accounts are made up, so the bank won't know them.
  if (!peekAccount(bank, accountNumber).sampleData && (await resolveAccount(accountNumber, bank, reporter)).status === 'not_found') {
    return NextResponse.json({ error: `${accountNumber} doesn't match an account at ${bank}. Check the number and bank.` }, { status: 400 });
  }

  if (!allowUse(req)) return NextResponse.json(SIGN_IN_REQUIRED, { status: 401 });

  const anonymous = form.get('anonymous') !== 'false';
  const str = (k: string) => (anonymous ? null : String(form.get(k) ?? '').trim().slice(0, 120) || null);

  const report = submitReport({
    accountNumber, bank, classification, reporter, channel: 'web',
    contact: { name: str('name'), contact: str('contact') },
  });

  // Evidence is stored privately on the server, never served publicly.
  const kinds = form.getAll('kind').map(String);
  for (const [i, f] of files.entries()) {
    const id = randomUUID();
    const storedAs = `${id}${EXT[f.type] ?? ''}`;
    await writeFile(path.join(DATA_DIR, 'evidence', storedAs), Buffer.from(await f.arrayBuffer()));
    addEvidence(report.id, { id, kind: kinds[i]?.slice(0, 20) || 'file', fileName: f.name.slice(0, 200), mime: f.type, size: f.size, storedAs });
  }

  return NextResponse.json({ ...report, evidenceCount: files.length }, { status: 201 });
}
