'use client';

import { addDays } from 'date-fns';

import { db } from './db';
import { buildOccurrences } from './domain';

import type {
  DeviceState,
  ReminderJobPayload,
} from './types';

/* =========================================================
   CACHE
========================================================= */

let cachedServiceWorkerRegistration:
  ServiceWorkerRegistration | null = null;

let cachedPushSubscription:
  PushSubscription | null = null;

/* =========================================================
   TIPOS
========================================================= */

type SerializedPushSubscription = {
  endpoint: string;
  expirationTime: number | null;

  keys: {
    p256dh: string;
    auth: string;
  };
};

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

function randomHex(
  byteLength: number
): string {
  const bytes =
    new Uint8Array(
      byteLength
    );

  crypto.getRandomValues(
    bytes
  );

  return Array.from(
    bytes,
    (byte) =>
      byte
        .toString(16)
        .padStart(2, '0')
  ).join('');
}

function createDeviceId(): string {
  return `dev_${randomHex(16)}`;
}

function createDeviceSecret(): string {
  return randomHex(32);
}

function currentTimezone(): string {
  try {
    return (
      Intl.DateTimeFormat()
        .resolvedOptions()
        .timeZone ||
      'UTC'
    );
  } catch {
    return 'UTC';
  }
}

/* =========================================================
   REPARAR DEVICE STATE
========================================================= */

async function getOrRepairDeviceState():
  Promise<DeviceState> {
  const timezone =
    currentTimezone();

  const existing =
    await db.device.get(
      'device'
    );

  const raw =
    existing as
      | Partial<DeviceState>
      | undefined;

  const validDeviceId =
    typeof raw?.deviceId ===
      'string' &&
    raw.deviceId.trim().length >=
      20;

  const validDeviceSecret =
    typeof raw?.deviceSecret ===
      'string' &&
    raw.deviceSecret.trim().length >=
      32;

  /*
   * Se não houver identidade ou ela for de uma
   * versão antiga/incompleta, criamos uma nova.
   *
   * Isso NÃO apaga medicamentos nem histórico.
   */
  if (
    !existing ||
    !validDeviceId ||
    !validDeviceSecret
  ) {
    const repaired:
      DeviceState = {
        id: 'device',

        deviceId:
          createDeviceId(),

        deviceSecret:
          createDeviceSecret(),

        timezone,

        pushSubscribed:
          false,
      };

    await db.device.put(
      repaired
    );

    console.info(
      '[Device] Identidade local criada/reparada.'
    );

    return repaired;
  }

  if (
    existing.timezone !==
    timezone
  ) {
    await db.device.update(
      'device',
      {
        timezone,
      }
    );

    return {
      ...existing,
      timezone,
    };
  }

  return existing;
}

/* =========================================================
   BASE64
========================================================= */

function base64ToUint8Array(
  value: string
): Uint8Array {
  const normalized =
    value.trim();

  if (!normalized) {
    throw new Error(
      'A chave pública VAPID está vazia.'
    );
  }

  const padding =
    '='.repeat(
      (
        4 -
        (
          normalized.length %
          4
        )
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
    const raw =
      window.atob(
        base64
      );

    return Uint8Array.from(
      raw,
      (character) =>
        character.charCodeAt(0)
    );
  } catch {
    throw new Error(
      'NEXT_PUBLIC_VAPID_PUBLIC_KEY possui formato inválido.'
    );
  }
}

function arrayBufferToBase64Url(
  buffer: ArrayBuffer
): string {
  const bytes =
    new Uint8Array(
      buffer
    );

  let binary = '';

  for (
    const byte of bytes
  ) {
    binary +=
      String.fromCharCode(
        byte
      );
  }

  return window
    .btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

/* =========================================================
   SERIALIZAR SUBSCRIPTION
========================================================= */

function serializePushSubscription(
  subscription: PushSubscription
): SerializedPushSubscription {
  const endpoint =
    subscription.endpoint
      ?.trim();

  if (!endpoint) {
    throw new Error(
      'A inscrição Push não forneceu um endpoint.'
    );
  }

  /*
   * Preferimos getKey(), pois isso evita diferenças
   * de implementação de subscription.toJSON() no iOS.
   */
  const p256dhBuffer =
    subscription.getKey(
      'p256dh'
    );

  const authBuffer =
    subscription.getKey(
      'auth'
    );

  const json =
    subscription.toJSON();

  const fallbackP256dh =
    json.keys?.p256dh;

  const fallbackAuth =
    json.keys?.auth;

  const p256dh =
    p256dhBuffer
      ? arrayBufferToBase64Url(
          p256dhBuffer
        )
      : fallbackP256dh;

  const auth =
    authBuffer
      ? arrayBufferToBase64Url(
          authBuffer
        )
      : fallbackAuth;

  if (
    typeof p256dh !==
      'string' ||
    !p256dh.trim()
  ) {
    throw new Error(
      'A inscrição Push não forneceu a chave p256dh.'
    );
  }

  if (
    typeof auth !==
      'string' ||
    !auth.trim()
  ) {
    throw new Error(
      'A inscrição Push não forneceu a chave auth.'
    );
  }

  return {
    endpoint,

    expirationTime:
      subscription
        .expirationTime ??
      null,

    keys: {
      p256dh:
        p256dh.trim(),

      auth:
        auth.trim(),
    },
  };
}

/* =========================================================
   API ERROR
========================================================= */

async function parseApiError(
  response: Response,
  fallback: string
): Promise<string> {
  let text = '';

  try {
    text =
      await response.text();
  } catch {
    return `${fallback} (${response.status})`;
  }

  if (!text) {
    return `${fallback} (${response.status})`;
  }

  try {
    const data =
      JSON.parse(text) as {
        error?: unknown;
        stage?: unknown;
        code?: unknown;
        detail?: unknown;
        fields?: unknown;
      };

    const parts:
      string[] = [];

    parts.push(
      typeof data.error ===
        'string'
        ? data.error
        : fallback
    );

    if (
      typeof data.stage ===
        'string'
    ) {
      parts.push(
        `[${data.stage}]`
      );
    }

    if (
      typeof data.code ===
        'string'
    ) {
      parts.push(
        `[${data.code}]`
      );
    }

    if (
      typeof data.detail ===
        'string' &&
      data.detail
    ) {
      parts.push(
        `— ${data.detail}`
      );
    }

    if (
      Array.isArray(
        data.fields
      ) &&
      data.fields.length
    ) {
      parts.push(
        `Campos: ${data.fields.join(
          ', '
        )}`
      );
    }

    return parts.join(
      ' '
    );
  } catch {
    return (
      `${fallback} (${response.status}) — ${text}`
    );
  }
}

/* =========================================================
   SERVICE WORKER
========================================================= */

export async function registerServiceWorker():
  Promise<ServiceWorkerRegistration | null> {
  if (
    typeof window ===
      'undefined' ||
    !(
      'serviceWorker' in
      navigator
    )
  ) {
    return null;
  }

  try {
    await navigator
      .serviceWorker
      .register(
        '/sw.js',
        {
          scope: '/',
          updateViaCache:
            'none',
        }
      );

    const registration =
      await navigator
        .serviceWorker
        .ready;

    cachedServiceWorkerRegistration =
      registration;

    try {
      cachedPushSubscription =
        await registration
          .pushManager
          .getSubscription();
    } catch {
      cachedPushSubscription =
        null;
    }

    void registration
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
      '[ServiceWorker]',
      error
    );

    throw new Error(
      `Falha ao inicializar o Service Worker: ${unknownErrorMessage(
        error
      )}`
    );
  }
}

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
      'serviceWorker' in
      navigator
    )
  ) {
    throw new Error(
      'Service Worker não é suportado neste dispositivo.'
    );
  }

  const existing =
    await navigator
      .serviceWorker
      .getRegistration('/');

  if (existing) {
    cachedServiceWorkerRegistration =
      existing;

    return existing;
  }

  const registration =
    await navigator
      .serviceWorker
      .ready;

  cachedServiceWorkerRegistration =
    registration;

  return registration;
}

/* =========================================================
   PERMISSÃO
========================================================= */

export async function requestNotificationPermission():
  Promise<NotificationPermission> {
  if (
    typeof window ===
      'undefined'
  ) {
    throw new Error(
      'As notificações só podem ser ativadas no navegador.'
    );
  }

  if (
    !(
      'Notification' in
      window
    )
  ) {
    throw new Error(
      'Este dispositivo não suporta notificações.'
    );
  }

  if (
    isIOSDevice() &&
    !isStandalone()
  ) {
    throw new Error(
      'No iPhone/iPad, instale o site na Tela de Início e abra pelo ícone do aplicativo.'
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
      'As notificações estão bloqueadas. Abra Ajustes → Notificações → Medicamentos e ative Permitir Notificações.'
    );
  }

  const permission =
    await Notification
      .requestPermission();

  if (
    permission !==
      'granted'
  ) {
    throw new Error(
      permission ===
        'denied'
        ? 'A permissão de notificações foi negada.'
        : 'A permissão de notificações ainda não foi concedida.'
    );
  }

  return permission;
}

/* =========================================================
   SUBSCRIBE
========================================================= */

export async function subscribeToPush():
  Promise<PushSubscription> {
  if (
    typeof window ===
      'undefined'
  ) {
    throw new Error(
      'Web Push só pode ser ativado no navegador.'
    );
  }

  if (
    !(
      'serviceWorker' in
      navigator
    )
  ) {
    throw new Error(
      'Service Worker não é suportado.'
    );
  }

  if (
    !(
      'PushManager' in
      window
    )
  ) {
    throw new Error(
      'Web Push não é suportado neste navegador.'
    );
  }

  if (
    !(
      'Notification' in
      window
    )
  ) {
    throw new Error(
      'Notificações não são suportadas.'
    );
  }

  const ios =
    isIOSDevice();

  if (
    ios &&
    !isStandalone()
  ) {
    throw new Error(
      'No iPhone/iPad, abra o PWA pelo ícone da Tela de Início.'
    );
  }

  if (
    Notification.permission ===
      'denied'
  ) {
    throw new Error(
      'Sem permissão para notificações. Abra Ajustes → Notificações → Medicamentos.'
    );
  }

  /*
   * Compatibilidade com a tela antiga:
   * se ainda estiver "default", pedimos a permissão.
   */
  if (
    Notification.permission ===
      'default'
  ) {
    const permission =
      await requestNotificationPermission();

    if (
      permission ===
        'granted' &&
      ios
    ) {
      throw new Error(
        'Permissão concedida. Agora toque novamente em "Ativar Push".'
      );
    }
  }

  if (
    Notification.permission !==
      'granted'
  ) {
    throw new Error(
      'Primeiro conceda permissão para notificações.'
    );
  }

  const vapidPublicKey =
    process.env
      .NEXT_PUBLIC_VAPID_PUBLIC_KEY
      ?.trim();

  if (!vapidPublicKey) {
    throw new Error(
      'NEXT_PUBLIC_VAPID_PUBLIC_KEY não está configurada na Vercel.'
    );
  }

  /*
   * Tudo isto é síncrono, portanto não perde
   * o gesto do usuário.
   */
  const applicationServerKey =
    base64ToUint8Array(
      vapidPublicKey
    );

  let registration:
    ServiceWorkerRegistration;

  if (
    cachedServiceWorkerRegistration
  ) {
    registration =
      cachedServiceWorkerRegistration;
  } else {
    /*
     * No iOS não fazemos await de ready neste ponto,
     * pois subscribe() deve continuar ligado ao clique.
     */
    if (ios) {
      throw new Error(
        'O Service Worker ainda está inicializando. Feche e abra o aplicativo novamente e tente outra vez.'
      );
    }

    registration =
      await getServiceWorkerRegistration();
  }

  let subscription =
    cachedPushSubscription;

  if (!subscription) {
    try {
      subscription =
        await registration
          .pushManager
          .subscribe({
            userVisibleOnly:
              true,

            applicationServerKey:
              applicationServerKey as BufferSource,
          });

      cachedPushSubscription =
        subscription;
    } catch (error) {
      console.error(
        '[Push] subscribe():',
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
            'O iPhone não autorizou o Web Push. Confirme a permissão em Ajustes → Notificações.'
          );
        }

        if (
          error.name ===
            'InvalidStateError'
        ) {
          /*
           * Pode existir uma subscription antiga criada
           * com outra chave VAPID.
           */
          try {
            const oldSubscription =
              await registration
                .pushManager
                .getSubscription();

            if (
              oldSubscription
            ) {
              await oldSubscription
                .unsubscribe();
            }

            cachedPushSubscription =
              null;
          } catch {
            // ignore
          }

          throw new Error(
            'Foi encontrada uma inscrição Push antiga/incompatível e ela foi removida. Toque novamente em "Ativar Push".'
          );
        }

        if (
          error.name ===
            'AbortError'
        ) {
          throw new Error(
            'O iPhone interrompeu a criação do Push. Feche o aplicativo, abra novamente e tente outra vez.'
          );
        }

        throw new Error(
          `Falha do Web Push (${error.name}): ${error.message}`
        );
      }

      throw new Error(
        `Não foi possível criar a inscrição Push: ${unknownErrorMessage(
          error
        )}`
      );
    }
  }

  /*
   * A partir daqui a PushSubscription já existe.
   * Agora podemos fazer operações assíncronas normais.
   */
  const serialized =
    serializePushSubscription(
      subscription
    );

  const device =
    await getOrRepairDeviceState();

  const timezone =
    currentTimezone();

  /*
   * Validação local antes do fetch.
   */
  if (
    device.deviceId.length <
      20
  ) {
    throw new Error(
      'deviceId local inválido.'
    );
  }

  if (
    device.deviceSecret.length <
      32
  ) {
    throw new Error(
      'deviceSecret local inválido.'
    );
  }

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

            accept:
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
                serialized,
            }),
        }
      );
  } catch (error) {
    throw new Error(
      `A inscrição foi criada no iPhone, mas não foi possível acessar o servidor: ${unknownErrorMessage(
        error
      )}`
    );
  }

  if (!response.ok) {
    throw new Error(
      await parseApiError(
        response,
        'Falha ao registrar Push no servidor'
      )
    );
  }

  await db.device.update(
    'device',
    {
      pushSubscribed:
        true,

      timezone,
    }
  );

  await db.settings.update(
    'settings',
    {
      notificationsEnabled:
        true,
    }
  );

  try {
    await syncReminderJobs();
  } catch (error) {
    /*
     * Não desfazemos o Push se somente a sincronização
     * dos lembretes falhar.
     */
    console.error(
      '[Push] Registrado, mas syncReminderJobs falhou:',
      error
    );
  }

  console.info(
    '[Push] Ativado com sucesso.'
  );

  return subscription;
}

/* =========================================================
   UNSUBSCRIBE
========================================================= */

export async function unsubscribeFromPush():
  Promise<void> {
  const device =
    await db.device.get(
      'device'
    );

  let registration:
    ServiceWorkerRegistration | null =
      null;

  if (
    typeof navigator !==
      'undefined' &&
    'serviceWorker' in
      navigator
  ) {
    try {
      registration =
        await getServiceWorkerRegistration();
    } catch {
      registration = null;
    }
  }

  /*
   * Primeiro avisamos o backend para que ele pare
   * de enviar notificações.
   */
  if (device) {
    try {
      const response =
        await fetch(
          '/api/push/unsubscribe',
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
              }),
          }
        );

      if (!response.ok) {
        console.warn(
          '[Push] Backend unsubscribe:',
          await parseApiError(
            response,
            'Falha ao desativar Push no servidor'
          )
        );
      }
    } catch (error) {
      console.warn(
        '[Push] Falha ao avisar backend:',
        error
      );
    }
  }

  try {
    const subscription =
      cachedPushSubscription ??
      (
        registration
          ? await registration
              .pushManager
              .getSubscription()
          : null
      );

    if (subscription) {
      await subscription
        .unsubscribe();
    }
  } finally {
    cachedPushSubscription =
      null;
  }

  if (device) {
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
   SINCRONIZAR JOBS
========================================================= */

export async function syncReminderJobs(
  daysAhead = 60
) {
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
    return {
      skipped: true,
      reason:
        'push-not-subscribed',
      jobs: 0,
    };
  }

  const jobs:
    ReminderJobPayload[] = [];

  if (
    settings
      ?.notificationsEnabled !==
    false
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
          !medication.enabled ||
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

  const response =
    await fetch(
      '/api/reminders/sync',
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

            timezone:
              currentTimezone(),

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

  if (!response.ok) {
    throw new Error(
      await parseApiError(
        response,
        'Falha ao sincronizar lembretes'
      )
    );
  }

  let result:
    unknown = null;

  try {
    result =
      await response.json();
  } catch {
    // resposta sem JSON
  }

  return {
    skipped: false,
    jobs:
      jobs.length,
    result,
  };
}

/* =========================================================
   CANCELAR OCORRÊNCIA
========================================================= */

export async function cancelOccurrenceReminder(
  occurrenceId: string
): Promise<void> {
  if (!occurrenceId) {
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

  const response =
    await fetch(
      '/api/reminders/cancel',
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

            occurrenceId,
          }),
      }
    );

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

export async function testLocalNotification():
  Promise<void> {
  if (
    typeof window ===
      'undefined' ||
    !(
      'Notification' in
      window
    )
  ) {
    throw new Error(
      'Notificações não são suportadas neste dispositivo.'
    );
  }

  if (
    isIOSDevice() &&
    !isStandalone()
  ) {
    throw new Error(
      'No iPhone, abra o aplicativo pela Tela de Início.'
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
          'Permissão e Service Worker estão funcionando.',

        icon:
          '/icons/icon-192.png',

        badge:
          '/icons/badge-96.png',

        tag:
          'medica-local-test',

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
  const standalone =
    isStandalone();

  const ios =
    isIOSDevice();

  if (
    typeof window ===
      'undefined' ||
    !(
      'serviceWorker' in
      navigator
    ) ||
    !(
      'PushManager' in
      window
    ) ||
    !(
      'Notification' in
      window
    )
  ) {
    return {
      supported: false,
      subscribed: false,
      permission:
        'unsupported' as const,
      hasBrowserSubscription:
        false,
      backendMarkedSubscribed:
        false,
      standalone,
      ios,
    };
  }

  let subscription =
    cachedPushSubscription;

  try {
    const registration =
      await getServiceWorkerRegistration();

    subscription =
      await registration
        .pushManager
        .getSubscription();

    cachedPushSubscription =
      subscription;
  } catch {
    subscription = null;
  }

  const device =
    await db.device.get(
      'device'
    );

  const hasBrowserSubscription =
    Boolean(subscription);

  const backendMarkedSubscribed =
    Boolean(
      device
        ?.pushSubscribed
    );

  return {
    supported: true,

    subscribed:
      hasBrowserSubscription &&
      backendMarkedSubscribed,

    permission:
      Notification.permission,

    hasBrowserSubscription,

    backendMarkedSubscribed,

    standalone,

    ios,
  };
}

/* =========================================================
   PRÉ-INICIALIZAÇÃO
========================================================= */

if (
  typeof window !==
    'undefined' &&
  'serviceWorker' in
    navigator
) {
  void registerServiceWorker()
    .catch(
      (error) => {
        console.warn(
          '[ServiceWorker] Pré-inicialização:',
          error
        );
      }
    );
}
