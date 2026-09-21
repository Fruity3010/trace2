'use client';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { BankOptions } from '@/components/BankOptions';
import { Icon } from '@/components/Icons';
import { SignIn } from '@/components/SignIn';
import { btn, page, TopBar } from '@/components/ui';
import { VoiceButton } from '@/components/VoiceButton';
import { deviceId, useLocal, usePrefs } from '@/lib/store';
import { findBank, LANGUAGES, MyReport } from '@/lib/shared';

const MAX_FILES = 4;
const MAX_BYTES = 5 * 1024 * 1024;
const kindOf = (f: File) => (f.type.startsWith('audio/') ? 'Voice note' : f.type.startsWith('image/') ? 'Screenshot' : 'Document');

/** One screen: account, what happened, send. Reports are always anonymous. */
export function ReportFlow({ initialAccount, initialBank }: { initialAccount: string; initialBank: string }) {
  const [prefs, setPrefs] = usePrefs();
  const [draft, setDraft] = useLocal('trace.draft', '');
  const [bank, setBank] = useState<string>(findBank(initialBank) ?? '');
  const [account, setAccount] = useState(initialAccount.replace(/\D/g, '').slice(0, 10));
  const [editAccount, setEditAccount] = useState(!initialAccount);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Asked once, only when the story is too thin to count. The second press sends regardless.
  const [question, setQuestion] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [submitted, setSubmitted] = useState<MyReport | null>(null);
  const [needSignIn, setNeedSignIn] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const speech = LANGUAGES.find((l) => l.code === prefs.lang)?.speech ?? 'en-NG';
  const ready = account.length === 10 && bank && draft.trim().length >= 8;

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const text = draft.trim();
      const cRes = await fetch('/api/ai/classify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
      if (!cRes.ok) throw new Error();
      const { classification, token } = await cRes.json();
      if (classification.needsClarification && classification.clarifyingQuestion && question === null) {
        setQuestion(classification.clarifyingQuestion);
        return;
      }
      const form = new FormData();
      form.set('text', text.slice(0, 4000));
      form.set('classification', JSON.stringify(classification));
      form.set('token', token);
      form.set('accountNumber', account);
      form.set('bank', bank);
      form.set('anonymous', 'true');
      for (const f of files) { form.append('evidence', f); form.append('kind', kindOf(f)); }
      const res = await fetch('/api/reports', { method: 'POST', headers: { 'x-trace-device': deviceId() }, body: form });
      const data = await res.json();
      if (data.signIn) { setNeedSignIn(true); return; }
      if (!res.ok) { setError(data.error ?? "Couldn't send. Try again."); return; }
      setDraft('');
      setSubmitted(data);
      window.scrollTo({ top: 0 });
    } catch {
      setError("Couldn't reach TRACE. Your words are saved on this device — try again when you're connected.");
    } finally {
      setBusy(false);
    }
  }

  function addFile(f: File | undefined) {
    if (!f) return;
    if (f.size > MAX_BYTES) return setError(`${f.name} is larger than 5 MB.`);
    setError(null);
    setFiles((xs) => [...xs, f].slice(0, MAX_FILES));
  }

  /* ── Done ── */
  if (submitted) {
    const counted = submitted.status === 'added';
    const q = `${submitted.accountNumber}${submitted.bank ? `&bank=${encodeURIComponent(submitted.bank)}` : ''}`;
    return (
      <div className={`${page.narrow} animate-rise pt-10 text-center`}>
        <div className={`mx-auto grid size-20 place-items-center rounded-full text-paper ${counted ? 'bg-low' : 'bg-medium'}`}>
          <Icon name={counted ? 'check' : 'info'} size={40} strokeWidth={3} />
        </div>
        <h1 className="mt-6 font-serif text-[40px] font-medium leading-none">{counted ? 'Thank you' : 'Report received'}</h1>
        <p className="mx-auto mt-2 max-w-[34ch] text-ink-2">
          {counted ? 'The next person who checks this account will be warned. You are never named.' : submitted.statusReason}
        </p>
        <p className="mt-3 text-[13px] text-ink-3">Reference <span className="font-mono font-semibold">{submitted.id}</span></p>

        <Link href={`/help?account=${q}`} className="mt-8 flex items-center gap-4 rounded-2xl border-2 border-high bg-high-wash p-5 text-left">
          <Icon name="phone" size={26} className="shrink-0 text-high" />
          <span className="flex-1">
            <span className="block text-[17px] font-bold">Did you send money to this account?</span>
            <span className="text-[14px] text-ink-2">Call your bank now — they may be able to freeze it. We’ll tell you what to say.</span>
          </span>
          <Icon name="chevronRight" className="shrink-0 text-high" />
        </Link>

        <Link href="/" className={`${btn.secondary} mt-4`}>Done</Link>
        <Link href="/reports" className="mt-3 inline-block min-h-11 text-[14px] text-ink-3 underline underline-offset-4">My reports</Link>
      </div>
    );
  }

  /* ── Write ── */
  return (
    <div className={`${page.narrow} animate-rise`}>
      <TopBar back={initialAccount ? `/account/${initialAccount}${initialBank ? `?bank=${encodeURIComponent(initialBank)}` : ''}` : '/'} />

      <h1 className="font-serif text-[40px] font-medium leading-none">What happened?</h1>
      <p className="mt-1 text-ink-3">A sentence or two, in any language. You are never named.</p>

      {editAccount ? (
        <div className="mt-5 grid grid-cols-[1fr_1.2fr] gap-2">
          <select aria-label="Bank" value={bank} onChange={(e) => setBank(e.target.value)} className="card-sm h-13 w-full min-w-0 px-3 text-[15px] font-semibold outline-none focus:ring-4 focus:ring-brand/15">
            <BankOptions placeholder="Their bank" />
          </select>
          <input aria-label="Account number you paid" value={account} onChange={(e) => setAccount(e.target.value.replace(/\D/g, '').slice(0, 10))}
            inputMode="numeric" placeholder="Account you paid" className="card-sm h-13 w-full min-w-0 px-3 font-mono outline-none focus:ring-4 focus:ring-brand/15 text-[16px] font-bold tracking-wider placeholder:font-sans placeholder:font-medium placeholder:tracking-normal" />
        </div>
      ) : (
        <div className="mt-5 flex items-center gap-3 card-sm p-3.5">
          <Icon name="bank" className="text-ink-3" />
          <p className="font-mono font-bold">{account}<span className="font-sans text-[14px] font-semibold text-ink-3"> · {bank || 'Bank'}</span></p>
          <button type="button" onClick={() => setEditAccount(true)} className="ml-auto min-h-10 px-2 text-[13px] font-medium text-brand underline underline-offset-4">Change</button>
        </div>
      )}

      <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={5} maxLength={4000} autoFocus={!!initialAccount}
        aria-label="Describe what happened" placeholder="e.g. I paid for an iPhone on Instagram and they blocked me after the transfer."
        className="card mt-3 w-full resize-none p-4 text-[16px] leading-relaxed outline-none placeholder:text-ink-4 focus:ring-4 focus:ring-brand/15" />

      {question && (
        <div role="status" className="mt-2 flex gap-3 rounded-2xl bg-medium-wash p-4 text-[14px]">
          <Icon name="info" className="shrink-0 text-medium" />
          <p><span className="font-bold">{question}</span> <span className="text-ink-2">Add it above if you can, or send as it is.</span></p>
        </div>
      )}

      <div className="mt-2 flex gap-2">
        <VoiceButton lang={speech} onTranscript={(t) => setDraft((d) => (d ? `${d} ${t}` : t))} />
        <select aria-label="Voice language" value={prefs.lang} onChange={(e) => setPrefs((p) => ({ ...p, lang: e.target.value as typeof p.lang }))}
          className="card-sm h-13 shrink-0 px-3 text-[14px] font-semibold">
          {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
        </select>
        <button type="button" disabled={files.length >= MAX_FILES} onClick={() => fileRef.current?.click()}
          className="card-sm flex h-13 shrink-0 items-center gap-1.5 px-3 text-[14px] font-semibold disabled:opacity-40">
          <Icon name="paperclip" size={16} /> Proof
        </button>
        <input ref={fileRef} type="file" hidden accept="image/*,audio/*,.pdf,.doc,.docx,.txt" onChange={(ev) => { addFile(ev.target.files?.[0]); ev.target.value = ''; }} />
      </div>
      {files.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {files.map((f, i) => (
            <li key={i} className="inline-flex items-center gap-1.5 rounded-md border border-ink py-1 pl-3 pr-1 text-[13px] font-medium">
              <Icon name="paperclip" size={13} /> <span className="max-w-[16ch] truncate">{f.name}</span>
              <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((xs) => xs.filter((_, j) => j !== i))} className="grid size-7 place-items-center rounded-full hover:bg-paper/60"><Icon name="x" size={13} /></button>
            </li>
          ))}
        </ul>
      )}

      {error && <p role="alert" className="mt-3 rounded-2xl bg-high-wash p-3 text-[14px] text-high">{error}</p>}

      {needSignIn && <div className="mt-5"><SignIn onDone={() => { setNeedSignIn(false); send(); }} /></div>}

      {!needSignIn && <button type="button" onClick={send} disabled={!ready || busy} className={`${btn.primary} mt-5`}>
        {busy ? <><span className="size-4 animate-spin rounded-full border-2 border-paper/30 border-t-paper" /> Sending…</> : 'Send report'}
      </button>}
      <p className="mt-3 flex items-center justify-center gap-1.5 text-[12px] text-ink-3"><Icon name="lock" size={13} /> Proof is private and never shown publicly.</p>
    </div>
  );
}
