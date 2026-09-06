'use client';

import { addDays } from 'date-fns';

import { db } from './db';
import { buildOccurrences } from './domain';
import type { ReminderJobPayload } from './types';

/**
 * Mantemos o ServiceWorkerRegistration em memória para que,
 * principalmente no iPhone/iPad, o pushManager.subscribe()
 * possa ser chamado diretamente a partir do toque do usuário.
 */
let cachedServiceWorkerRegistration: ServiceWorkerRegistration | null = null;

/**
 * Converte uma chave Base64 URL-safe para Uint8Array.
 * Necessário para applicationServerKey do Web Push.
 */
function base64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);

  const base64 = (base64String + padding)
    .replace(/-/g, '+')
    .replace(/_/g, '/');

  const rawData = window.atob(base64);

  return Uint8Array.from(
    Array.from(rawData).map((char) => char.charCodeAt(0))
  );
}

/**
 * Extrai uma mensagem de erro útil de uma resposta HTTP.
 */
async function parseApiError(
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

      const error =
        typeof json?.error === 'string'
          ? json.error
          : fallback;

      const detail =
        typeof json?.detail === 'string'
          ? json.detail
          : '';

      const stage =
        typeof json?.stage === 'string'
          ? json.stage
          : '';

      let message = error;

      if (stage) {
        message += ` [${stage}]`;
      }

      if (detail) {
        message += ` — ${detail}`;
      }

      return message;
    } catch {
      return `${fallback}: ${text}`;
    }
  } catch {
    return `${fallback} (${response.status})`;
  }
}

/**
 * Detecta se o aplicativo está instalado/aberto como PWA.
 */
function isStandalone(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const displayMode =
    window.matchMedia?.('(display-mode: standalone)').matches ?? false;

  const iosStandalone = Boolean(
    (navigator as Navigator & { standalone?: boolean }).standalone
  );

  return displayMode || iosStandalone;
}

/**
 * Registra o Service Worker.
 *
 * O AppBootstrap deve chamar esta função assim que o app carregar,
 * antes do usuário tocar em "Ativar notificações".
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
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

    // Atualiza em segundo plano.
    registration.update().catch(() => undefined);

    return registration;
  } catch (error) {
    cachedServiceWorkerRegistration = null;

    console.error(
      '[ServiceWorker] Falha ao registrar Service Worker:',
      error
    );

    throw error;
  }
}

/**
 * Obtém o Service Worker para operações que NÃO dependem
 * diretamente do gesto do usuário.
 */
async function getServiceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  if (cachedServiceWorkerRegistration) {
    return cachedServiceWorkerRegistration;
  }

  if (!('serviceWorker' in navigator)) {
    throw new Error(
      'Service Worker não é suportado neste dispositivo.'
    );
  }

  let registration =
    await navigator.serviceWorker.getRegistration('/');

  if (!registration) {
    registration = await navigator.serviceWorker.ready;
  }

  cachedServiceWorkerRegistration = registration;

  return registration;
}

/**
 * Ativa Web Push neste dispositivo.
 *
 * IMPORTANTE:
 * no iPhone/iPad, pushManager.subscribe() deve continuar
 * diretamente ligado ao toque do usuário.
 *
 * Portanto não fazemos awaits de banco, fetch,
 * navigator.serviceWorker.ready etc. antes de subscribe().
 */
export async function subscribeToPush(): Promise<PushSubscription> {
  if (typeof window === 'undefined') {
    throw new Error(
      'As notificações só podem ser ativadas no navegador.'
    );
  }

  if (!('serviceWorker' in navigator)) {
    throw new Error(
      'Service Worker não é suportado neste dispositivo.'
    );
  }

  if (!('PushManager' in window)) {
    throw new Error(
      'Web Push não é suportado neste navegador.'
    );
  }

  if (!('Notification' in window)) {
    throw new Error(
      'A API de notificações não é suportada neste dispositivo.'
    );
  }

  const isIOS =
    /iPhone|iPad|iPod/i.test(navigator.userAgent);

  if (isIOS && !isStandalone()) {
    throw new Error(
      'No iPhone/iPad, adicione o site à Tela de Início e abra o aplicativo pelo ícone antes de ativar notificações.'
    );
  }

  if (Notification.permission === 'denied') {
    throw new Error(
      'As notificações estão bloqueadas neste dispositivo. Verifique os Ajustes do iPhone.'
    );
  }

  const publicKey =
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim();

  if (!publicKey) {
    throw new Error(
      'NEXT_PUBLIC_VAPID_PUBLIC_KEY não está configurada.'
    );
  }

  /**
   * Muito importante:
   * cachedServiceWorkerRegistration deve ter sido preenchido
   * anteriormente pelo AppBootstrap.
   */
  const registration = cachedServiceWorkerRegistration;

  if (!registration) {
    throw new Error(
      'O sistema de notificações ainda está inicializando. Feche o aplicativo, abra novamente pelo ícone da Tela de Início e tente novamente.'
    );
  }

  let subscription: PushSubscription;

  try {
    /**
     * Não fazemos nenhum await antes desta chamada.
     *
     * Isso ajuda a preservar o gesto do usuário,
     * especialmente no Safari/iOS.
     */
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey:
        base64ToUint8Array(publicKey) as BufferSource,
    });
  } catch (error) {
    console.error(
      '[Push] pushManager.subscribe() falhou:',
      error
    );

    if (error instanceof DOMException) {
      if (error.name === 'NotAllowedError') {
        throw new Error(
          'O sistema não autorizou as notificações. Verifique Ajustes → Notificações e tente novamente.'
        );
      }

      if (error.name === 'InvalidStateError') {
        throw new Error(
          'Existe uma inscrição de notificações incompatível com a chave VAPID atual. Remova o aplicativo da Tela de Início, instale novamente e tente outra vez.'
        );
      }

      if (error.name === 'AbortError') {
        throw new Error(
          'A criação da inscrição Push foi interrompida. Feche e abra o aplicativo e tente novamente.'
        );
      }

      throw new Error(
        `Erro ao ativar Web Push: ${error.name} — ${error.message}`
      );
    }

    if (error instanceof Error) {
      throw error;
    }

    throw new Error(
      'Não foi possível criar a inscrição Web Push.'
    );
  }

  /**
   * Daqui para baixo a inscrição já foi criada.
   * Agora podemos usar awaits normalmente.
   */
  const device = await db.device.get('device');

  if (!device) {
    await subscription.unsubscribe().catch(() => undefined);

    throw new Error(
      'O dispositivo ainda não foi inicializado. Feche e abra o aplicativo e tente novamente.'
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
    const message = await parseApiError(
      response,
      `Falha ao registrar este dispositivo no servidor (${response.status})`
    );

    console.error('[Push]', message);

    throw new Error(message);
  }

  /**
   * Só marcamos pushSubscribed=true depois de o backend
   * realmente confirmar que gravou a inscrição.
   */
  await db.device.update('device', {
    pushSubscribed: true,
  });

  await db.settings.update('settings', {
    notificationsEnabled: true,
  });

  /**
   * Depois que push_devices existe no servidor,
   * sincronizamos os medicamentos e criamos reminder_jobs.
   */
  await syncReminderJobs();

  return subscription;
}

/**
 * Desativa Web Push.
 */
export async function unsubscribeFromPush(): Promise<void> {
  if (
    typeof window === 'undefined' ||
    !('serviceWorker' in navigator)
  ) {
    return;
  }

  const registration =
    await getServiceWorkerRegistration();

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
        await parseApiError(
          response,
          'Falha ao desativar notificações no servidor'
        )
      );
    }

    await db.device.update('device', {
      pushSubscribed: false,
    });
  }

  await db.settings.update('settings', {
    notificationsEnabled: false,
  });
}

/**
 * Sincroniza as ocorrências futuras dos medicamentos
 * com o backend.
 *
 * É isso que cria reminder_jobs no PostgreSQL/Supabase.
 */
export async function syncReminderJobs(
  daysAhead = 60
) {
  const [device, medications, logs, settings] =
    await Promise.all([
      db.device.get('device'),
      db.medications.toArray(),
      db.logs.toArray(),
      db.settings.get('settings'),
    ]);

  if (!device) {
    throw new Error(
      'Dispositivo não inicializado.'
    );
  }

  if (!device.pushSubscribed) {
    console.info(
      '[Reminders] Push não está inscrito. Nenhum job será enviado.'
    );

    return {
      skipped: true,
      reason: 'push-not-subscribed',
      jobs: 0,
    };
  }

  const jobs: ReminderJobPayload[] = [];

  const notificationsEnabled =
    settings?.notificationsEnabled !== false;

  if (notificationsEnabled) {
    for (let offset = 0; offset <= daysAhead; offset++) {
      const date = addDays(new Date(), offset);

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

        /**
         * Não reprograma ocorrências que já terminaram.
         */
        const currentStatus =
          occurrence.log?.status ?? null;

        if (
          currentStatus === 'taken' ||
          currentStatus === 'skipped' ||
          currentStatus === 'missed'
        ) {
          continue;
        }

        jobs.push({
          occurrenceId: occurrence.id,

          medicationId:
            medication.id,

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
      deviceId:
        device.deviceId,

      deviceSecret:
        device.deviceSecret,

      timezone,

      quietHours: {
        enabled:
          settings?.quietHoursEnabled ?? false,

        start:
          settings?.quietStart ?? '23:00',

        end:
          settings?.quietEnd ?? '07:00',
      },

      jobs,
    }),
  });

  if (!response.ok) {
    const message = await parseApiError(
      response,
      `Falha ao sincronizar lembretes (${response.status})`
    );

    console.error(
      '[Reminders]',
      message
    );

    throw new Error(message);
  }

  let serverResult: unknown = null;

  try {
    serverResult = await response.json();
  } catch {
    // Pode haver endpoint sem corpo JSON.
  }

  console.info(
    `[Reminders] ${jobs.length} ocorrência(s) enviada(s) ao backend.`,
    serverResult
  );

  return {
    skipped: false,
    jobs: jobs.length,
    result: serverResult,
  };
}

/**
 * Cancela o job de uma ocorrência.
 *
 * Deve ser chamada depois de "Tomei", "Ignorar" etc.
 */
export async function cancelOccurrenceReminder(
  occurrenceId: string
): Promise<void> {
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
      deviceId:
        device.deviceId,

      deviceSecret:
        device.deviceSecret,

      occurrenceId,
    }),
  });

  if (!response.ok) {
    throw new Error(
      await parseApiError(
        response,
        'Falha ao cancelar lembrete'
      )
    );
  }
}

/**
 * Testa SOMENTE uma notificação local.
 *
 * Isso confirma:
 * - Notification API
 * - Service Worker
 * - permissão do sistema
 *
 * Isso NÃO confirma:
 * - PushSubscription
 * - Supabase
 * - reminder_jobs
 * - cron-job.org
 * - Web Push de verdade
 */
export async function testLocalNotification(): Promise<void> {
  if (typeof window === 'undefined') {
    throw new Error(
      'O teste só pode ser executado no navegador.'
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

  let permission =
    Notification.permission;

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
        'medica-local-notification-test',

      data: {
        url: '/',
      },
    }
  );
}

/**
 * Verifica o estado atual do Push.
 *
 * Essa função é útil para a tela de Configurações mostrar:
 *
 * Push: Registrado / Não registrado
 * Backend: sincronizado ou não
 */
export async function getPushStatus() {
  if (
    typeof window === 'undefined' ||
    !('serviceWorker' in navigator) ||
    !('PushManager' in window)
  ) {
    return {
      supported: false,
      subscribed: false,
      permission: 'unsupported',
    };
  }

  const registration =
    await getServiceWorkerRegistration();

  const subscription =
    await registration.pushManager.getSubscription();

  const device =
    await db.device.get('device');

  return {
    supported: true,

    subscribed:
      Boolean(subscription) &&
      Boolean(device?.pushSubscribed),

    permission:
      Notification.permission,

    hasBrowserSubscription:
      Boolean(subscription),

    backendMarkedSubscribed:
      Boolean(device?.pushSubscribed),
  };
}
