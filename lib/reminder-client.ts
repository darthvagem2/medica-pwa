'use client';

import { addDays } from 'date-fns';

import { db } from './db';
import { buildOccurrences } from './domain';
import type { ReminderJobPayload } from './types';

/* =========================================================
   SERVICE WORKER
========================================================= */

/**
 * Mantemos o registration em memória.
 *
 * Isso é especialmente importante no iPhone:
 * no segundo toque do usuário precisamos conseguir chamar
 * pushManager.subscribe() imediatamente, sem esperar
 * navigator.serviceWorker.ready.
 */
let cachedServiceWorkerRegistration:
  ServiceWorkerRegistration | null = null;

/* =========================================================
   HELPERS
========================================================= */

function isIOSDevice(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }

  return /iPhone|iPad|iPod/i.test(
    navigator.userAgent
  );
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const displayMode =
    window.matchMedia?.(
      '(display-mode: standalone)'
    ).matches ?? false;

  const iosStandalone =
    Boolean(
      (
        navigator as Navigator & {
          standalone?: boolean;
        }
      ).standalone
    );

  return (
    displayMode ||
    iosStandalone
  );
}

function unknownErrorMessage(
  error: unknown,
  fallback = 'Erro desconhecido.'
): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (
    typeof error === 'string' &&
    error.trim()
  ) {
    return error;
  }

  return fallback;
}

/**
 * Converte a chave pública VAPID Base64 URL-safe
 * para Uint8Array.
 */
function base64ToUint8Array(
  base64String: string
): Uint8Array {
  const normalized =
    base64String.trim();

  if (!normalized) {
    throw new Error(
      'A chave pública VAPID está vazia.'
    );
  }

  const padding =
    '='.repeat(
      (
        4 -
        (normalized.length % 4)
      ) % 4
    );

  const base64 =
    (
      normalized +
      padding
    )
      .replace(/-/g, '+')
      .replace(/_/g, '/');

  try {
    const rawData =
      window.atob(base64);

    return Uint8Array.from(
      Array.from(rawData).map(
        (character) =>
          character.charCodeAt(0)
      )
    );
  } catch {
    throw new Error(
      'NEXT_PUBLIC_VAPID_PUBLIC_KEY possui formato inválido.'
    );
  }
}

/**
 * Extrai do backend:
 *
 * error
 * stage
 * code
 * detail
 *
 * Assim não ficamos apenas com:
 * "Falha ao registrar push".
 */
async function parseApiError(
  response: Response,
  fallback: string
): Promise<string> {
  let raw = '';

  try {
    raw =
      await response.text();
  } catch {
    return `${fallback} (${response.status})`;
  }

  if (!raw) {
    return `${fallback} (${response.status})`;
  }

  try {
    const json =
      JSON.parse(raw) as {
        error?: unknown;
        stage?: unknown;
        code?: unknown;
        detail?: unknown;
      };

    const error =
      typeof json.error === 'string'
        ? json.error
        : fallback;

    const stage =
      typeof json.stage === 'string'
        ? json.stage
        : '';

    const code =
      typeof json.code === 'string'
        ? json.code
        : '';

    const detail =
      typeof json.detail === 'string'
        ? json.detail
        : '';

    let message =
      error;

    if (stage) {
      message +=
        ` [${stage}]`;
    }

    if (code) {
      message +=
        ` [${code}]`;
    }

    if (detail) {
      message +=
        ` — ${detail}`;
    }

    return message;
  } catch {
    return (
      `${fallback} (${response.status}) — ${raw}`
    );
  }
}

/* =========================================================
   REGISTRAR SERVICE WORKER
========================================================= */

export async function registerServiceWorker():
  Promise<ServiceWorkerRegistration | null> {
  if (
    typeof window === 'undefined' ||
    !(
      'serviceWorker' in navigator
    )
  ) {
    return null;
  }

  try {
    /**
     * Registrar pode retornar enquanto o worker ainda
     * está instalando.
     */
    await navigator.serviceWorker.register(
      '/sw.js',
      {
        scope: '/',
        updateViaCache:
          'none',
      }
    );

    /**
     * Aqui podemos esperar, porque esta função deve
     * rodar antes do usuário tocar no botão.
     */
    const registration =
      await navigator.serviceWorker.ready;

    cachedServiceWorkerRegistration =
      registration;

    /**
     * Atualização não precisa bloquear.
     */
    registration
      .update()
      .catch(
        () => undefined
      );

    console.info(
      '[ServiceWorker] Pronto:',
      registration.scope
    );

    return registration;
  } catch (error) {
    cachedServiceWorkerRegistration =
      null;

    console.error(
      '[ServiceWorker] Falha:',
      error
    );

    throw new Error(
      `Falha ao inicializar o sistema de notificações: ${unknownErrorMessage(
        error
      )}`
    );
  }
}

/**
 * Usar somente em operações em que podemos aguardar.
 *
 * NÃO devemos chamar isso antes de subscribe()
 * no segundo toque do iPhone.
 */
async function getServiceWorkerRegistration():
  Promise<ServiceWorkerRegistration> {
  if (
    cachedServiceWorkerRegistration
  ) {
    return cachedServiceWorkerRegistration;
  }

  if (
    typeof navigator ===
      'undefined' ||
    !(
      'serviceWorker' in navigator
    )
  ) {
    throw new Error(
      'Service Worker não é suportado neste dispositivo.'
    );
  }

  const existing =
    await navigator.serviceWorker
      .getRegistration('/');

  if (existing) {
    cachedServiceWorkerRegistration =
      existing;

    return existing;
  }

  const ready =
    await navigator.serviceWorker.ready;

  cachedServiceWorkerRegistration =
    ready;

  return ready;
}

/* =========================================================
   PERMISSÃO DE NOTIFICAÇÃO
========================================================= */

/**
 * Pede SOMENTE a permissão do sistema.
 *
 * No iPhone:
 *
 * primeiro toque:
 * requestPermission()
 *
 * segundo toque:
 * pushManager.subscribe()
 */
export async function requestNotificationPermission():
  Promise<NotificationPermission> {
  if (
    typeof window === 'undefined'
  ) {
    throw new Error(
      'As notificações só podem ser ativadas no navegador.'
    );
  }

  if (
    !(
      'Notification' in window
    )
  ) {
    throw new Error(
      'A API de notificações não é suportada neste dispositivo.'
    );
  }

  if (
    isIOSDevice() &&
    !isStandalone()
  ) {
    throw new Error(
      'No iPhone/iPad, abra o aplicativo pelo ícone da Tela de Início. Não tente ativar o Push dentro de uma aba normal do Safari.'
    );
  }

  if (
    Notification.permission ===
      'granted'
  ) {
    return 'granted';
  }

  if (
    Notification.permission ===
      'denied'
  ) {
    throw new Error(
      'As notificações estão bloqueadas. Abra Ajustes → Notificações → Medicamentos e ative "Permitir Notificações". Se o aplicativo não aparecer ali, remova o PWA da Tela de Início e instale novamente pelo Safari.'
    );
  }

  let permission:
    NotificationPermission;

  try {
    permission =
      await Notification
        .requestPermission();
  } catch (error) {
    throw new Error(
      `Não foi possível abrir a solicitação de permissão: ${unknownErrorMessage(
        error
      )}`
    );
  }

  if (
    permission ===
      'denied'
  ) {
    throw new Error(
      'Você negou a permissão de notificações. Para liberar novamente, use Ajustes → Notificações no iPhone.'
    );
  }

  if (
    permission !==
      'granted'
  ) {
    throw new Error(
      'A permissão de notificações ainda não foi concedida.'
    );
  }

  return permission;
}

/* =========================================================
   ATIVAR WEB PUSH
========================================================= */

export async function subscribeToPush():
  Promise<PushSubscription> {
  if (
    typeof window === 'undefined'
  ) {
    throw new Error(
      'Web Push só pode ser ativado no navegador.'
    );
  }

  if (
    !(
      'serviceWorker' in navigator
    )
  ) {
    throw new Error(
      'Service Worker não é suportado neste dispositivo.'
    );
  }

  if (
    !(
      'PushManager' in window
    )
  ) {
    throw new Error(
      'Web Push não é suportado neste navegador.'
    );
  }

  if (
    !(
      'Notification' in window
    )
  ) {
    throw new Error(
      'A API de notificações não é suportada neste dispositivo.'
    );
  }

  const ios =
    isIOSDevice();

  if (
    ios &&
    !isStandalone()
  ) {
    throw new Error(
      'No iPhone/iPad, primeiro adicione o site à Tela de Início e depois abra pelo ícone do aplicativo.'
    );
  }

  /* =======================================================
     ETAPA 1 — PERMISSÃO
  ======================================================= */

  if (
    Notification.permission ===
      'denied'
  ) {
    throw new Error(
      'Sem permissão para notificações. Abra Ajustes → Notificações → Medicamentos → Permitir Notificações.'
    );
  }

  /**
   * No iPhone fazemos propositalmente em duas etapas.
   *
   * PRIMEIRO TOQUE:
   * exibe o alerta de permissão.
   *
   * Depois que o usuário permite, pedimos para tocar
   * novamente.
   *
   * Isso evita consumir o gesto do usuário antes do
   * pushManager.subscribe().
   */
  if (
    Notification.permission ===
      'default'
  ) {
    const permission =
      await requestNotificationPermission();

    if (
      permission ===
        'granted'
    ) {
      if (ios) {
        throw new Error(
          'Permissão concedida com sucesso. Agora toque novamente em "Solicitar / ativar permissão" para concluir a ativação do Push.'
        );
      }
    }
  }

  if (
    Notification.permission !==
      'granted'
  ) {
    throw new Error(
      'A permissão para notificações ainda não está ativa.'
    );
  }

  /* =======================================================
     ETAPA 2 — VAPID
  ======================================================= */

  const publicKey =
    process.env
      .NEXT_PUBLIC_VAPID_PUBLIC_KEY
      ?.trim();

  if (!publicKey) {
    throw new Error(
      'NEXT_PUBLIC_VAPID_PUBLIC_KEY não está configurada no deployment da Vercel.'
    );
  }

  let applicationServerKey:
    Uint8Array;

  try {
    applicationServerKey =
      base64ToUint8Array(
        publicKey
      );
  } catch (error) {
    throw new Error(
      unknownErrorMessage(
        error,
        'Chave VAPID pública inválida.'
      )
    );
  }

  /* =======================================================
     ETAPA 3 — SERVICE WORKER
  ======================================================= */

  let registration:
    ServiceWorkerRegistration;

  if (
    cachedServiceWorkerRegistration
  ) {
    registration =
      cachedServiceWorkerRegistration;
  } else {
    /**
     * No iOS NÃO queremos fazer await de
     * navigator.serviceWorker.ready aqui.
     *
     * A inicialização deve acontecer antes do toque.
     */
    if (ios) {
      throw new Error(
        'O sistema de notificações ainda está inicializando. Feche o aplicativo, abra novamente pelo ícone da Tela de Início, aguarde alguns segundos e toque novamente.'
      );
    }

    registration =
      await getServiceWorkerRegistration();
  }

  /* =======================================================
     ETAPA 4 — PUSH SUBSCRIPTION
  ======================================================= */

  let subscription:
    PushSubscription;

  try {
    /**
     * No iPhone, quando chegamos aqui:
     *
     * - permission já é granted
     * - registration já está em memória
     * - VAPID já foi preparada
     *
     * Portanto este é o PRIMEIRO await relevante
     * do segundo toque.
     */
    subscription =
      await registration
        .pushManager
        .subscribe({
          userVisibleOnly:
            true,

          applicationServerKey:
            applicationServerKey as BufferSource,
        });
  } catch (error) {
    console.error(
      '[Push] pushManager.subscribe() falhou:',
      error
    );

    if (
      error instanceof
        DOMException
    ) {
      if (
        error.name ===
          'NotAllowedError'
      ) {
        throw new Error(
          'O iPhone não autorizou a criação do Push. Confirme que "Permitir Notificações" está ativo em Ajustes → Notificações e que você abriu o aplicativo pelo ícone da Tela de Início.'
        );
      }

      if (
        error.name ===
          'InvalidStateError'
      ) {
        throw new Error(
          'Existe uma inscrição Push incompatível com a chave VAPID atual. Remova o aplicativo da Tela de Início, instale-o novamente pelo Safari e tente de novo.'
        );
      }

      if (
        error.name ===
          'AbortError'
      ) {
        throw new Error(
          'O iPhone interrompeu a criação da inscrição Push. Feche o aplicativo completamente, abra novamente e tente outra vez.'
        );
      }

      throw new Error(
        `Falha do Push (${error.name}): ${error.message}`
      );
    }

    throw new Error(
      `Não foi possível criar a inscrição Web Push: ${unknownErrorMessage(
        error
      )}`
    );
  }

  /* =======================================================
     ETAPA 5 — DISPOSITIVO LOCAL
  ======================================================= */

  const device =
    await db.device.get(
      'device'
    );

  if (!device) {
    /**
     * Neste caso a inscrição foi criada no navegador,
     * mas não temos identidade local para registrá-la.
     */
    await subscription
      .unsubscribe()
      .catch(
        () => undefined
      );

    throw new Error(
      'O dispositivo ainda não foi inicializado no aplicativo. Feche o app, abra novamente e tente de novo.'
    );
  }

  const timezone =
    Intl.DateTimeFormat()
      .resolvedOptions()
      .timeZone ||
    'UTC';

  /* =======================================================
     ETAPA 6 — REGISTRAR NO BACKEND
  ======================================================= */

  let response:
    Response;

  try {
    response =
      await fetch(
        '/api/push/subscribe',
        {
          method: 'POST',

          headers: {
            'content-type':
              'application/json',
          },

          cache: 'no-store',

          body:
            JSON.stringify({
              deviceId:
                device.deviceId,

              deviceSecret:
                device.deviceSecret,

              timezone,

              subscription:
                subscription
                  .toJSON(),
            }),
        }
      );
  } catch (error) {
    console.error(
      '[Push] Falha de rede ao registrar:',
      error
    );

    throw new Error(
      `A inscrição foi criada no iPhone, mas não foi possível acessar o servidor: ${unknownErrorMessage(
        error
      )}. Toque novamente para tentar registrar no backend.`
    );
  }

  if (!response.ok) {
    const message =
      await parseApiError(
        response,
        `Falha ao registrar Push no servidor`
      );

    console.error(
      '[Push] Backend recusou inscrição:',
      message
    );

    /**
     * NÃO removemos a PushSubscription daqui.
     *
     * Assim, se o problema for Supabase/Vercel,
     * o próximo toque pode tentar novamente.
     */
    throw new Error(
      message
    );
  }

  /* =======================================================
     ETAPA 7 — MARCAR LOCALMENTE
  ======================================================= */

  await db.device.update(
    'device',
    {
      pushSubscribed:
        true,
    }
  );

  await db.settings.update(
    'settings',
    {
      notificationsEnabled:
        true,
    }
  );

  /* =======================================================
     ETAPA 8 — SINCRONIZAR REMINDERS
  ======================================================= */

  try {
    await syncReminderJobs();
  } catch (error) {
    /**
     * Importante:
     *
     * Push já foi registrado.
     * Portanto não dizemos que "falhou o Push"
     * apenas porque a sincronização dos jobs falhou.
     */
    console.error(
      '[Push] Push ativado, mas sync dos lembretes falhou:',
      error
    );
  }

  console.info(
    '[Push] Web Push ativado com sucesso.'
  );

  return subscription;
}

/* =========================================================
   DESATIVAR WEB PUSH
========================================================= */

export async function unsubscribeFromPush():
  Promise<void> {
  if (
    typeof window === 'undefined'
  ) {
    return;
  }

  const device =
    await db.device.get(
      'device'
    );

  let registration:
    ServiceWorkerRegistration | null =
      null;

  if (
    'serviceWorker' in navigator
  ) {
    try {
      registration =
        await getServiceWorkerRegistration();
    } catch {
      registration = null;
    }
  }

  if (registration) {
    try {
      const subscription =
        await registration
          .pushManager
          .getSubscription();

      if (subscription) {
        await subscription
          .unsubscribe();
      }
    } catch (error) {
      console.warn(
        '[Push] Falha ao remover subscription local:',
        error
      );
    }
  }

  if (device) {
    let response:
      Response;

    try {
      response =
        await fetch(
          '/api/push/unsubscribe',
          {
            method:
              'POST',

            headers: {
              'content-type':
                'application/json',
            },

            cache:
              'no-store',

            body:
              JSON.stringify({
                deviceId:
                  device.deviceId,

                deviceSecret:
                  device.deviceSecret,
              }),
          }
        );
    } catch (error) {
      throw new Error(
        `Não foi possível acessar o servidor para desativar o Push: ${unknownErrorMessage(
          error
        )}`
      );
    }

    if (!response.ok) {
      throw new Error(
        await parseApiError(
          response,
          'Falha ao desativar Push no servidor'
        )
      );
    }

    await db.device.update(
      'device',
      {
        pushSubscribed:
          false,
      }
    );
  }

  await db.settings.update(
    'settings',
    {
      notificationsEnabled:
        false,
    }
  );
}

/* =========================================================
   SINCRONIZAR LEMBRETES
========================================================= */

export async function syncReminderJobs(
  daysAhead = 60
) {
  /**
   * Evita valores absurdos acidentalmente.
   */
  const safeDaysAhead =
    Math.max(
      0,
      Math.min(
        Math.floor(
          daysAhead
        ),
        365
      )
    );

  const [
    device,
    medications,
    logs,
    settings,
  ] =
    await Promise.all([
      db.device.get(
        'device'
      ),

      db.medications
        .toArray(),

      db.logs.toArray(),

      db.settings.get(
        'settings'
      ),
    ]);

  if (!device) {
    throw new Error(
      'Dispositivo não inicializado.'
    );
  }

  if (
    !device.pushSubscribed
  ) {
    console.info(
      '[Reminders] Push não está inscrito.'
    );

    return {
      skipped: true,
      reason:
        'push-not-subscribed',
      jobs: 0,
    };
  }

  const jobs:
    ReminderJobPayload[] = [];

  const notificationsEnabled =
    settings
      ?.notificationsEnabled !==
    false;

  if (
    notificationsEnabled
  ) {
    for (
      let offset = 0;
      offset <=
      safeDaysAhead;
      offset++
    ) {
      const date =
        addDays(
          new Date(),
          offset
        );

      const occurrences =
        buildOccurrences(
          medications,
          logs,
          date
        );

      for (
        const occurrence of
        occurrences
      ) {
        const medication =
          occurrence.medication;

        if (
          !medication.enabled
        ) {
          continue;
        }

        if (
          !medication
            .reminders
            .enabled
        ) {
          continue;
        }

        const status =
          occurrence.log
            ?.status ??
          null;

        if (
          status === 'taken' ||
          status === 'skipped' ||
          status === 'missed'
        ) {
          continue;
        }

        jobs.push({
          occurrenceId:
            occurrence.id,

          medicationId:
            medication.id,

          medicationLabel:
            medication.nickname ||
            medication.name,

          scheduledAt:
            occurrence
              .scheduledAt
              .toISOString(),

          deadlineAt:
            occurrence
              .deadlineAt
              ?.toISOString(),

          repeatMinutes:
            medication
              .reminders
              .repeatMinutes,

          sound:
            medication
              .reminders
              .sound &&
            (
              settings
                ?.soundEnabled ??
              true
            ),

          vibration:
            settings
              ?.vibrationEnabled ??
            true,

          required:
            medication
              .reminders
              .required,

          url:
            `/?occurrence=${encodeURIComponent(
              occurrence.id
            )}`,
        });
      }
    }
  }

  const timezone =
    Intl.DateTimeFormat()
      .resolvedOptions()
      .timeZone ||
    'UTC';

  let response:
    Response;

  try {
    response =
      await fetch(
        '/api/reminders/sync',
        {
          method:
            'POST',

          headers: {
            'content-type':
              'application/json',
          },

          cache:
            'no-store',

          body:
            JSON.stringify({
              deviceId:
                device.deviceId,

              deviceSecret:
                device.deviceSecret,

              timezone,

              quietHours: {
                enabled:
                  settings
                    ?.quietHoursEnabled ??
                  false,

                start:
                  settings
                    ?.quietStart ??
                  '23:00',

                end:
                  settings
                    ?.quietEnd ??
                  '07:00',
              },

              jobs,
            }),
        }
      );
  } catch (error) {
    throw new Error(
      `Falha de rede ao sincronizar lembretes: ${unknownErrorMessage(
        error
      )}`
    );
  }

  if (!response.ok) {
    throw new Error(
      await parseApiError(
        response,
        `Falha ao sincronizar lembretes`
      )
    );
  }

  let serverResult:
    unknown = null;

  try {
    serverResult =
      await response.json();
  } catch {
    // Endpoint pode responder sem JSON.
  }

  console.info(
    `[Reminders] ${jobs.length} ocorrência(s) sincronizada(s).`,
    serverResult
  );

  return {
    skipped:
      false,

    jobs:
      jobs.length,

    result:
      serverResult,
  };
}

/* =========================================================
   CANCELAR UMA OCORRÊNCIA
========================================================= */

export async function cancelOccurrenceReminder(
  occurrenceId: string
): Promise<void> {
  if (
    !occurrenceId
  ) {
    return;
  }

  const device =
    await db.device.get(
      'device'
    );

  if (
    !device?.pushSubscribed
  ) {
    return;
  }

  let response:
    Response;

  try {
    response =
      await fetch(
        '/api/reminders/cancel',
        {
          method:
            'POST',

          headers: {
            'content-type':
              'application/json',
          },

          cache:
            'no-store',

          body:
            JSON.stringify({
              deviceId:
                device.deviceId,

              deviceSecret:
                device.deviceSecret,

              occurrenceId,
            }),
        }
      );
  } catch (error) {
    throw new Error(
      `Falha de rede ao cancelar o lembrete: ${unknownErrorMessage(
        error
      )}`
    );
  }

  if (!response.ok) {
    throw new Error(
      await parseApiError(
        response,
        'Falha ao cancelar lembrete'
      )
    );
  }
}

/* =========================================================
   TESTE LOCAL
========================================================= */

/**
 * Este teste NÃO testa:
 *
 * - Supabase
 * - Web Push real
 * - cron-job.org
 * - reminder_jobs
 *
 * Ele testa somente:
 *
 * - permissão
 * - Service Worker
 * - showNotification()
 */
export async function testLocalNotification():
  Promise<void> {
  if (
    typeof window === 'undefined'
  ) {
    throw new Error(
      'O teste só pode ser executado no navegador.'
    );
  }

  if (
    !(
      'Notification' in window
    )
  ) {
    throw new Error(
      'Notificações não são suportadas neste dispositivo.'
    );
  }

  if (
    !(
      'serviceWorker' in navigator
    )
  ) {
    throw new Error(
      'Service Worker não é suportado neste dispositivo.'
    );
  }

  if (
    isIOSDevice() &&
    !isStandalone()
  ) {
    throw new Error(
      'No iPhone, abra o aplicativo instalado pela Tela de Início para testar notificações.'
    );
  }

  if (
    Notification.permission !==
      'granted'
  ) {
    await requestNotificationPermission();
  }

  if (
    Notification.permission !==
      'granted'
  ) {
    throw new Error(
      'Permissão de notificações não concedida.'
    );
  }

  const registration =
    await getServiceWorkerRegistration();

  await registration
    .showNotification(
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

/* =========================================================
   STATUS
========================================================= */

export async function getPushStatus() {
  if (
    typeof window === 'undefined'
  ) {
    return {
      supported:
        false,

      subscribed:
        false,

      permission:
        'unsupported',

      hasBrowserSubscription:
        false,

      backendMarkedSubscribed:
        false,

      standalone:
        false,
    };
  }

  const supported =
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window;

  if (!supported) {
    return {
      supported:
        false,

      subscribed:
        false,

      permission:
        'unsupported',

      hasBrowserSubscription:
        false,

      backendMarkedSubscribed:
        false,

      standalone:
        isStandalone(),
    };
  }

  let browserSubscription:
    PushSubscription | null =
      null;

  try {
    const registration =
      await getServiceWorkerRegistration();

    browserSubscription =
      await registration
        .pushManager
        .getSubscription();
  } catch (error) {
    console.warn(
      '[Push Status]',
      error
    );
  }

  const device =
    await db.device.get(
      'device'
    );

  const hasBrowserSubscription =
    Boolean(
      browserSubscription
    );

  const backendMarkedSubscribed =
    Boolean(
      device
        ?.pushSubscribed
    );

  return {
    supported:
      true,

    subscribed:
      hasBrowserSubscription &&
      backendMarkedSubscribed,

    permission:
      Notification.permission,

    hasBrowserSubscription,

    backendMarkedSubscribed,

    standalone:
      isStandalone(),

    ios:
      isIOSDevice(),
  };
}

/* =========================================================
   PRÉ-INICIALIZAÇÃO
========================================================= */

/**
 * A tela de Configurações importa este módulo.
 *
 * Portanto já começamos a preparar o Service Worker antes
 * de o usuário tocar em "Solicitar / ativar permissão".
 *
 * Isso deixa o registration em memória para o segundo toque
 * no iPhone.
 */
if (
  typeof window !== 'undefined' &&
  'serviceWorker' in navigator
) {
  void registerServiceWorker()
    .catch(
      (error) => {
        console.warn(
          '[ServiceWorker] Pré-inicialização falhou:',
          error
        );
      }
    );
}
