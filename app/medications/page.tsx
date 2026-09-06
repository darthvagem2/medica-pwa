'use client';

import { Suspense } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useSearchParams, useRouter } from 'next/navigation';
import { Copy, Pencil, Plus, Power, Trash2 } from 'lucide-react';
import { db } from '@/lib/db';
import { deleteMedication, duplicateMedication, updateMedication } from '@/lib/local-actions';
import { MedicationForm } from '@/components/MedicationForm';
import { syncReminderJobs } from '@/lib/reminder-client';

function MedicationsInner() {
  const meds = useLiveQuery(()=>db.medications.orderBy('updatedAt').reverse().toArray(),[])||[];
  const params = useSearchParams(); const router = useRouter();
  const editId = params.get('edit'); const adding = params.get('new')==='1';
  const editing = meds.find(m=>m.id===editId);
  const close = ()=>router.replace('/medications');

  async function remove(id:string) { if (!confirm('Remover este medicamento? O histórico já registrado será mantido.')) return; await deleteMedication(id); await syncReminderJobs().catch(()=>undefined); }
  async function toggle(id:string,enabled:boolean) { await updateMedication(id,{enabled}); await syncReminderJobs().catch(()=>undefined); }
  async function duplicate(id:string) { await duplicateMedication(id); await syncReminderJobs().catch(()=>undefined); }

  return <div><header className="mb-5 flex items-end justify-between gap-3"><div><p className="muted text-sm font-bold">Gerenciamento</p><h1 className="text-3xl font-black">Medicamentos</h1></div><button onClick={()=>router.push('/medications?new=1')} className="btn-primary flex items-center gap-2"><Plus size={18}/> Adicionar</button></header>
  <div className="space-y-3">{meds.map(m=><article key={m.id} className={`card p-4 ${!m.enabled?'opacity-60':''}`}><div className="flex items-start justify-between gap-3"><div><h2 className="text-lg font-black">{m.nickname||m.name}</h2><p className="muted mt-1 text-sm">{m.dosage} {m.unit} · {m.schedules.map(s=>s.time).join(', ')}</p><p className="muted mt-1 text-xs font-bold">{m.frequency.type==='daily'?'Todos os dias':m.frequency.type==='weekdays'?'Dias da semana':m.frequency.type==='interval'?`A cada ${m.frequency.intervalDays||1} dias`:'Datas específicas'}{m.applicationRotation?.enabled?' · Caneta com alternância':''}</p></div><span className={`status-pill ${m.enabled?'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300':'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}`}>{m.enabled?'Ativo':'Desativado'}</span></div><div className="mt-4 grid grid-cols-4 gap-2"><button className="btn-secondary grid place-items-center" aria-label="Editar" onClick={()=>router.push(`/medications?edit=${m.id}`)}><Pencil size={18}/></button><button className="btn-secondary grid place-items-center" aria-label="Duplicar" onClick={()=>duplicate(m.id)}><Copy size={18}/></button><button className="btn-secondary grid place-items-center" aria-label={m.enabled?'Desativar':'Ativar'} onClick={()=>toggle(m.id,!m.enabled)}><Power size={18}/></button><button className="btn-secondary grid place-items-center text-rose-600" aria-label="Excluir" onClick={()=>remove(m.id)}><Trash2 size={18}/></button></div></article>)}</div>
  {!meds.length&&<div className="card p-7 text-center"><p className="font-black">Nenhum medicamento cadastrado.</p><button className="btn-primary mt-4" onClick={()=>router.push('/medications?new=1')}>Adicionar o primeiro</button></div>}
  {(adding||editing)&&<MedicationForm medication={editing} onClose={close}/>}</div>;
}

export default function MedicationsPage(){
  return <Suspense fallback={<div className="card p-6 font-bold">Carregando medicamentos…</div>}><MedicationsInner/></Suspense>;
}
