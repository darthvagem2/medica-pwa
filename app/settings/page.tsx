'use client';

import { useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Bell, Download, Moon, ShieldAlert, Upload } from 'lucide-react';
import { db, defaultSettings } from '@/lib/db';
import { subscribeToPush, testLocalNotification, unsubscribeFromPush } from '@/lib/reminder-client';

export default function SettingsPage(){
  const settings=useLiveQuery(()=>db.settings.get('settings'));
  const device=useLiveQuery(()=>db.device.get('device'));
  const fileRef=useRef<HTMLInputElement>(null);
  const [msg,setMsg]=useState('');
  if(!settings)return null;
  const patch=(p:any)=>db.settings.update('settings',p);

  async function enablePush(){setMsg('');try{await subscribeToPush();setMsg('Notificações push ativadas neste dispositivo.')}catch(e){setMsg(e instanceof Error?e.message:'Falha ao ativar notificações.')}}
  async function disablePush(){await unsubscribeFromPush();setMsg('Notificações push desativadas neste dispositivo.')}
  async function test(){setMsg('');try{await testLocalNotification();setMsg('Notificação de teste enviada.')}catch(e){setMsg(e instanceof Error?e.message:'Falha no teste.')}}
  async function exportBackup(){const data={version:1,exportedAt:new Date().toISOString(),medications:await db.medications.toArray(),logs:await db.logs.toArray(),settings:await db.settings.get('settings')};const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`medicamentos-backup-${new Date().toLocaleDateString('sv-SE')}.json`;a.click();URL.revokeObjectURL(a.href)}
  async function importBackup(file?:File){if(!file)return;try{const data=JSON.parse(await file.text());if(!Array.isArray(data.medications)||!Array.isArray(data.logs))throw new Error('Backup inválido');await db.transaction('rw',db.medications,db.logs,db.settings,async()=>{await db.medications.clear();await db.logs.clear();await db.medications.bulkPut(data.medications);await db.logs.bulkPut(data.logs);if(data.settings)await db.settings.put({...defaultSettings,...data.settings,id:'settings'});});setMsg('Backup importado.');}catch(e){setMsg(e instanceof Error?e.message:'Não foi possível importar.')}}
  async function clearHistory(){if(confirm('Apagar todo o histórico? Esta ação não remove os medicamentos cadastrados.')){await db.logs.clear();setMsg('Histórico apagado.')}}
  async function reset(){if(confirm('Restaurar as configurações padrão?')){await db.settings.put({...defaultSettings,onboardingDone:true});setMsg('Configurações restauradas.')}}

  return <div><header className="mb-5"><p className="muted text-sm font-bold">Preferências do aplicativo</p><h1 className="text-3xl font-black">Configurações</h1></header>
  <section className="card mb-4 p-5"><h2 className="flex items-center gap-2 text-lg font-black"><Bell size={20}/> Notificações</h2><p className="muted mt-2 text-sm">Para lembretes confiáveis com o PWA fechado, use Web Push. No iPhone/iPad, instale primeiro na Tela de Início e conceda a permissão ao aplicativo instalado.</p><div className="mt-4 grid gap-2 sm:grid-cols-2"><button className="btn-primary" onClick={enablePush}>Solicitar / ativar permissão</button><button className="btn-secondary" onClick={test}>Testar notificação</button>{device?.pushSubscribed&&<button className="btn-secondary sm:col-span-2" onClick={disablePush}>Desativar push neste dispositivo</button>}</div><div className="mt-5 grid gap-3 sm:grid-cols-2"><label className="flex gap-3 font-bold"><input type="checkbox" checked={settings.soundEnabled} onChange={e=>patch({soundEnabled:e.target.checked})}/> Som, quando suportado</label><label className="flex gap-3 font-bold"><input type="checkbox" checked={settings.vibrationEnabled} onChange={e=>patch({vibrationEnabled:e.target.checked})}/> Vibração, quando suportada</label><label><span className="label">Intervalo padrão</span><select className="input" value={settings.repeatMinutes} onChange={e=>patch({repeatMinutes:Number(e.target.value)})}>{[10,15,30,45,60].map(n=><option value={n} key={n}>{n} minutos</option>)}</select></label><div><label className="flex gap-3 font-bold"><input type="checkbox" checked={settings.quietHoursEnabled} onChange={e=>patch({quietHoursEnabled:e.target.checked})}/> Horário silencioso</label>{settings.quietHoursEnabled&&<div className="mt-2 grid grid-cols-2 gap-2"><input aria-label="Início do silêncio" className="input" type="time" value={settings.quietStart} onChange={e=>patch({quietStart:e.target.value})}/><input aria-label="Fim do silêncio" className="input" type="time" value={settings.quietEnd} onChange={e=>patch({quietEnd:e.target.value})}/></div>}</div></div></section>

  <section className="card mb-4 p-5"><h2 className="flex items-center gap-2 text-lg font-black"><Moon size={20}/> Aparência</h2><div className="mt-4 grid grid-cols-3 gap-2">{[['system','Automático'],['light','Claro'],['dark','Escuro']].map(([v,l])=><button className={`rounded-xl border px-2 py-3 text-sm font-black ${settings.theme===v?'border-sky-500 bg-sky-50 dark:bg-sky-950':'border-slate-200 dark:border-slate-700'}`} onClick={()=>patch({theme:v})} key={v}>{l}</button>)}</div></section>

  <section className="card mb-4 p-5"><h2 className="flex items-center gap-2 text-lg font-black"><Download size={20}/> Dados e backup</h2><div className="mt-4 grid gap-2 sm:grid-cols-2"><button className="btn-secondary flex items-center justify-center gap-2" onClick={exportBackup}><Download size={17}/> Exportar backup</button><button className="btn-secondary flex items-center justify-center gap-2" onClick={()=>fileRef.current?.click()}><Upload size={17}/> Importar backup</button><input ref={fileRef} type="file" className="hidden" accept="application/json" onChange={e=>importBackup(e.target.files?.[0])}/><button className="btn-secondary text-rose-600" onClick={clearHistory}>Apagar histórico</button><button className="btn-secondary" onClick={reset}>Restaurar configurações</button></div></section>

  <section className="card p-5"><h2 className="flex items-center gap-2 text-lg font-black"><ShieldAlert size={20}/> Sobre e segurança</h2><p className="muted mt-3 text-sm leading-relaxed">Este aplicativo é uma ferramenta de organização e lembrete e não substitui orientação médica. Ele não altera automaticamente dose, frequência ou tratamento.</p><p className="muted mt-3 text-sm">Instalação no iPhone: Safari → Compartilhar → Adicionar à Tela de Início. Android/desktop: use a opção “Instalar aplicativo” do navegador quando disponível.</p></section>
  {msg&&<div className="fixed bottom-24 left-1/2 z-50 w-[calc(100%-32px)] max-w-xl -translate-x-1/2 rounded-2xl bg-slate-900 p-4 text-center text-sm font-bold text-white shadow-xl dark:bg-white dark:text-slate-900">{msg}</div>}</div>
}
