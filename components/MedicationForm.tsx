'use client';

import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { Medication } from '@/lib/types';
import { createMedication, updateMedication } from '@/lib/local-actions';
import { syncReminderJobs } from '@/lib/reminder-client';
import { db } from '@/lib/db';

const units = ['mg','ml','comprimido','cápsula','gotas','aplicação','UI','dose','outro'];
const days = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];

type Draft = Omit<Medication,'id'|'createdAt'|'updatedAt'>;
function defaultDraft(repeatMinutes = 30): Draft {
  return {
    name:'', nickname:'', dosage:'', unit:'mg', enabled:true, period:'morning',
    schedules:[{ time:'08:00', deadline:'09:00' }],
    frequency:{ type:'daily', weekdays:[1,2,3,4,5], intervalDays:2, startDate:new Date().toLocaleDateString('sv-SE') },
    reminders:{ enabled:true, repeatMinutes, sound:true, required:true },
    applicationRotation:{ enabled:false, possibleSides:['left','right'], nextSide:'left' }
  };
}

export function MedicationForm({ medication, onClose }: { medication?: Medication; onClose: () => void }) {
  const settings = useLiveQuery(() => db.settings.get('settings'), []);
  const [draft, setDraft] = useState<Draft>(defaultDraft());
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (medication) { const { id,createdAt,updatedAt,...rest } = medication; setDraft(structuredClone(rest)); } else setDraft(defaultDraft(settings?.repeatMinutes || 30)); }, [medication, settings?.repeatMinutes]);

  function updateSchedule(i:number, patch:any) { setDraft(d => ({...d, schedules:d.schedules.map((s,idx)=>idx===i?{...s,...patch}:s)})); }
  function addSchedule() { setDraft(d => ({...d, schedules:[...d.schedules,{time:'12:00',deadline:'13:00'}]})); }
  function removeSchedule(i:number) { setDraft(d => ({...d, schedules:d.schedules.filter((_,idx)=>idx!==i)})); }

  async function save(e:React.FormEvent) {
    e.preventDefault(); if (!draft.name.trim() || !draft.schedules.length) return;
    setSaving(true);
    try {
      const clean = { ...draft, name:draft.name.trim(), nickname:draft.nickname?.trim() || undefined,
        applicationRotation: draft.applicationRotation?.enabled ? draft.applicationRotation : undefined };
      if (medication) await updateMedication(medication.id, clean); else await createMedication(clean);
      await syncReminderJobs().catch(()=>undefined); onClose();
    } finally { setSaving(false); }
  }

  return <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/60 p-3 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={medication?'Editar medicamento':'Adicionar medicamento'}>
    <form onSubmit={save} className="card mx-auto my-3 max-w-xl p-5 sm:p-6">
      <div className="mb-5 flex items-center justify-between"><h2 className="text-2xl font-black">{medication?'Editar':'Novo'} medicamento</h2><button type="button" className="btn-secondary" onClick={onClose}>Fechar</button></div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label><span className="label">Nome *</span><input className="input" required value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></label>
        <label><span className="label">Apelido</span><input className="input" value={draft.nickname||''} onChange={e=>setDraft({...draft,nickname:e.target.value})}/></label>
        <label><span className="label">Dose *</span><input className="input" required value={draft.dosage} onChange={e=>setDraft({...draft,dosage:e.target.value})}/></label>
        <label><span className="label">Unidade</span><select className="input" value={draft.unit} onChange={e=>setDraft({...draft,unit:e.target.value})}>{units.map(u=><option key={u}>{u}</option>)}</select></label>
        <label><span className="label">Período</span><select className="input" value={draft.period} onChange={e=>setDraft({...draft,period:e.target.value as any})}><option value="morning">Manhã</option><option value="afternoon">Tarde</option><option value="night">Noite</option><option value="custom">Personalizado</option></select></label>
        <label className="flex items-center gap-3 pt-6"><input type="checkbox" checked={draft.enabled} onChange={e=>setDraft({...draft,enabled:e.target.checked})}/><span className="font-bold">Medicamento ativo</span></label>
      </div>

      <fieldset className="mt-7"><legend className="text-lg font-black">Horários</legend><div className="mt-3 space-y-3">{draft.schedules.map((s,i)=><div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2 rounded-2xl border border-slate-200 p-3 dark:border-slate-700"><label><span className="label">Principal</span><input aria-label="Horário principal" type="time" className="input" value={s.time} onChange={e=>updateSchedule(i,{time:e.target.value})}/></label><label><span className="label">Limite</span><input aria-label="Horário limite" type="time" className="input" value={s.deadline||''} onChange={e=>updateSchedule(i,{deadline:e.target.value||undefined})}/></label><button type="button" className="btn-secondary self-end" onClick={()=>removeSchedule(i)} disabled={draft.schedules.length===1}>×</button></div>)}</div><button type="button" className="btn-secondary mt-3" onClick={addSchedule}>+ Adicionar horário</button></fieldset>

      <fieldset className="mt-7"><legend className="text-lg font-black">Frequência</legend><label className="mt-3 block"><span className="label">Tipo</span><select className="input" value={draft.frequency.type} onChange={e=>setDraft({...draft,frequency:{...draft.frequency,type:e.target.value as any}})}><option value="daily">Todos os dias</option><option value="weekdays">Dias da semana</option><option value="interval">A cada X dias</option><option value="custom">Somente determinadas datas</option></select></label>
      {draft.frequency.type==='weekdays'&&<div className="mt-3 flex flex-wrap gap-2">{days.map((d,i)=><label key={d} className={`rounded-xl border px-3 py-2 text-sm font-bold ${draft.frequency.weekdays?.includes(i)?'border-sky-500 bg-sky-50 dark:bg-sky-950':'border-slate-200 dark:border-slate-700'}`}><input className="sr-only" type="checkbox" checked={draft.frequency.weekdays?.includes(i)||false} onChange={e=>{const arr=new Set(draft.frequency.weekdays||[]); e.target.checked?arr.add(i):arr.delete(i); setDraft({...draft,frequency:{...draft.frequency,weekdays:[...arr]}})}}/>{d}</label>)}</div>}
      {draft.frequency.type==='interval'&&<label className="mt-3 block"><span className="label">Intervalo em dias</span><input className="input" type="number" min="1" value={draft.frequency.intervalDays||1} onChange={e=>setDraft({...draft,frequency:{...draft.frequency,intervalDays:Number(e.target.value)}})}/></label>}
      {draft.frequency.type==='custom'&&<label className="mt-3 block"><span className="label">Datas (AAAA-MM-DD, separadas por vírgula)</span><textarea className="input min-h-24" value={(draft.frequency.customDates||[]).join(', ')} onChange={e=>setDraft({...draft,frequency:{...draft.frequency,customDates:e.target.value.split(',').map(x=>x.trim()).filter(Boolean)}})}/></label>}
      <div className="mt-3 grid gap-3 sm:grid-cols-2"><label><span className="label">Data inicial</span><input className="input" type="date" value={draft.frequency.startDate||''} onChange={e=>setDraft({...draft,frequency:{...draft.frequency,startDate:e.target.value||undefined}})}/></label><label><span className="label">Data final (opcional)</span><input className="input" type="date" value={draft.frequency.endDate||''} onChange={e=>setDraft({...draft,frequency:{...draft.frequency,endDate:e.target.value||undefined}})}/></label></div></fieldset>

      <fieldset className="mt-7"><legend className="text-lg font-black">Lembretes</legend><div className="mt-3 grid gap-3 sm:grid-cols-2"><label><span className="label">Repetir a cada</span><select className="input" value={draft.reminders.repeatMinutes} onChange={e=>setDraft({...draft,reminders:{...draft.reminders,repeatMinutes:Number(e.target.value)}})}>{[10,15,30,45,60].map(n=><option key={n} value={n}>{n} minutos</option>)}</select></label><div className="space-y-3 pt-1"><label className="flex gap-3 font-bold"><input type="checkbox" checked={draft.reminders.enabled} onChange={e=>setDraft({...draft,reminders:{...draft.reminders,enabled:e.target.checked}})}/> Notificações</label><label className="flex gap-3 font-bold"><input type="checkbox" checked={draft.reminders.sound} onChange={e=>setDraft({...draft,reminders:{...draft.reminders,sound:e.target.checked}})}/> Som quando suportado</label><label className="flex gap-3 font-bold"><input type="checkbox" checked={draft.reminders.required} onChange={e=>setDraft({...draft,reminders:{...draft.reminders,required:e.target.checked}})}/> Obrigatório</label></div></div></fieldset>

      <fieldset className="mt-7 rounded-2xl bg-sky-50 p-4 dark:bg-sky-950/40"><legend className="px-1 text-lg font-black">Caneta / aplicação</legend><label className="flex items-center gap-3 font-bold"><input type="checkbox" checked={draft.applicationRotation?.enabled||false} onChange={e=>setDraft({...draft,applicationRotation:{enabled:e.target.checked,possibleSides:['left','right'],nextSide:draft.applicationRotation?.nextSide||'left',lastUsedSide:draft.applicationRotation?.lastUsedSide}})}/> Alternar lado da aplicação</label>{draft.applicationRotation?.enabled&&<label className="mt-4 block"><span className="label">Próximo lado</span><select className="input" value={draft.applicationRotation.nextSide} onChange={e=>setDraft({...draft,applicationRotation:{...draft.applicationRotation!,nextSide:e.target.value as any}})}><option value="left">Esquerdo</option><option value="right">Direito</option></select><p className="muted mt-2 text-xs">O lado não muda ao virar o dia. Só muda após confirmar a aplicação.</p></label>}</fieldset>

      <button disabled={saving} className="btn-primary mt-7 w-full disabled:opacity-50">{saving?'Salvando…':'Salvar medicamento'}</button>
    </form>
  </div>;
}
