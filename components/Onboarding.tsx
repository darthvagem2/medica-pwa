'use client';

import { useEffect, useState } from 'react';
import { BellRing, Download, Pill, Sparkles } from 'lucide-react';
import { db } from '@/lib/db';
import { subscribeToPush } from '@/lib/reminder-client';

export function Onboarding() {
  const [step, setStep] = useState(0);
  const [message, setMessage] = useState('');
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);

  useEffect(() => {
    const onInstallPrompt = (e: Event) => { e.preventDefault(); setDeferredPrompt(e); };
    window.addEventListener('beforeinstallprompt', onInstallPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onInstallPrompt);
  }, []);

  const steps = [
    { icon: Sparkles, title: 'Bem-vindo ao seu lembrete de medicamentos', text: 'Registre o que foi tomado e acompanhe o dia sem depender da memória.' },
    { icon: BellRing, title: 'Ative notificações', text: 'Para lembretes com o app fechado, instale o PWA e permita notificações. No iPhone, Web Push exige o app adicionado à Tela de Início.' },
    { icon: Pill, title: 'Adicione seu primeiro medicamento', text: 'Você poderá definir horários, prazo limite, repetição e alternância de lado da caneta.' },
    { icon: Download, title: 'Instale como aplicativo', text: 'No iPhone: Safari → Compartilhar → Adicionar à Tela de Início. No iOS 26+, mantenha “Abrir como App” ativado quando a opção aparecer. No Android/desktop, use Instalar quando disponível.' }
  ];
  const CurrentIcon = steps[step].icon;

  async function enableNotifications() {
    setMessage('');
    try { await subscribeToPush(); setMessage('Notificações ativadas.'); }
    catch (e) { setMessage(e instanceof Error ? e.message : 'Não foi possível ativar.'); }
  }

  async function finish() { await db.settings.update('settings', { onboardingDone: true }); }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/60 p-5 backdrop-blur-sm">
      <section className="card w-full max-w-md p-6" role="dialog" aria-modal="true" aria-label="Configuração inicial">
        <div className="mb-5 grid h-14 w-14 place-items-center rounded-2xl bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300"><CurrentIcon /></div>
        <p className="mb-2 text-xs font-black uppercase tracking-[.18em] text-sky-600">Etapa {step + 1} de 4</p>
        <h1 className="text-2xl font-black leading-tight">{steps[step].title}</h1>
        <p className="muted mt-3 leading-relaxed">{steps[step].text}</p>
        {step === 1 && <button className="btn-primary mt-5 w-full" onClick={enableNotifications}>Ativar notificações</button>}
        {step === 3 && deferredPrompt && <button className="btn-primary mt-5 w-full" onClick={() => deferredPrompt.prompt()}>Instalar aplicativo</button>}
        {message && <p className="mt-3 text-sm font-semibold">{message}</p>}
        <div className="mt-7 flex gap-2">
          {step > 0 && <button className="btn-secondary flex-1" onClick={() => setStep(step - 1)}>Voltar</button>}
          {step < 3 ? <button className="btn-primary flex-1" onClick={() => setStep(step + 1)}>Continuar</button> : <button className="btn-primary flex-1" onClick={finish}>Começar</button>}
        </div>
      </section>
    </div>
  );
}
