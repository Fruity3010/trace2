'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icons';
import { SignIn } from '@/components/SignIn';
import { btn, HowTraceWorks, Line, page, Rule, Stamp, TopBar } from '@/components/ui';
import { deviceId } from '@/lib/store';
import { CATEGORIES, formatDate, Intelligence, n, Risk, Verification } from '@/lib/shared';

const NEXT_STEPS: Record<Risk, string> = {
  HIGH: "don't send money unless you can verify who you're paying in person or through a trusted platform.",
  MEDIUM: 'confirm who you are paying through a separate channel, or use pay-on-delivery.',
  LOW: 'still check the name matches who you are paying.',
};

export function AccountResult({ number, bank }: { number: string; bank: string | null }) {
  const [data, setData] = useState<(Intelligence & { verification: Verification }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [disputeOpen, setDisputeOpen] = useState(false);
  const [needSignIn, setNeedSignIn] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    fetch('/api/check', { method: 'POST', headers: { 'content-type': 'application/json', 'x-trace-device': deviceId() }, body: JSON.stringify({ bank, accountNumber: number }) })
      .then(async (r) => (await r.json()) as Intelligence & { verification: Verification; error?: string; signIn?: boolean })
      .then((d) => live && (d.signIn ? setNeedSignIn(true) : d.error ? setError(d.error) : setData(d)))
      .catch(() => live && setError('You appear to be offline. Try again when you have a connection.'));
    return () => { live = false; };
  }, [number, bank, attempt]);

  if (error) {
    return (
      <div className={page.narrow}>
        <TopBar back="/check" />
        <div className="card mt-10 p-6">
          <p className="font-serif text-[24px] font-medium">Couldn&apos;t check this account</p>
          <p className="mt-1 text-[15px] text-ink-2">{error}</p>
          <Link href="/check" className={`${btn.primary} mt-5`}>Try again</Link>
        </div>
      </div>
    );
  }

  if (needSignIn) {
    return (
      <div className={`${page.narrow} animate-rise`}>
        <TopBar back="/check" />
        <SignIn onDone={() => { setNeedSignIn(false); setAttempt((a) => a + 1); }} />
      </div>
    );
  }

  if (!data) return <Checking number={number} bank={bank} />;

  const reportHref = `/report?account=${data.accountNumber}${data.bank ? `&bank=${encodeURIComponent(data.bank)}` : ''}`;
  const v = data.verification;
  const checked = new Date(data.checkedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <div className={`${page.wide} animate-rise pb-4`}>
      <TopBar back="/check" title="Account report" />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px] lg:items-start lg:gap-10">
        <article className="card px-5 py-6 sm:px-9 sm:py-9" aria-live="polite">
          <header className="flex items-baseline justify-between gap-3 border-b-4 border-double border-ink pb-3">
            <span className="font-mono text-[13px] font-bold tracking-[0.22em]">TRACE</span>
            <span className="eyebrow text-right">Checked {checked}</span>
          </header>

          <div className="mt-6 flex flex-wrap items-start justify-between gap-x-6 gap-y-5">
            <div>
              <p className="eyebrow">Account number</p>
              <p className="mt-1 font-mono text-[30px] font-medium leading-none tracking-[0.1em] sm:text-[38px]">{data.accountNumber}</p>
              <p className="mt-2 font-serif text-[20px]">{data.bank ?? 'Bank not specified'}</p>
            </div>
            <div className="pt-2"><Stamp risk={data.risk} score={data.score} /></div>
          </div>

          {v.status === 'not_found' && (
            <div role="alert" className="mt-6 border-l-4 border-high bg-high-wash px-4 py-3">
              <p className="flex items-center gap-2 font-semibold text-high"><Icon name="octagon" size={18} /> Account not found</p>
              <p className="mt-1 text-[14px]">This number doesn&apos;t match an account at {data.bank ?? 'this bank'}. Don&apos;t send money until you&apos;ve confirmed the number and bank with the recipient.</p>
            </div>
          )}

          <p className="mt-6 font-serif text-[23px] font-medium leading-snug">{data.headline}</p>
          <p className="mt-1 text-[15px] leading-relaxed text-ink-2">{data.explanation}</p>

          <div className="mt-6 grid gap-2">
            <Line label="Name on account"><NameValue v={v} /></Line>
            {data.disputed && <Line label="Status"><span className="text-brand">Disputed by account holder</span></Line>}
          </div>
          {v.status === 'verified' && (
            <p className="mt-2 text-[14px] text-ink-2">Not who you&apos;re paying? <strong>Stop</strong> — scammers often use someone else&apos;s account.</p>
          )}

          <p className="mt-6 text-[15px]"><strong>What to do:</strong> {NEXT_STEPS[data.risk]}</p>

          <div className="mt-6 grid gap-2 sm:grid-cols-2">
            <Link href={reportHref} className={btn.primary}>Report this account</Link>
            <Link href="/check" className={btn.secondary}>Check another</Link>
          </div>

          <details className="group mt-8 border-t border-line pt-4">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between font-semibold">
              Why this result <Icon name="chevronDown" size={18} className="transition group-open:rotate-180" />
            </summary>

            <section className="mt-4">
              <Rule n="01">Record</Rule>
              <div className="mt-3 grid gap-2">
                <Line label="Community reports"><span className="tnum">{n(data.reports)}</span></Line>
                <Line label="Unique reporters"><span className="tnum">{n(data.uniqueReporters)}</span></Line>
                {data.reports > 0 && <>
                  <Line label="With evidence"><span className="tnum">{n(data.evidenceCount)}</span></Line>
                  {data.categories[0] && <Line label="Main pattern">{CATEGORIES[data.categories[0]]}</Line>}
                  <Line label="First reported">{formatDate(data.firstReported!)}</Line>
                  <Line label="Last reported">{data.lastReportedAgo}</Line>
                </>}
              </div>
              {data.reports === 0 && <p className="mt-3 text-[14px] text-ink-2">Nobody has reported this account to TRACE. That is not a guarantee — scammers open new accounts often.</p>}
            </section>

            <section className="mt-8">
              <Rule n="02">Score</Rule>
              <table className="mt-2 w-full text-[14px]">
                <tbody>
                  {data.factors.map((f, i) => (
                    <tr key={f.key} className="border-b border-line-2">
                      <td className="w-8 py-2.5 align-top font-mono text-[12px] text-ink-4">{String(i + 1).padStart(2, '0')}</td>
                      <td className="py-2.5 pr-3">
                        <span className="block font-medium">{f.label}</span>
                        <span className="text-ink-3">{f.detail}</span>
                      </td>
                      <td className="tnum whitespace-nowrap py-2.5 text-right align-top font-mono">+{Math.round(f.points)}<span className="text-ink-4">/{f.max}</span></td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-ink">
                    <td />
                    <td className="py-3 font-semibold">Risk score</td>
                    <td className="tnum py-3 text-right font-mono text-[16px] font-bold">{data.score}<span className="text-ink-4">/100</span></td>
                  </tr>
                </tbody>
              </table>
              <p className="mt-1 text-[13px] text-ink-3">0–29 low · 30–69 medium · 70–100 high. Calculated by fixed rules, not AI. One reporter alone cannot raise an account above low.</p>
            </section>

            {data.reports > 0 && (
              <section className="mt-8">
                <Rule n="03">Common patterns</Rule>
                <ul className="mt-3 grid gap-3">
                  {data.patterns.map((p) => (
                    <li key={p.label}>
                      <Line label={p.label}><span className="tnum">{p.count}</span></Line>
                      <div className="mt-1 h-[3px] bg-line-2" aria-hidden><div className="h-full bg-ink" style={{ width: `${(p.count / data.reports) * 100}%` }} /></div>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </details>

          <footer className="mt-10 border-t border-ink pt-3 text-[12px] leading-relaxed text-ink-3">
            {data.disclaimer} Reporter identities are never disclosed.{data.sampleData && ' Includes sample data.'}
          </footer>
        </article>

        <aside className="grid gap-3 lg:sticky lg:top-6">
          {data.reports > 0 && (
            <button type="button" onClick={() => setDisputeOpen(true)} className="min-h-11 text-left text-[14px] text-ink-2">
              Is this your account? <span className="text-brand underline decoration-1 underline-offset-4">Dispute these reports</span>
            </button>
          )}
          <HowTraceWorks />
        </aside>
      </div>

      {disputeOpen && <DisputeSheet accountNumber={data.accountNumber} bank={data.bank} onClose={() => setDisputeOpen(false)} />}
    </div>
  );
}

/** Name enquiry result, set as the value of the "Name on account" line. */
function NameValue({ v }: { v: Verification }) {
  if (v.status === 'verified') return <span className="inline-flex items-center gap-1.5 font-semibold"><Icon name="check" size={15} strokeWidth={2.6} className="text-low" />{v.accountName}</span>;
  if (v.status === 'not_found') return <span className="font-semibold text-high">Not found</span>;
  const text = { rate_limited: 'Paused — too many lookups', sample: 'Not checked (sample data)', error: 'Unavailable — check in your bank app', no_bank: 'Choose a bank to check', disabled: 'Not available' }[v.reason];
  return <span className="font-normal text-ink-3">{text}</span>;
}

function DisputeSheet({ accountNumber, bank, onClose }: { accountNumber: string; bank: string | null; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [contact, setContact] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [id, setId] = useState('');

  async function send() {
    setState('sending');
    const res = await fetch('/api/disputes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountNumber, bank, reason, contact }) }).catch(() => null);
    if (res?.ok) { setId((await res.json()).id); setState('done'); } else setState('error');
  }

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-ink/50 lg:items-center" role="dialog" aria-modal="true" aria-labelledby="dispute-title" onClick={onClose}>
      <div className="w-full max-w-lg animate-sheet rounded-t-md border-t-4 border-double border-ink bg-raised p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] lg:rounded-md" onClick={(e) => e.stopPropagation()}>
        {state === 'done' ? (
          <>
            <h2 id="dispute-title" className="font-serif text-[26px] font-medium">Dispute received</h2>
            <p className="mt-2 text-ink-2">Reference <span className="font-mono font-bold">{id}</span>. The account will show that its reports are disputed while our team reviews them.</p>
            <button type="button" onClick={onClose} className={`${btn.primary} mt-5`}>Done</button>
          </>
        ) : (
          <>
            <div className="flex items-start justify-between">
              <h2 id="dispute-title" className="font-serif text-[26px] font-medium">Dispute reports</h2>
              <button type="button" onClick={onClose} aria-label="Close" className="-mr-2 -mt-1 grid size-10 place-items-center rounded-md hover:bg-paper"><Icon name="x" /></button>
            </div>
            <p className="mt-1 text-[14px] text-ink-3">For the holder of <span className="font-mono">{accountNumber}</span>. Disputes are reviewed by people, not AI.</p>
            <label className="mt-5 grid gap-1.5 text-[14px] font-medium">Why are these reports wrong?
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={4} maxLength={1000} className="rounded-md border border-ink bg-transparent p-3 text-[15px] font-normal outline-none focus:border-brand" />
            </label>
            <label className="mt-3 grid gap-1.5 text-[14px] font-medium">Phone or email <span className="font-normal text-ink-3">(so we can follow up — never shown)</span>
              <input value={contact} onChange={(e) => setContact(e.target.value)} maxLength={120} className="h-12 rounded-md border border-ink bg-transparent px-3 text-[15px] font-normal outline-none focus:border-brand" />
            </label>
            {state === 'error' && <p role="alert" className="mt-3 text-[14px] text-high">Couldn&apos;t send. Check your connection and try again.</p>}
            <button type="button" onClick={send} disabled={reason.trim().length < 10 || state === 'sending'} className={`${btn.primary} mt-5`}>
              {state === 'sending' ? 'Sending…' : 'Submit dispute'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Checking({ number, bank }: { number: string; bank: string | null }) {
  return (
    <div className={page.mid}>
      <TopBar back="/check" title="Account report" />
      <div role="status" className="card px-6 py-8 sm:px-9">
        <div className="flex items-baseline justify-between border-b-4 border-double border-ink pb-3">
          <span className="font-mono text-[13px] font-bold tracking-[0.22em]">TRACE</span>
          <span className="eyebrow">Retrieving records</span>
        </div>
        <p className="mt-6 font-mono text-[30px] tracking-[0.1em]">{number}</p>
        <p className="mt-1 font-serif text-[20px]">{bank ?? ''}</p>
        <div className="mt-8 grid gap-3" aria-hidden>
          {['Confirming name with the bank', 'Reading community reports', 'Calculating risk score'].map((t, i) => (
            <div key={t} className="flex items-baseline text-[15px] text-ink-2" style={{ animation: `rise .35s ${i * 0.25}s both` }}>
              {t}<span className="leader" /><span className="font-mono text-[12px] text-ink-4">…</span>
            </div>
          ))}
        </div>
        <div className="mt-6 h-[2px] overflow-hidden bg-line-2"><div className="h-full w-1/3 animate-scan bg-ink" /></div>
        <p className="sr-only">Checking TRACE intelligence…</p>
      </div>
    </div>
  );
}
