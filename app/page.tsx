'use client';

import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/db';
import { buildOccurrences } from '@/lib/domain';
import { MedicationCard } from '@/components/MedicationCard';
import { CheckCircle2, Moon, Sun, Sunrise } from 'lucide-react';
import type { Period } from '@/lib/types';

const periodMeta: Record<Period, { label:string; icon:any }> = {
  morning: { label:'Manhã', icon: Sunrise },
  afternoon: { label:'Tarde', icon: Sun },
  night: { label:'Noite', icon: Moon },
  custom: { label:'Outros', icon: Sun }
};

export default function TodayPage() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 60_000); return () => clearInterval(timer); }, []);
  const dateKey = now.toLocaleDateString('sv-SE');
  const medications = useLiveQuery(() => db.medications.toArray(), []) || [];
  const logs = useLiveQuery(() => db.logs.where('scheduledDate').equals(dateKey).toArray(), [dateKey]) || [];
  const occurrences = buildOccurrences(medications, logs, now, now);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('occurrence');
    if (!id || !occurrences.length) return;
    setTimeout(() => document.getElementById(`occurrence-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
  }, [occurrences.length]);
  const taken = occurrences.filter(o => o.log?.status === 'taken').length;
  const late = occurrences.filter(o => o.status === 'late' && o.log?.status !== 'taken').length;
  const pending = occurrences.filter(o => !['taken','skipped'].includes(o.log?.status || '')).length;
  const next = occurrences.find(o => o.log?.status !== 'taken' && o.log?.status !== 'skipped' && o.scheduledAt >= now);
  const hour = now.getHours();
  const greeting = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
  const progress = occurrences.length ? Math.round((taken / occurrences.length) * 100) : 0;
  const dateLabel = new Intl.DateTimeFormat('pt-BR', { weekday:'long', day:'numeric', month:'long' }).format(now);

  return (
    <div>
      <header className="mb-5 pt-1">
        <p className="muted text-sm font-bold">{greeting}</p>
        <h1 className="mt-1 text-3xl font-black">Medicamentos</h1>
        <p className="muted mt-1 capitalize">{dateLabel}</p>
      </header>

      <section className="card mb-6 p-5" aria-label="Resumo de hoje">
        <div className="flex items-end justify-between gap-3"><div><p className="text-sm font-black">Hoje</p><p className="mt-1 text-2xl font-black">{taken} / {occurrences.length} tomados</p></div><span className="text-lg font-black text-sky-600">{progress}%</span></div>
        <div className="mt-4 h-3 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800" aria-label={`Progresso ${progress}%`}><div className="h-full rounded-full bg-sky-500 transition-all" style={{ width:`${progress}%` }}/></div>
        <div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs font-bold">
          <div className="rounded-xl bg-slate-50 p-2 dark:bg-slate-900"><div className="text-base">{next?.scheduledTime || '—'}</div><div className="muted">Próximo</div></div>
          <div className="rounded-xl bg-slate-50 p-2 dark:bg-slate-900"><div className="text-base">{pending}</div><div className="muted">Pendentes</div></div>
          <div className="rounded-xl bg-slate-50 p-2 dark:bg-slate-900"><div className="text-base">{late}</div><div className="muted">Atrasados</div></div>
        </div>
        {occurrences.length > 0 && taken === occurrences.length && <p className="mt-4 flex items-center gap-2 rounded-2xl bg-emerald-50 p-3 font-black text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"><CheckCircle2 size={20}/> Tudo certo por hoje</p>}
      </section>

      <h2 className="mb-3 text-xl font-black">Medicamentos de hoje</h2>
      {occurrences.length === 0 && <div className="card p-6 text-center"><p className="font-black">Nenhum medicamento programado para hoje.</p><p className="muted mt-2 text-sm">Cadastre um medicamento na aba Medicamentos.</p></div>}

      {(['morning','afternoon','night','custom'] as Period[]).map(period => {
        const list = occurrences.filter(o => o.medication.period === period);
        if (!list.length) return null;
        const Icon = periodMeta[period].icon;
        return <section key={period} className="mb-7">
          <h2 className="mb-3 flex items-center gap-2 text-lg font-black"><Icon size={20} aria-hidden="true"/> {periodMeta[period].label}</h2>
          <div className="space-y-3">{list.map(o => <MedicationCard key={o.id} occurrence={o}/>)}</div>
        </section>;
      })}
    </div>
  );
}
