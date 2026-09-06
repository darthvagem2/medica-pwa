'use client';

import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, ensureLocalState } from '@/lib/db';
import { registerServiceWorker, syncReminderJobs } from '@/lib/reminder-client';
import { Onboarding } from './Onboarding';

export function AppBootstrap() {
  const settings = useLiveQuery(() => db.settings.get('settings'));
  const [ready, setReady] = useState(false);

  useEffect(() => {
    ensureLocalState().then(async () => {
      await registerServiceWorker();
      setReady(true);
      syncReminderJobs().catch(() => undefined);
    });
  }, []);

  useEffect(() => {
    if (!settings) return;
    const root = document.documentElement;
    const apply = () => {
      const dark = settings.theme === 'dark' || (settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
      root.classList.toggle('dark', dark);
    };
    apply();
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [settings]);

  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') syncReminderJobs().catch(() => undefined); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  if (!ready || !settings) return null;
  return settings.onboardingDone ? null : <Onboarding />;
}
