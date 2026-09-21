'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Icon, IconName } from '@/components/Icons';
import { HowTraceWorks, page, TopBar } from '@/components/ui';
import { deviceId, usePrefs } from '@/lib/store';
import { botLink, LANGUAGES } from '@/lib/shared';

type InstallEvent = Event & { prompt: () => Promise<void> };

const BUSINESS: { href: string; icon: IconName; title: string; sub: string }[] = [
  { href: '/developers', icon: 'code', title: 'TRACE API', sub: 'Warn customers before they pay' },
];

export default function ProfilePage() {
  const [prefs, setPrefs] = usePrefs();
  const [install, setInstall] = useState<InstallEvent | null>(null);
  const whatsapp = botLink();
  const [auth, setAuth] = useState<{ signedIn: boolean; freeLeft: number } | null>(null);

  useEffect(() => {
    fetch('/api/auth', { headers: { 'x-trace-device': deviceId() } }).then((r) => r.json()).then(setAuth).catch(() => {});
  }, []);

  async function signOut() {
    await fetch('/api/auth', { method: 'DELETE' }).catch(() => {});
    setAuth((a) => a && { ...a, signedIn: false });
  }

  useEffect(() => {
    const on = (e: Event) => { e.preventDefault(); setInstall(e as InstallEvent); };
    window.addEventListener('beforeinstallprompt', on);
    return () => window.removeEventListener('beforeinstallprompt', on);
  }, []);

  return (
    <div className={`${page.mid} animate-rise`}>
      <div className="lg:hidden"><TopBar back={null} /></div>
      <div className="flex items-center gap-4 lg:pt-6">
                <div>
          <h1 className="font-serif text-[30px] font-medium leading-tight">Your TRACE</h1>
          <p className="text-[14px] text-ink-3">
            {!auth ? 'Settings stay on this device.'
              : auth.signedIn ? <>Signed in. <button type="button" onClick={signOut} className="min-h-10 text-brand underline underline-offset-4">Sign out</button></>
              : `${auth.freeLeft} free ${auth.freeLeft === 1 ? 'check or report' : 'checks and reports'} left before you need to sign in.`}
          </p>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div className="grid content-start gap-3">
          <section className="overflow-hidden card">
            <label className="flex min-h-16 items-center gap-3 px-4">
              <Icon name="globe" className="text-ink-3" />
              <span className="flex-1"><span className="block font-semibold">Voice input language</span><span className="text-[13px] text-ink-3">Typed reports work in any language</span></span>
              <select value={prefs.lang} onChange={(e) => setPrefs((p) => ({ ...p, lang: e.target.value as typeof p.lang }))} className="h-11 rounded-xl border border-line bg-paper px-2 font-semibold">
                {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
              </select>
            </label>
          </section>

          {install && (
            <button type="button" onClick={() => install.prompt().then(() => setInstall(null))}
              className="flex min-h-14 w-full items-center gap-3 rounded-md bg-ink px-4 text-left font-semibold text-raised">
              <Icon name="download" /> Install TRACE on this device
            </button>
          )}
          {whatsapp && (
            <a href={whatsapp} target="_blank" rel="noopener noreferrer"
              className="flex min-h-16 items-center gap-3 card px-4">
              <Icon name="chat" className="text-[#128c4a]" />
              <span className="flex-1"><span className="block font-semibold">TRACE on WhatsApp</span><span className="text-[13px] text-ink-3">Check and report without the app</span></span>
              <Icon name="chevronRight" className="text-ink-4" />
            </a>
          )}

          <Link href="/reports" className="flex min-h-16 items-center gap-3 card px-4 lg:hidden">
            <Icon name="file" className="text-ink-3" />
            <span className="flex-1"><span className="block font-semibold">My reports</span><span className="text-[13px] text-ink-3">Track what you have reported</span></span>
            <Icon name="chevronRight" className="text-ink-4" />
          </Link>

          <h2 className="eyebrow mt-4 lg:hidden">For business</h2>
          <ul className="overflow-hidden card lg:hidden">
            {BUSINESS.map((t) => (
              <li key={t.href} className="border-b border-line-2 last:border-0">
                <Link href={t.href} className="flex min-h-16 items-center gap-3 px-4 hover:bg-paper">
                  <span className="grid size-10 place-items-center rounded-2xl bg-paper"><Icon name={t.icon} size={19} /></span>
                  <span className="flex-1"><span className="block font-semibold">{t.title}</span><span className="text-[13px] text-ink-3">{t.sub}</span></span>
                  <Icon name="chevronRight" className="text-ink-4" />
                </Link>
              </li>
            ))}
          </ul>
        </div>

        <div><HowTraceWorks open /></div>
      </div>
    </div>
  );
}
