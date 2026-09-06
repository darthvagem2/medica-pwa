'use client';

import Link from 'next/link';
import { AlertTriangle, Check, Clock3, Pencil, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Occurrence, Side } from '@/lib/types';
import { confirmTaken, setNextApplicationSide, skipOccurrence, undoTaken } from '@/lib/local-actions';
import { cancelOccurrenceReminder, syncReminderJobs } from '@/lib/reminder-client';
import { minutesLate } from '@/lib/domain';

function sideLabel(side?: Side) { return side === 'left' ? 'ESQUERDO' : side === 'right' ? 'DIREITO' : ''; }
function prettyDelay(minutes: number) {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60); const m = minutes % 60;
  return m ? `${h}h ${m}min` : `${h}h`;
}

export function MedicationCard({ occurrence }: { occurrence: Occurrence }) {
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);
  useEffect(() => { const id = setInterval(() => setTick(v => v + 1), 60_000); return () => clearInterval(id); }, []);

  const taken = occurrence.log?.status === 'taken';
  const skipped = occurrence.log?.status === 'skipped';
  const now = new Date();
  const lateMinutes = useMemo(() => minutesLate(occurrence.scheduledAt, occurrence.log?.takenAt, now), [occurrence.scheduledAt, occurrence.log?.takenAt, now.getMinutes()]);
  const beyondDeadline = !taken && !skipped && occurrence.deadlineAt && now >= occurrence.deadlineAt;
  const isLate = !taken && !skipped && now >= occurrence.scheduledAt;
  const rotation = occurrence.medication.applicationRotation?.enabled;

  async function take() {
    if (busy) return;
    setBusy(true);
    try {
      await confirmTaken(occurrence.medication.id, occurrence.scheduledDate, occurrence.scheduledTime);
      await cancelOccurrenceReminder(occurrence.id).catch(() => undefined);
      await syncReminderJobs().catch(() => undefined);
    } finally { setBusy(false); }
  }

  async function skip() {
    if (busy || !confirm('Ignorar este medicamento somente nesta ocorrência?')) return;
    setBusy(true);
    try { await skipOccurrence(occurrence.medication.id, occurrence.scheduledDate, occurrence.scheduledTime); await cancelOccurrenceReminder(occurrence.id).catch(() => undefined); } finally { setBusy(false); }
  }

  async function undo() {
    if (busy) return;
    setBusy(true);
    try { await undoTaken(occurrence.medication.id, occurrence.scheduledDate, occurrence.scheduledTime); await syncReminderJobs().catch(() => undefined); }
    finally { setBusy(false); }
  }

  async function changeSide(side: Side) {
    const word = side === 'left' ? 'ESQUERDO' : 'DIREITO';
    if (!confirm(`Deseja definir o lado ${word} como o próximo local de aplicação?`)) return;
    await setNextApplicationSide(occurrence.medication.id, side);
  }

  return (
    <article id={`occurrence-${occurrence.id}`} className={`card p-4 ${beyondDeadline ? 'ring-2 ring-rose-400/60' : isLate ? 'ring-1 ring-amber-400/60' : ''}`} aria-label={`${occurrence.medication.name}, ${occurrence.scheduledTime}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-lg font-black">{occurrence.medication.nickname || occurrence.medication.name}</h3>
          <p className="muted mt-1 text-sm font-semibold">{occurrence.medication.dosage} {occurrence.medication.unit} · {occurrence.scheduledTime}</p>
        </div>
        <Link aria-label={`Editar ${occurrence.medication.name}`} href={`/medications?edit=${occurrence.medication.id}`} className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-slate-200 dark:border-slate-700"><Pencil size={18} /></Link>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {taken ? (
          <span className="status-pill bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"><Check size={14}/> Tomado</span>
        ) : skipped ? (
          <span className="status-pill bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300">Ignorado</span>
        ) : beyondDeadline ? (
          <span className="status-pill bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300"><AlertTriangle size={14}/> ATENÇÃO — CONFIRMAÇÃO PENDENTE</span>
        ) : isLate ? (
          <span className="status-pill bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300"><Clock3 size={14}/> ATRASADO</span>
        ) : (
          <span className="status-pill bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300"><Clock3 size={14}/> Pendente</span>
        )}
      </div>

      {taken && occurrence.log?.takenAt && <p className="mt-3 text-sm font-bold text-emerald-700 dark:text-emerald-300">✓ Tomado às {new Date(occurrence.log.takenAt).toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' })}</p>}
      {!taken && isLate && <p className="mt-3 text-sm font-bold text-amber-700 dark:text-amber-300">Atrasado há {prettyDelay(lateMinutes)}</p>}
      {rotation && <div className="mt-4 rounded-2xl bg-sky-50 p-3 dark:bg-sky-950/50">
        <p className="text-xs font-black uppercase tracking-wide text-sky-700 dark:text-sky-300">Próximo lado</p>
        <p className="mt-1 text-xl font-black">{sideLabel(occurrence.medication.applicationRotation?.nextSide)}</p>
        {!taken && <div className="mt-3 flex gap-2" aria-label="Alterar próximo lado">
          <button className="btn-secondary flex-1 text-sm" onClick={() => changeSide('left')}>Esquerdo</button>
          <button className="btn-secondary flex-1 text-sm" onClick={() => changeSide('right')}>Direito</button>
        </div>}
        {taken && occurrence.log?.applicationSide && <p className="mt-2 text-sm font-bold">Aplicado em: {sideLabel(occurrence.log.applicationSide)}</p>}
      </div>}

      <div className="mt-4">
        {!taken ? <div className="grid gap-2"><button disabled={busy} onClick={take} className="btn-primary w-full text-base disabled:opacity-50">✓ {rotation ? 'Tomei / apliquei' : 'Tomei'}</button>{!skipped && <button disabled={busy} onClick={skip} className="btn-secondary w-full text-sm disabled:opacity-50">Ignorar esta ocorrência</button>}</div>
          : <button disabled={busy} onClick={undo} className="btn-secondary flex w-full items-center justify-center gap-2 disabled:opacity-50"><RotateCcw size={17}/> Desfazer “Tomei”</button>}
      </div>
    </article>
  );
}
