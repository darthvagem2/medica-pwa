'use client';

import { addDays } from 'date-fns';
import { db } from './db';
import { buildOccurrences, localDateKey } from './domain';
import type { ReminderJobPayload } from './types';

function base64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(char => char.charCodeAt(0)));
}

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  return navigator.serviceWorker.register('/sw.js');
}

export async function subscribeToPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) throw new Error('Web Push não é suportado neste navegador.');
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
  if (isIOS && !isStandalone) throw new Error('No iPhone/iPad, adicione primeiro o site à Tela de Início e abra pelo ícone antes de ativar notificações.');
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!publicKey) throw new Error('NEXT_PUBLIC_VAPID_PUBLIC_KEY não configurada');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Permissão de notificação não concedida');
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64ToUint8Array(publicKey)
  });
  const device = await db.device.get('device');
  if (!device) throw new Error('Dispositivo não inicializado');
  const res = await fetch('/api/push/subscribe', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: device.deviceId, deviceSecret: device.deviceSecret, subscription: subscription.toJSON(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })
  });
  if (!res.ok) throw new Error('Falha ao registrar push');
  await db.device.update('device', { pushSubscribed: true });
  await db.settings.update('settings', { notificationsEnabled: true });
  await syncReminderJobs();
  return subscription;
}

export async function unsubscribeFromPush() {
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  const device = await db.device.get('device');
  if (subscription) await subscription.unsubscribe();
  if (device) {
    await fetch('/api/push/unsubscribe', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: device.deviceId, deviceSecret: device.deviceSecret })
    });
    await db.device.update('device', { pushSubscribed: false });
    await db.settings.update('settings', { notificationsEnabled: false });
  }
}

export async function syncReminderJobs(daysAhead = 60) {
  const [device, medications, logs, settings] = await Promise.all([
    db.device.get('device'), db.medications.toArray(), db.logs.toArray(), db.settings.get('settings')
  ]);
  if (!device?.pushSubscribed) return;

  const jobs: ReminderJobPayload[] = [];
  if (settings?.notificationsEnabled !== false) for (let i = 0; i <= daysAhead; i++) {
    const date = addDays(new Date(), i);
    const occurrences = buildOccurrences(medications, logs, date);
    for (const occurrence of occurrences) {
      if (!occurrence.medication.reminders.enabled || ['taken','skipped','missed'].includes(occurrence.log?.status || '')) continue;
      jobs.push({
        occurrenceId: occurrence.id,
        medicationId: occurrence.medication.id,
        medicationLabel: occurrence.medication.nickname || occurrence.medication.name,
        scheduledAt: occurrence.scheduledAt.toISOString(),
        deadlineAt: occurrence.deadlineAt?.toISOString(),
        repeatMinutes: occurrence.medication.reminders.repeatMinutes,
        sound: occurrence.medication.reminders.sound && (settings?.soundEnabled ?? true),
        vibration: settings?.vibrationEnabled ?? true,
        required: occurrence.medication.reminders.required,
        url: `/?occurrence=${encodeURIComponent(occurrence.id)}`
      });
    }
  }

  await fetch('/api/reminders/sync', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: device.deviceId, deviceSecret: device.deviceSecret, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, quietHours: settings ? { enabled: settings.quietHoursEnabled, start: settings.quietStart, end: settings.quietEnd } : undefined, jobs })
  });
}

export async function cancelOccurrenceReminder(occurrenceId: string) {
  const device = await db.device.get('device');
  if (!device?.pushSubscribed) return;
  await fetch('/api/reminders/cancel', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: device.deviceId, deviceSecret: device.deviceSecret, occurrenceId })
  });
}

export async function testLocalNotification() {
  if (!('Notification' in window)) throw new Error('Notificações não suportadas');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Permissão não concedida');
  const registration = await navigator.serviceWorker.ready;
  await registration.showNotification('Teste do Medicamentos', {
    body: 'As notificações estão funcionando neste dispositivo.',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    tag: 'medica-test'
  });
}
