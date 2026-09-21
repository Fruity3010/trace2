'use client';
import { useState } from 'react';
import { Icon } from './Icons';
import { btn } from './ui';

const field = 'h-13 w-full rounded-md border border-line bg-paper px-4 text-[16px] outline-none focus:border-brand';

/** Shown once the free checks and reports are used. Signs in, or creates the account. */
export function SignIn({ onDone }: { onDone: () => void }) {
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, password }) });
      if (res.ok) return onDone();
      setError((await res.json().catch(() => null))?.error ?? 'Something went wrong. Try again.');
    } catch {
      setError("Couldn't reach TRACE. Check your connection.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card grid gap-3 p-5">
      <p className="flex items-center gap-2 font-serif text-[22px] font-medium"><Icon name="lock" size={20} /> Sign in to keep going</p>
      <p className="-mt-1 text-[14px] text-ink-2">You&apos;ve used your 5 free checks and reports. New here? The same form creates your account. It&apos;s free.</p>
      <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="tel" placeholder="Phone number, e.g. 0803 123 4567" aria-label="Phone number" className={field} />
      <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="current-password" placeholder="Password (6+ characters)" aria-label="Password" className={field} />
      {error && <p role="alert" className="text-[14px] text-high">{error}</p>}
      <button type="submit" disabled={busy || phone.replace(/\D/g, '').length < 10 || password.length < 6} className={btn.primary}>
        {busy ? 'Signing in…' : 'Continue'}
      </button>
      <p className="text-center text-[12px] text-ink-3">Your number is stored scrambled and never shown to anyone.</p>
    </form>
  );
}
