'use client';

import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { addDays, eachDayOfInterval, endOfMonth, format, startOfMonth, subDays } from 'date-fns';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { db } from '@/lib/db';
import { ensureLogsForDates } from '@/lib/local-actions';
import { combineLocalDateTime, minutesLate } from '@/lib/domain';

function sideText(s?:string){return s==='left'?'Esquerdo':s==='right'?'Direito':'—'}
function statusText(s:string){return s==='taken'?'✓ Tomado':s==='skipped'?'Ignorado':s==='missed'?'✕ Não tomado':s==='late'?'⚠ Atrasado':'Pendente'}

export default function HistoryPage(){
  const medications=useLiveQuery(()=>db.medications.toArray(),[])||[];
  const allLogs=useLiveQuery(()=>db.logs.orderBy('scheduledDate').reverse().toArray(),[])||[];
  const [filter,setFilter]=useState<'today'|'7'|'30'|'month'>('7');
  const [month,setMonth]=useState(()=>new Date());
  const [selectedDate,setSelectedDate]=useState<string|null>(null);

  const range=useMemo(()=>{const now=new Date(); if(filter==='today')return [now]; if(filter==='7')return eachDayOfInterval({start:subDays(now,6),end:now}); if(filter==='30')return eachDayOfInterval({start:subDays(now,29),end:now}); return eachDayOfInterval({start:startOfMonth(month),end:endOfMonth(month)});},[filter,month]);
  useEffect(()=>{if(medications.length) ensureLogsForDates(medications,range).catch(()=>undefined)},[medications.length,filter,month]);
  const keys=new Set(range.map(d=>format(d,'yyyy-MM-dd')));
  const logs=allLogs.filter(l=>keys.has(l.scheduledDate) && (!selectedDate||l.scheduledDate===selectedDate));
  const monthDays=eachDayOfInterval({start:startOfMonth(month),end:endOfMonth(month)});
  const dayState=(key:string)=>{if(key>format(new Date(),'yyyy-MM-dd'))return 'empty';const ls=allLogs.filter(l=>l.scheduledDate===key); if(!ls.length)return 'empty'; if(ls.every(l=>l.status==='taken'))return 'ok'; if(ls.some(l=>l.status==='missed'))return 'bad'; return 'warn'};

  return <div><header className="mb-5"><p className="muted text-sm font-bold">Registros reais</p><h1 className="text-3xl font-black">Histórico</h1></header>
  <div className="mb-5 flex gap-2 overflow-x-auto pb-1">{[['today','Hoje'],['7','7 dias'],['30','30 dias'],['month','Calendário']] .map(([k,l])=><button key={k} onClick={()=>{setFilter(k as any);setSelectedDate(null)}} className={`whitespace-nowrap rounded-xl px-4 py-2 text-sm font-black ${filter===k?'bg-sky-600 text-white':'border border-slate-200 dark:border-slate-700'}`}>{l}</button>)}</div>
  {filter==='month'&&<section className="card mb-5 p-4"><div className="mb-4 flex items-center justify-between"><button className="btn-secondary" onClick={()=>setMonth(addDays(startOfMonth(month),-1))}><ChevronLeft size={18}/></button><h2 className="font-black capitalize">{new Intl.DateTimeFormat('pt-BR',{month:'long',year:'numeric'}).format(month)}</h2><button className="btn-secondary" onClick={()=>setMonth(addDays(endOfMonth(month),1))}><ChevronRight size={18}/></button></div><div className="grid grid-cols-7 gap-1 text-center text-xs font-black muted">{['D','S','T','Q','Q','S','S'].map((x,i)=><span key={i}>{x}</span>)}</div><div className="mt-2 grid grid-cols-7 gap-1">{Array(startOfMonth(month).getDay()).fill(0).map((_,i)=><span key={`e${i}`}/>) }{monthDays.map(d=>{const key=format(d,'yyyy-MM-dd');const state=dayState(key); return <button aria-label={`Abrir ${key}`} key={key} onClick={()=>setSelectedDate(key)} className={`aspect-square rounded-xl text-sm font-black ${selectedDate===key?'ring-2 ring-sky-500':''} ${state==='ok'?'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300':state==='bad'?'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300':state==='warn'?'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300':'bg-slate-50 dark:bg-slate-900'}`}>{d.getDate()}<span className="block text-[10px]">{state==='ok'?'✓':state==='bad'?'✕':state==='warn'?'⚠':''}</span></button>})}</div><p className="muted mt-4 text-xs">✓ todos tomados · ⚠ pendência/atraso · ✕ algum não tomado</p></section>}
  <div className="space-y-3">{logs.map(log=>{const scheduledAt=combineLocalDateTime(log.scheduledDate,log.scheduledTime);const delay=log.status==='taken'?minutesLate(scheduledAt,log.takenAt):minutesLate(scheduledAt); return <article className="card p-4" key={log.id}><div className="flex justify-between gap-3"><div><p className="text-xs font-black muted">{new Date(log.scheduledDate+'T12:00:00').toLocaleDateString('pt-BR')}</p><h2 className="mt-1 font-black">{log.medicationName}</h2><p className="muted mt-1 text-sm">{log.dosage} {log.unit}</p></div><span className="text-sm font-black">{statusText(log.status)}</span></div><div className="mt-3 grid grid-cols-2 gap-2 text-sm"><div className="rounded-xl bg-slate-50 p-2 dark:bg-slate-900"><span className="muted">Previsto</span><br/><b>{log.scheduledTime}</b></div><div className="rounded-xl bg-slate-50 p-2 dark:bg-slate-900"><span className="muted">Tomado</span><br/><b>{log.takenAt?new Date(log.takenAt).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}):'—'}</b></div>{delay>0&&<div className="rounded-xl bg-slate-50 p-2 dark:bg-slate-900"><span className="muted">Atraso</span><br/><b>+{Math.floor(delay/60)}h{String(delay%60).padStart(2,'0')}</b></div>}{log.applicationSide&&<div className="rounded-xl bg-slate-50 p-2 dark:bg-slate-900"><span className="muted">Local</span><br/><b>{sideText(log.applicationSide)}</b></div>}</div></article>})}</div>{!logs.length&&<div className="card p-6 text-center font-bold">Nenhum registro neste período.</div>}</div>
}
