'use client';

import { addDays } from 'date-fns';
import { db } from './db';
import { buildOccurrences } from './domain';
import type { ReminderJobPayload } from './types';

/**
 * O Service Worker é registrado no início do app pelo AppBootstrap.
 *
 * No iPhone/iPad, PushManager.subscribe() precisa acontecer diretamente
 * a partir do gesto do usuário. Por isso guardamos o registration aqui
 * antecipadamente e NÃO esperamos navigator.serviceWorker.ready
 * antes de subscribe().
 */
let cachedServiceWorkerRegistration: ServiceWorkerRegistration | null = null;

/**
 * Converte a chave VAPID pública Base64URL para Uint8Array.
 */
function base64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);

  const base64 = (base64String + padding)
    .replace(/-/g, '+')
    .replace(/_/g, '/');

  const rawData = atob(base64);

  const output = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; i++) {
    output[i] = rawData.charCodeAt(i);
  }

  return output;
}

/**
 * Tenta extrair uma mensagem útil de uma resposta HTTP com erro.
 */
async function getResponseError(
  response: Response,
  fallback: string
): Promise<string> {
  try {
    const text = await response.text();

    if (!text) {
      return `${fallback} (${response.status})`;
    }

    try {
      const json = JSON.parse(text);

      if (typeof json?.error === 'string') {
        return `${fallback} (${response.status}): ${json.error}`;
      }

      if (typeof json?.message === 'string') {
        return `${fallback} (${response.status}): ${json.message}`;
      }
    } catch {
      // Não era JSON.
    }

    return `${fallback} (${response.status}): ${text}`;
  } catch {
    return `${fallback} (${response.status})`;
  }
}

/**
 * Detecta se o PWA está aberto em modo standalone.
 */
function isStandalonePWA(): boolean {
  if (typeof window === 'undefined') return false;

  const displayModeStandalone =
    window.matchMedia?.('(display-mode: standalone)').matches ?? false;

  const iosStandalone = Boolean(
    (navigator as Navigator & { standalone?: boolean }).standalone
  );

  return displayModeStandalone || iosStandalone;
}

/**
 * Registra e guarda o Service Worker.
 *
 * Deve ser chamada pelo bootstrap da aplicação o mais cedo possível.
 */
export async function registerServiceWorker() {
  if (
    typeof window === 'undefined' ||
    !('serviceWorker' in navigator)
  ) {
    return null;
  }

  try {
    const registration = await navigator.serviceWorker.register('/sw.js', {
      scope: '/',
      updateViaCache: 'none',
    });

    cachedServiceWorkerRegistration = registration;

    // Solicita atualização do SW sem impedir o funcionamento.
    registration.update().catch(() => undefined);

    return registration;
  } catch (error) {
    console.error('[PWA] Falha ao registrar Service Worker:', error);
    cachedServiceWorkerRegistration = null;
    throw error;
  }
}

/**
 * Retorna o SW previamente registrado.
 *
 * Esta função pode esperar pelo SW em operações comuns,
 * mas NÃO deve ser utilizada antes de pushManager.subscribe()
 * no clique de ativação de Push no iOS.
 */
async function getServiceWorkerRegistration() {
  if (cachedServiceWorkerRegistration) {
    return cachedServiceWorkerRegistration;
  }

  if (!('serviceWorker' in navigator)) {
    throw new Error('Service Worker não é suportado neste dispositivo.');
  }

  const registration =
    (await navigator.serviceWorker.getRegistration('/')) ??
    (await navigator.serviceWorker.ready);

  if (!registration) {
    throw new Error('Service Worker não encontrado.');
  }

  cachedServiceWorkerRegistration = registration;

  return registration;
}

/**
 * Ativa Web Push neste dispositivo.
 *
 * IMPORTANTE PARA iPHONE:
 * Não inserir nenhum "await" antes de registration.pushManager.subscribe()
 * quando uma nova inscrição precisa ser solicitada.
 */
export async function subscribeToPush() {
  if (typeof window === 'undefined') {
    throw new Error('Notificações só podem ser ativadas no navegador.');
  }

  if (!('serviceWorker' in navigator)) {
    throw new Error('Service Worker não é suportado neste dispositivo.');
  }

  if (!('PushManager' in window)) {
    throw new Error('Web Push não é suportado neste navegador.');
  }

  if (!('Notification' in window)) {
    throw new Error('Notificações não são suportadas neste navegador.');
  }

  /**
   * No iPhone/iPad o Web Push tradicional precisa do web app
   * instalado na Tela de Início.
   */
  const isAppleMobile =
    /iPhone|iPad|iPod/i.test(navigator.userAgent);

  if (isAppleMobile && !isStandalonePWA()) {
    throw new Error(
      'No iPhone/iPad, abra este aplicativo pelo ícone adicionado à Tela de Início para ativar notificações.'
    );
  }

  if (Notification.permission === 'denied') {
    throw new Error(
      'As notificações estão bloqueadas. Abra os Ajustes do iPhone e permita notificações para este aplicativo.'
    );
  }

  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim();

  if (!publicKey) {
    throw new Error(
      'NEXT_PUBLIC_VAPID_PUBLIC_KEY não está configurada.'
    );
  }

  /**
   * MUITO IMPORTANTE:
   *
   * Não usamos:
   *
   * await Notification.requestPermission()
   * await navigator.serviceWorker.ready
   * await pushManager.getSubscription()
   *
   * antes deste ponto.
   *
   * Safari/WebKit exige que a solicitação de Push esteja diretamente
   * associada ao gesto do usuário.
   */
  const registration = cachedServiceWorkerRegistration;

  if (!registration) {
    throw new Error(
      'O sistema de notificações ainda está inicializando. Feche o aplicativo, abra novamente pelo ícone da Tela de Início e tente outra vez.'
    );
  }

  let subscription: PushSubscription;

  try {
    /**
     * subscribe() também retorna a inscrição existente quando apropriado.
     * Portanto não precisamos fazer getSubscription() antes e perder
     * o gesto do usuário.
     */
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey:
        base64ToUint8Array(publicKey) as BufferSource,
    });
  } catch (error) {
    console.error('[Push] Falha no pushManager.subscribe():', error);

    if (error instanceof DOMException) {
      if (error.name === 'NotAllowedError') {
        throw new Error(
          'O iPhone não autorizou as notificações. Verifique Ajustes → Notificações e tente novamente.'
        );
      }

      if (error.name === 'InvalidStateError') {
        throw new Error(
          'Existe uma inscrição Push incompatível com a chave VAPID atual. Remova o aplicativo da Tela de Início, instale novamente e tente ativar as notificações.'
        );
      }

      throw new Error(
        `Falha ao criar inscrição Push: ${error.name} — ${error.message}`
      );
    }

    throw error;
  }

  /**
   * Daqui para baixo o usuário já possui PushSubscription,
   * portanto podemos fazer awaits normalmente.
   */
  const device = await db.device.get('device');

  if (!device) {
    // Evita deixar uma subscription órfã.
    await subscription.unsubscribe().catch(() => undefined);

    throw new Error(
      'Dispositivo não inicializado. Feche e abra o aplicativo e tente novamente.'
    );
  }

  const timezone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  const response = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    cache: 'no-store',
    body: JSON.stringify({
      deviceId: device.deviceId,
      deviceSecret: device.deviceSecret,
      subscription: subscription.toJSON(),
      timezone,
    }),
  });

  if (!response.ok) {
    const message = await getResponseError(
      response,
      'Falha ao registrar o dispositivo no servidor'
    );

    console.error('[Push]', message);

    throw new Error(message);
  }

  await Promise.all([
    db.device.update('device', {
      pushSubscribed: true,
    }),

    db.settings.update('settings', {
      notificationsEnabled: true,
    }),
  ]);

  /**
   * Agora que o dispositivo realmente existe em push_devices,
   * cria/sincroniza a fila dos medicamentos.
   */
  await syncReminderJobs();

  return subscription;
}

/**
 * Desativa Push no aparelho e no backend.
 */
export async function unsubscribeFromPush() {
  if (
    typeof window === 'undefined' ||
    !('serviceWorker' in navigator)
  ) {
    return;
  }

  const registration = await getServiceWorkerRegistration();

  const subscription =
    await registration.pushManager.getSubscription();

  const device = await db.device.get('device');

  if (subscription) {
    await subscription.unsubscribe();
  }

  if (device) {
    const response = await fetch('/api/push/unsubscribe', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      cache: 'no-store',
      body: JSON.stringify({
        deviceId: device.deviceId,
        deviceSecret: device.deviceSecret,
      }),
    });

    if (!response.ok) {
      throw new Error(
        await getResponseError(
          response,
          'Falha ao desativar Push no servidor'
        )
      );
    }

    await Promise.all([
      db.device.update('device', {
        pushSubscribed: false,
      }),

      db.settings.update('settings', {
        notificationsEnabled: false,
      }),
    ]);
  }
}

/**
 * Envia ao backend todas as ocorrências futuras que precisam
 * de notificações.
 */
export async function syncReminderJobs(daysAhead = 60) {
  const [device, medications, logs, settings] = await Promise.all([
    db.device.get('device'),
    db.medications.toArray(),
    db.logs.toArray(),
    db.settings.get('settings'),
  ]);

  /**
   * Sem uma inscrição Push válida, não há o que agendar
   * no servidor.
   */
  if (!device?.pushSubscribed) {
    console.info(
      '[Reminders] Push ainda não inscrito. Sincronização ignorada.'
    );

    return {
      skipped: true,
      reason: 'push-not-subscribed',
    };
  }

  const jobs: ReminderJobPayload[] = [];

  const notificationsEnabled =
    settings?.notificationsEnabled !== false;

  if (notificationsEnabled) {
    for (let i = 0; i <= daysAhead; i++) {
      const date = addDays(new Date(), i);

      const occurrences = buildOccurrences(
        medications,
        logs,
        date
      );

      for (const occurrence of occurrences) {
        const medication = occurrence.medication;

        if (!medication.enabled) {
          continue;
        }

        if (!medication.reminders.enabled) {
          continue;
        }

        const existingStatus =
          occurrence.log?.status ?? '';

        if (
          ['taken', 'skipped', 'missed'].includes(existingStatus)
        ) {
          continue;
        }

        jobs.push({
          occurrenceId: occurrence.id,
          medicationId: medication.id,

          medicationLabel:
            medication.nickname ||
            medication.name,

          scheduledAt:
            occurrence.scheduledAt.toISOString(),

          deadlineAt:
            occurrence.deadlineAt?.toISOString(),

          repeatMinutes:
            medication.reminders.repeatMinutes,

          sound:
            medication.reminders.sound &&
            (settings?.soundEnabled ?? true),

          vibration:
            settings?.vibrationEnabled ?? true,

          required:
            medication.reminders.required,

          url:
            `/?occurrence=${encodeURIComponent(
              occurrence.id
            )}`,
        });
      }
    }
  }

  const timezone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  const response = await fetch('/api/reminders/sync', {
    method: 'POST',

    headers: {
      'content-type': 'application/json',
    },

    cache: 'no-store',

    body: JSON.stringify({
      deviceId: device.deviceId,
      deviceSecret: device.deviceSecret,

      timezone,

      quietHours: settings
        ? {
            enabled:
              settings.quietHoursEnabled,

            start:
              settings.quietStart,

            end:
              settings.quietEnd,
          }
        : undefined,

      jobs,
    }),
  });

  if (!response.ok) {
    const message = await getResponseError(
      response,
      'Falha ao sincronizar lembretes'
    );

    console.error('[Reminders]', message);

    throw new Error(message);
  }

  let result: unknown = null;

  try {
    result = await response.json();
  } catch {
    // O endpoint pode responder sem JSON.
  }

  console.info(
    `[Reminders] ${jobs.length} ocorrência(s) sincronizada(s).`,
    result
  );

  return {
    skipped: false,
    jobs: jobs.length,
    result,
  };
}

/**
 * Cancela futuras notificações de uma ocorrência depois que
 * ela foi marcada como tomada/ignorada.
 */
export async function cancelOccurrenceReminder(
  occurrenceId: string
) {
  const device = await db.device.get('device');

  if (!device?.pushSubscribed) {
    return;
  }

  const response = await fetch('/api/reminders/cancel', {
    method: 'POST',

    headers: {
      'content-type': 'application/json',
    },

    cache: 'no-store',

    body: JSON.stringify({
      deviceId: device.deviceId,
      deviceSecret: device.deviceSecret,
      occurrenceId,
    }),
  });

  if (!response.ok) {
    throw new Error(
      await getResponseError(
        response,
        'Falha ao cancelar lembrete'
      )
    );
  }
}

/**
 * Notificação local apenas para testar Notification API e
 * Service Worker.
 *
 * ATENÇÃO:
 * Isso NÃO testa o backend Web Push.
 */
export async function testLocalNotification() {
  if (typeof window === 'undefined') {
    throw new Error(
      'Notificações só podem ser testadas no navegador.'
    );
  }

  if (!('Notification' in window)) {
    throw new Error(
      'Notificações não são suportadas neste dispositivo.'
    );
  }

  if (!('serviceWorker' in navigator)) {
    throw new Error(
      'Service Worker não é suportado neste dispositivo.'
    );
  }

  let permission = Notification.permission;

  if (permission === 'default') {
    permission =
      await Notification.requestPermission();
  }

  if (permission !== 'granted') {
    throw new Error(
      'Permissão de notificações não concedida.'
    );
  }

  const registration =
    await getServiceWorkerRegistration();

  await registration.showNotification(
    'Teste do Medicamentos',
    {
      body:
        'As notificações locais estão funcionando neste dispositivo.',

      icon:
        '/icons/icon-192.png',

      badge:
        '/icons/badge-96.png',

      tag:
        'medica-test',
    }
  );
}
