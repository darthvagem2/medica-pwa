import { createClient } from '@supabase/supabase-js';
import type { PushSubscription as WebPushSubscription } from 'web-push';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import { getWebPush } from '@/lib/push-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const CRON_VERSION = 'SUPABASE_CRON_V3_VAPID_DEBUG';

type ReminderPhase = 'main' | 'deadline' | 'repeat' | 'done';

type PushDeviceRow = {
  subscription: unknown;
  timezone: string | null;
  quiet_enabled: boolean | null;
  quiet_start: string | null;
  quiet_end: string | null;
  active: boolean | null;
};

type ReminderJobRow = {
  device_id: string;
  occurrence_id: string;
  medication_id: string;
  medication_label: string;
  scheduled_at: string;
  deadline_at: string | null;
  next_notify_at: string;
  repeat_minutes: number;
  phase: ReminderPhase;
  sound: boolean;
  vibration: boolean;
  required: boolean;
  url: string | null;
  active: boolean;
  last_sent_at: string | null;
  locked_until: string | null;
  push_devices: PushDeviceRow | PushDeviceRow[] | null;
};

type VapidDebug = {
  endpointOrigin: string | null;
  endpointHost: string | null;
  applePushEndpoint: boolean;
  authorizationScheme: string | null;
  jwtExtracted: boolean;
  jwtSegments: number;
  alg: string | null;
  typ: string | null;
  aud: string | null;
  audMatchesEndpointOrigin: boolean | null;
  subPreview: string | null;
  subValid: boolean | null;
  exp: number | null;
  expIso: string | null;
  expSecondsFromNow: number | null;
  expInFuture: boolean | null;
  expWithin24Hours: boolean | null;
  authorizationPublicKeyPresent: boolean;
  authorizationPublicKeyMatchesConfigured: boolean | null;
  configuredPublicKeyBytes: number | null;
  configuredPrivateKeyPresent: boolean;
  pairValidatedByPushServer: boolean;
  debugError: string | null;
};

type PushErrorDiagnostic = {
  occurrenceId: string;
  medicationLabel: string;
  statusCode: number | null;
  message: string;
  reason: string | null;
  body: unknown;
  vapidDebug: VapidDebug | null;
};

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function cleanEnv(value: string | undefined): string {
  if (!value) return '';

  let result = value.trim();

  if (
    (result.startsWith('"') && result.endsWith('"')) ||
    (result.startsWith("'") && result.endsWith("'"))
  ) {
    result = result.slice(1, -1).trim();
  }

  return result;
}

function safeError(error: unknown): string {
  let message: string;

  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === 'string') {
    message = error;
  } else {
    try {
      message = JSON.stringify(error);
    } catch {
      message = String(error);
    }
  }

  return message
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .replace(/sb_secret_[A-Za-z0-9_-]+/gi, 'sb_secret_***');
}

function getPushStatusCode(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }

  const raw = error as {
    statusCode?: unknown;
  };

  const status = Number(raw.statusCode);

  return Number.isFinite(status) ? status : null;
}

function getPushErrorBody(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) {
    return null;
  }

  const raw = error as {
    body?: unknown;
  };

  const body = raw.body;

  if (body === undefined || body === null) {
    return null;
  }

  if (typeof body === 'string') {
    const text = body.trim();

    if (!text) {
      return null;
    }

    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  if (body instanceof Uint8Array) {
    const text = Buffer.from(body)
      .toString('utf8')
      .trim();

    if (!text) {
      return null;
    }

    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  return body;
}

function getPushErrorReason(body: unknown): string | null {
  if (typeof body === 'object' && body !== null) {
    const raw = body as {
      reason?: unknown;
    };

    if (
      typeof raw.reason === 'string' &&
      raw.reason.trim()
    ) {
      return raw.reason.trim();
    }
  }

  if (typeof body === 'string') {
    const match = body.match(
      /"reason"\s*:\s*"([^"]+)"/i
    );

    if (match && match[1]) {
      return match[1];
    }
  }

  return null;
}

function parseSubscription(
  value: unknown
): WebPushSubscription {
  let parsed = value;

  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new Error(
        'Subscription contém JSON inválido.'
      );
    }
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null
  ) {
    throw new Error(
      'Subscription Push inválida.'
    );
  }

  const raw = parsed as {
    endpoint?: unknown;
    keys?: {
      p256dh?: unknown;
      auth?: unknown;
    };
  };

  const endpoint =
    typeof raw.endpoint === 'string'
      ? raw.endpoint.trim()
      : '';

  const p256dh =
    typeof raw.keys?.p256dh === 'string'
      ? raw.keys.p256dh.trim()
      : '';

  const auth =
    typeof raw.keys?.auth === 'string'
      ? raw.keys.auth.trim()
      : '';

  if (!endpoint) {
    throw new Error(
      'Subscription sem endpoint.'
    );
  }

  if (!p256dh) {
    throw new Error(
      'Subscription sem p256dh.'
    );
  }

  if (!auth) {
    throw new Error(
      'Subscription sem auth.'
    );
  }

  return {
    endpoint,
    keys: {
      p256dh,
      auth,
    },
  };
}

function getDevice(
  job: ReminderJobRow
): PushDeviceRow | null {
  if (Array.isArray(job.push_devices)) {
    return job.push_devices[0] ?? null;
  }

  return job.push_devices ?? null;
}

function validTime(
  value: unknown
): value is string {
  if (
    typeof value !== 'string' ||
    !/^\d{2}:\d{2}$/.test(value)
  ) {
    return false;
  }

  const [hour, minute] =
    value.split(':').map(Number);

  return (
    Number.isInteger(hour) &&
    Number.isInteger(minute) &&
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59
  );
}

function isInQuietHours(
  localNow: Date,
  start: string,
  end: string
): boolean {
  if (
    !validTime(start) ||
    !validTime(end)
  ) {
    return false;
  }

  const current =
    localNow.getHours() * 60 +
    localNow.getMinutes();

  const [startHour, startMinute] =
    start.split(':').map(Number);

  const [endHour, endMinute] =
    end.split(':').map(Number);

  const startMinutes =
    startHour * 60 + startMinute;

  const endMinutes =
    endHour * 60 + endMinute;

  if (startMinutes === endMinutes) {
    return false;
  }

  if (startMinutes < endMinutes) {
    return (
      current >= startMinutes &&
      current < endMinutes
    );
  }

  return (
    current >= startMinutes ||
    current < endMinutes
  );
}

function quietEndUtc(
  nowUtc: Date,
  timezone: string,
  start: string,
  end: string
): Date {
  const localNow =
    toZonedTime(
      nowUtc,
      timezone
    );

  const [startHour, startMinute] =
    start.split(':').map(Number);

  const [endHour, endMinute] =
    end.split(':').map(Number);

  const startMinutes =
    startHour * 60 + startMinute;

  const endMinutes =
    endHour * 60 + endMinute;

  const current =
    localNow.getHours() * 60 +
    localNow.getMinutes();

  const target =
    new Date(localNow);

  target.setHours(
    endHour,
    endMinute,
    0,
    0
  );

  if (
    startMinutes > endMinutes &&
    current >= startMinutes
  ) {
    target.setDate(
      target.getDate() + 1
    );
  }

  return fromZonedTime(
    target,
    timezone
  );
}

function getHeader(
  headers: unknown,
  wanted: string
): string | null {
  if (
    typeof headers !== 'object' ||
    headers === null
  ) {
    return null;
  }

  const record =
    headers as Record<
      string,
      unknown
    >;

  const key =
    Object.keys(record).find(
      (name) =>
        name.toLowerCase() ===
        wanted.toLowerCase()
    );

  if (!key) {
    return null;
  }

  const value =
    record[key];

  if (typeof value === 'string') {
    return value;
  }

  if (
    value === undefined ||
    value === null
  ) {
    return null;
  }

  return String(value);
}

function extractJwt(
  authorization: string | null
): string | null {
  if (!authorization) {
    return null;
  }

  const modern =
    authorization.match(
      /(?:^|\s|,)t=([^,\s]+)/i
    );

  if (
    modern &&
    modern[1]
  ) {
    return modern[1];
  }

  const parts =
    authorization
      .trim()
      .split(/\s+/);

  if (
    parts.length >= 2 &&
    parts[1] &&
    parts[1]
      .split('.')
      .length === 3
  ) {
    return parts[1];
  }

  return null;
}

function extractAuthPublicKey(
  authorization: string | null,
  cryptoKey: string | null
): string | null {
  if (authorization) {
    const match =
      authorization.match(
        /(?:^|\s|,)k=([^,\s]+)/i
      );

    if (
      match &&
      match[1]
    ) {
      return match[1];
    }
  }

  if (cryptoKey) {
    const match =
      cryptoKey.match(
        /(?:^|;)\s*p256ecdsa=([^;,\s]+)/i
      );

    if (
      match &&
      match[1]
    ) {
      return match[1];
    }
  }

  return null;
}

function decodeJwtObject(
  segment: string
): Record<string, unknown> | null {
  try {
    const text =
      Buffer.from(
        segment,
        'base64url'
      ).toString('utf8');

    const parsed: unknown =
      JSON.parse(text);

    if (
      typeof parsed !== 'object' ||
      parsed === null
    ) {
      return null;
    }

    return parsed as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

function subjectIsValid(
  value: unknown
): boolean {
  if (
    typeof value !== 'string' ||
    !value.trim()
  ) {
    return false;
  }

  const subject =
    value.trim();

  if (
    subject.startsWith(
      'mailto:'
    )
  ) {
    const email =
      subject.slice(7);

    return (
      email.includes('@') &&
      !email
        .toLowerCase()
        .endsWith(
          '@localhost'
        )
    );
  }

  try {
    const url =
      new URL(subject);

    return (
      url.protocol === 'https:' &&
      url.hostname !== 'localhost'
    );
  } catch {
    return false;
  }
}

function maskSubject(
  value: unknown
): string | null {
  if (
    typeof value !== 'string'
  ) {
    return null;
  }

  const subject =
    value.trim();

  if (
    !subject.startsWith(
      'mailto:'
    )
  ) {
    return subject || null;
  }

  const email =
    subject.slice(7);

  const at =
    email.indexOf('@');

  if (at <= 0) {
    return 'mailto:***';
  }

  const name =
    email.slice(
      0,
      at
    );

  const domain =
    email.slice(
      at + 1
    );

  return `mailto:${name.slice(
    0,
    1
  )}***@${domain}`;
}

function buildVapidDebug(
  webPush: ReturnType<
    typeof getWebPush
  >,
  subscription: WebPushSubscription,
  payload: string
): VapidDebug {
  const debug: VapidDebug = {
    endpointOrigin: null,
    endpointHost: null,
    applePushEndpoint: false,
    authorizationScheme: null,
    jwtExtracted: false,
    jwtSegments: 0,
    alg: null,
    typ: null,
    aud: null,
    audMatchesEndpointOrigin: null,
    subPreview: null,
    subValid: null,
    exp: null,
    expIso: null,
    expSecondsFromNow: null,
    expInFuture: null,
    expWithin24Hours: null,
    authorizationPublicKeyPresent: false,
    authorizationPublicKeyMatchesConfigured:
      null,
    configuredPublicKeyBytes: null,
    configuredPrivateKeyPresent:
      Boolean(
        cleanEnv(
          process.env
            .VAPID_PRIVATE_KEY
        )
      ),
    pairValidatedByPushServer:
      true,
    debugError: null,
  };

  try {
    const endpointUrl =
      new URL(
        subscription.endpoint
      );

    debug.endpointOrigin =
      endpointUrl.origin;

    debug.endpointHost =
      endpointUrl.hostname;

    debug.applePushEndpoint =
      endpointUrl.hostname ===
        'web.push.apple.com' ||
      endpointUrl.hostname.endsWith(
        '.push.apple.com'
      );

    const details =
      webPush.generateRequestDetails(
        subscription,
        payload,
        {
          TTL: 300,
        }
      );

    const authorization =
      getHeader(
        details.headers,
        'authorization'
      );

    const cryptoKey =
      getHeader(
        details.headers,
        'crypto-key'
      );

    if (authorization) {
      const parts =
        authorization
          .trim()
          .split(/\s+/);

      debug.authorizationScheme =
        parts[0] ?? null;
    }

    const authPublicKey =
      extractAuthPublicKey(
        authorization,
        cryptoKey
      );

    const configuredPublicKey =
      cleanEnv(
        process.env
          .NEXT_PUBLIC_VAPID_PUBLIC_KEY
      );

    debug.authorizationPublicKeyPresent =
      Boolean(
        authPublicKey
      );

    if (configuredPublicKey) {
      try {
        debug.configuredPublicKeyBytes =
          Buffer.from(
            configuredPublicKey,
            'base64url'
          ).length;
      } catch {
        debug.configuredPublicKeyBytes =
          null;
      }
    }

    if (
      authPublicKey &&
      configuredPublicKey
    ) {
      debug.authorizationPublicKeyMatchesConfigured =
        authPublicKey ===
        configuredPublicKey;
    }

    const jwt =
      extractJwt(
        authorization
      );

    if (!jwt) {
      debug.debugError =
        'Não foi possível extrair o JWT do header Authorization.';

      return debug;
    }

    debug.jwtExtracted =
      true;

    const segments =
      jwt.split('.');

    debug.jwtSegments =
      segments.length;

    if (
      segments.length !== 3
    ) {
      debug.debugError =
        'JWT VAPID não possui 3 segmentos.';

      return debug;
    }

    const header =
      decodeJwtObject(
        segments[0]
      );

    const claims =
      decodeJwtObject(
        segments[1]
      );

    if (header) {
      debug.alg =
        typeof header.alg ===
          'string'
          ? header.alg
          : null;

      debug.typ =
        typeof header.typ ===
          'string'
          ? header.typ
          : null;
    }

    if (claims) {
      debug.aud =
        typeof claims.aud ===
          'string'
          ? claims.aud
          : null;

      if (
        debug.aud &&
        debug.endpointOrigin
      ) {
        debug.audMatchesEndpointOrigin =
          debug.aud ===
          debug.endpointOrigin;
      }

      debug.subPreview =
        maskSubject(
          claims.sub
        );

      debug.subValid =
        subjectIsValid(
          claims.sub
        );

      const exp =
        typeof claims.exp ===
          'number'
          ? claims.exp
          : Number(
              claims.exp
            );

      if (
        Number.isFinite(exp)
      ) {
        const nowSeconds =
          Math.floor(
            Date.now() /
              1000
          );

        debug.exp =
          exp;

        debug.expSecondsFromNow =
          exp - nowSeconds;

        debug.expInFuture =
          exp >
          nowSeconds;

        debug.expWithin24Hours =
          exp >
            nowSeconds &&
          exp -
            nowSeconds <=
            86400;

        debug.expIso =
          new Date(
            exp * 1000
          ).toISOString();
      }
    }

    return debug;
  } catch (error) {
    debug.debugError =
      safeError(
        error
      );

    return debug;
  }
}

export async function GET(
  request: Request
) {
  try {
    const cronSecret =
      cleanEnv(
        process.env
          .CRON_SECRET
      );

    if (!cronSecret) {
      return reply(
        {
          ok: false,
          version:
            CRON_VERSION,
          stage:
            'cron-configuration',
          error:
            'CRON_SECRET não configurado.',
        },
        503
      );
    }

    if (
      request.headers.get(
        'authorization'
      ) !==
      `Bearer ${cronSecret}`
    ) {
      return reply(
        {
          ok: false,
          version:
            CRON_VERSION,
          stage:
            'authorization',
          error:
            'Unauthorized',
        },
        401
      );
    }

    const supabaseUrl =
      cleanEnv(
        process.env
          .SUPABASE_URL
      );

    const supabaseSecretKey =
      cleanEnv(
        process.env
          .SUPABASE_SECRET_KEY
      );

    if (
      !supabaseUrl ||
      !supabaseSecretKey
    ) {
      return reply(
        {
          ok: false,
          version:
            CRON_VERSION,
          stage:
            'supabase-configuration',
          error:
            'SUPABASE_URL ou SUPABASE_SECRET_KEY não configurada.',
        },
        503
      );
    }

    const supabase =
      createClient<any>(
        supabaseUrl,
        supabaseSecretKey,
        {
          auth: {
            persistSession:
              false,
            autoRefreshToken:
              false,
            detectSessionInUrl:
              false,
          },
        }
      );

    const {
      count:
        deviceCount,
      error:
        deviceError,
    } =
      await supabase
        .from(
          'push_devices'
        )
        .select(
          'device_id',
          {
            count:
              'exact',
            head:
              true,
          }
        );

    if (deviceError) {
      return reply(
        {
          ok: false,
          version:
            CRON_VERSION,
          stage:
            'supabase-connection',
          error:
            'Falha ao acessar push_devices.',
          code:
            deviceError.code,
          detail:
            deviceError.message,
        },
        500
      );
    }

    let webPush:
      ReturnType<
        typeof getWebPush
      >;

    try {
      webPush =
        getWebPush();
    } catch (error) {
      return reply(
        {
          ok: false,
          version:
            CRON_VERSION,
          stage:
            'vapid',
          error:
            'Falha ao configurar VAPID.',
          detail:
            safeError(
              error
            ),
        },
        503
      );
    }

    const {
      data:
        rawJobs,
      error:
        jobsError,
    } =
      await supabase
        .from(
          'reminder_jobs'
        )
        .select(
          `
          device_id,
          occurrence_id,
          medication_id,
          medication_label,
          scheduled_at,
          deadline_at,
          next_notify_at,
          repeat_minutes,
          phase,
          sound,
          vibration,
          required,
          url,
          active,
          last_sent_at,
          locked_until,
          push_devices!inner (
            subscription,
            timezone,
            quiet_enabled,
            quiet_start,
            quiet_end,
            active
          )
        `
        )
        .eq(
          'active',
          true
        )
        .eq(
          'push_devices.active',
          true
        )
        .lte(
          'next_notify_at',
          new Date()
            .toISOString()
        )
        .order(
          'next_notify_at',
          {
            ascending:
              true,
          }
        )
        .limit(100);

    if (jobsError) {
      return reply(
        {
          ok: false,
          version:
            CRON_VERSION,
          stage:
            'reminder-query',
          error:
            'Falha ao consultar reminder_jobs.',
          code:
            jobsError.code,
          detail:
            jobsError.message,
        },
        500
      );
    }

    const jobs =
      (
        rawJobs ??
        []
      ) as unknown as
        ReminderJobRow[];

    const selected =
      jobs.length;

    let claimed = 0;
    let skippedLocked = 0;
    let sent = 0;
    let failed = 0;
    let quiet = 0;
    let expired = 0;

    let lastVapidDebug:
      VapidDebug | null =
      null;

    let lastPushError:
      PushErrorDiagnostic | null =
      null;

    const pushErrors:
      PushErrorDiagnostic[] =
      [];

    for (
      const job of jobs
    ) {
      const iterationNow =
        new Date();

      if (
        job.locked_until
      ) {
        const lockDate =
          new Date(
            job.locked_until
          );

        if (
          Number.isFinite(
            lockDate.getTime()
          ) &&
          lockDate.getTime() >
            iterationNow.getTime()
        ) {
          skippedLocked++;
          continue;
        }
      }

      const lockUntil =
        new Date(
          iterationNow.getTime() +
            2 * 60_000
        ).toISOString();

      let claimQuery =
        supabase
          .from(
            'reminder_jobs'
          )
          .update({
            locked_until:
              lockUntil,
            updated_at:
              iterationNow
                .toISOString(),
          })
          .eq(
            'device_id',
            job.device_id
          )
          .eq(
            'occurrence_id',
            job.occurrence_id
          )
          .eq(
            'active',
            true
          );

      if (
        job.locked_until
      ) {
        claimQuery =
          claimQuery.eq(
            'locked_until',
            job.locked_until
          );
      } else {
        claimQuery =
          claimQuery.is(
            'locked_until',
            null
          );
      }

      const {
        data:
          claimedRows,
        error:
          claimError,
      } =
        await claimQuery
          .select(
            'occurrence_id'
          );

      if (claimError) {
        failed++;
        continue;
      }

      if (
        !claimedRows ||
        claimedRows.length ===
          0
      ) {
        skippedLocked++;
        continue;
      }

      claimed++;

      const device =
        getDevice(job);

      if (
        !device ||
        device.active ===
          false
      ) {
        await supabase
          .from(
            'reminder_jobs'
          )
          .update({
            active:
              false,
            locked_until:
              null,
            updated_at:
              new Date()
                .toISOString(),
          })
          .eq(
            'device_id',
            job.device_id
          )
          .eq(
            'occurrence_id',
            job.occurrence_id
          );

        continue;
      }

      const timezone =
        typeof device.timezone ===
          'string' &&
        device.timezone.trim()
          ? device.timezone
          : 'UTC';

      if (
        device.quiet_enabled ===
          true &&
        validTime(
          device.quiet_start
        ) &&
        validTime(
          device.quiet_end
        )
      ) {
        try {
          const localNow =
            toZonedTime(
              iterationNow,
              timezone
            );

          if (
            isInQuietHours(
              localNow,
              device.quiet_start,
              device.quiet_end
            )
          ) {
            const resumeAt =
              quietEndUtc(
                iterationNow,
                timezone,
                device.quiet_start,
                device.quiet_end
              );

            await supabase
              .from(
                'reminder_jobs'
              )
              .update({
                next_notify_at:
                  resumeAt
                    .toISOString(),
                locked_until:
                  null,
                updated_at:
                  new Date()
                    .toISOString(),
              })
              .eq(
                'device_id',
                job.device_id
              )
              .eq(
                'occurrence_id',
                job.occurrence_id
              );

            quiet++;
            continue;
          }
        } catch {
          // Timezone inválido:
          // segue o envio normalmente.
        }
      }

      const deadline =
        job.deadline_at
          ? new Date(
              job.deadline_at
            )
          : null;

      const deadlinePassed =
        Boolean(
          deadline &&
          Number.isFinite(
            deadline.getTime()
          ) &&
          deadline.getTime() <=
            Date.now()
        );

      const overdue =
        deadlinePassed ||
        job.phase ===
          'deadline' ||
        job.phase ===
          'repeat';

      const payload =
        JSON.stringify({
          title:
            overdue
              ? '⚠️ Medicamento ainda não confirmado'
              : 'Hora do medicamento',

          body:
            overdue
              ? `Você ainda não marcou ${job.medication_label} como tomado.`
              : `Está na hora de ${job.medication_label}.`,

          tag:
            `med-${job.occurrence_id}`,

          url:
            job.url || '/',

          occurrenceId:
            job.occurrence_id,

          medicationId:
            job.medication_id,

          overdue,

          sound:
            job.sound !==
            false,

          vibration:
            job.vibration !==
            false,

          requireInteraction:
            overdue,
        });

      try {
        const subscription =
          parseSubscription(
            device.subscription
          );

        lastVapidDebug =
          buildVapidDebug(
            webPush,
            subscription,
            payload
          );

        await webPush
          .sendNotification(
            subscription,
            payload,
            {
              TTL: 300,
            }
          );

        sent++;

        if (
          job.phase ===
            'main' &&
          job.required ===
            false
        ) {
          await supabase
            .from(
              'reminder_jobs'
            )
            .update({
              active:
                false,
              phase:
                'done',
              last_sent_at:
                new Date()
                  .toISOString(),
              locked_until:
                null,
              updated_at:
                new Date()
                  .toISOString(),
            })
            .eq(
              'device_id',
              job.device_id
            )
            .eq(
              'occurrence_id',
              job.occurrence_id
            );

          continue;
        }

        if (
          job.phase ===
            'main' &&
          deadline &&
          Number.isFinite(
            deadline.getTime()
          ) &&
          deadline.getTime() >
            Date.now()
        ) {
          await supabase
            .from(
              'reminder_jobs'
            )
            .update({
              next_notify_at:
                deadline
                  .toISOString(),
              phase:
                'deadline',
              last_sent_at:
                new Date()
                  .toISOString(),
              locked_until:
                null,
              updated_at:
                new Date()
                  .toISOString(),
            })
            .eq(
              'device_id',
              job.device_id
            )
            .eq(
              'occurrence_id',
              job.occurrence_id
            );

          continue;
        }

        const configured =
          Number(
            job.repeat_minutes
          );

        const repeatMinutes =
          [
            10,
            15,
            30,
            45,
            60,
          ].includes(
            configured
          )
            ? configured
            : 30;

        const nextNotifyAt =
          new Date(
            Date.now() +
              repeatMinutes *
                60_000
          );

        await supabase
          .from(
            'reminder_jobs'
          )
          .update({
            next_notify_at:
              nextNotifyAt
                .toISOString(),
            phase:
              'repeat',
            last_sent_at:
              new Date()
                .toISOString(),
            locked_until:
              null,
            updated_at:
              new Date()
                .toISOString(),
          })
          .eq(
            'device_id',
            job.device_id
          )
          .eq(
            'occurrence_id',
            job.occurrence_id
          );
      } catch (error) {
        failed++;

        const statusCode =
          getPushStatusCode(
            error
          );

        const body =
          getPushErrorBody(
            error
          );

        const reason =
          getPushErrorReason(
            body
          );

        const diagnostic:
          PushErrorDiagnostic =
          {
            occurrenceId:
              job.occurrence_id,

            medicationLabel:
              job.medication_label,

            statusCode,

            message:
              safeError(
                error
              ),

            reason,

            body,

            vapidDebug:
              lastVapidDebug,
          };

        lastPushError =
          diagnostic;

        if (
          pushErrors.length <
            10
        ) {
          pushErrors.push(
            diagnostic
          );
        }

        console.error(
          '[CRON] Web Push falhou:',
          diagnostic
        );

        if (
          statusCode ===
            404 ||
          statusCode ===
            410
        ) {
          expired++;

          await supabase
            .from(
              'push_devices'
            )
            .update({
              active:
                false,
              updated_at:
                new Date()
                  .toISOString(),
            })
            .eq(
              'device_id',
              job.device_id
            );

          await supabase
            .from(
              'reminder_jobs'
            )
            .update({
              active:
                false,
              locked_until:
                null,
              updated_at:
                new Date()
                  .toISOString(),
            })
            .eq(
              'device_id',
              job.device_id
            );

          continue;
        }

        const retryAt =
          new Date(
            Date.now() +
              5 * 60_000
          );

        await supabase
          .from(
            'reminder_jobs'
          )
          .update({
            next_notify_at:
              retryAt
                .toISOString(),
            locked_until:
              null,
            updated_at:
              new Date()
                .toISOString(),
          })
          .eq(
            'device_id',
            job.device_id
          )
          .eq(
            'occurrence_id',
            job.occurrence_id
          );
      }
    }

    return reply({
      ok: true,

      version:
        CRON_VERSION,

      stage:
        'complete',

      supabase:
        'connected',

      push:
        'configured',

      pushDevices:
        deviceCount ?? 0,

      selected,

      claimed,

      skippedLocked,

      sent,

      failed,

      vapidDebug:
        lastVapidDebug,

      lastPushError,

      pushErrors,

      quiet,

      expiredSubscriptions:
        expired,

      timestamp:
        new Date()
          .toISOString(),
    });
  } catch (error) {
    return reply(
      {
        ok: false,

        version:
          CRON_VERSION,

        stage:
          'unhandled',

        error:
          'Erro inesperado no cron.',

        detail:
          safeError(
            error
          ),
      },
      500
    );
  }
}
