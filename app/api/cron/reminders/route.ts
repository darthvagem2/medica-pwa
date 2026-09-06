import { NextResponse } from 'next/server';
import { Pool, type PoolClient } from 'pg';
import type { PushSubscription as WebPushSubscription } from 'web-push';

import {
  fromZonedTime,
  toZonedTime,
} from 'date-fns-tz';

import { getWebPush } from '@/lib/push-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/* =========================================================
   TIPOS
========================================================= */

type ReminderPhase =
  | 'main'
  | 'deadline'
  | 'repeat'
  | 'done';

type ReminderJobRow = {
  device_id: string;
  occurrence_id: string;
  medication_id: string;
  medication_label: string;

  scheduled_at: Date | string;
  deadline_at: Date | string | null;
  next_notify_at: Date | string;

  repeat_minutes: number;
  phase: ReminderPhase;

  sound: boolean;
  vibration: boolean;
  required: boolean;

  url: string | null;
  active: boolean;

  last_sent_at: Date | string | null;
  locked_until: Date | string | null;

  subscription: unknown;

  timezone: string | null;

  quiet_enabled: boolean;
  quiet_start: string | null;
  quiet_end: string | null;
};

/* =========================================================
   POSTGRESQL
========================================================= */

let cachedPool: Pool | null = null;

function getDbPool(): Pool | null {
  const connectionString =
    process.env.DATABASE_URL?.trim();

  if (!connectionString) {
    return null;
  }

  if (cachedPool) {
    return cachedPool;
  }

  cachedPool = new Pool({
    connectionString,

    ssl: connectionString.includes('localhost')
      ? undefined
      : {
          rejectUnauthorized: false,
        },

    // Supabase Transaction Pooler / serverless.
    max: 2,

    idleTimeoutMillis: 30_000,

    connectionTimeoutMillis: 10_000,
  });

  cachedPool.on('error', (error) => {
    console.error(
      '[CRON][POSTGRES] Erro inesperado no pool:',
      error
    );
  });

  return cachedPool;
}

/* =========================================================
   ERROS
========================================================= */

function safeErrorMessage(
  error: unknown
): string {
  let message =
    error instanceof Error
      ? error.message
      : String(error);

  // Oculta credentials PostgreSQL.
  message = message.replace(
    /postgres(?:ql)?:\/\/[^@\s]+@/gi,
    'postgresql://***@'
  );

  // Oculta Bearer tokens.
  message = message.replace(
    /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
    'Bearer ***'
  );

  return message;
}

function getStatusCode(
  error: unknown
): number | null {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('statusCode' in error)
  ) {
    return null;
  }

  const value = Number(
    (error as { statusCode?: unknown })
      .statusCode
  );

  return Number.isFinite(value)
    ? value
    : null;
}

/* =========================================================
   HORÁRIOS
========================================================= */

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

function inQuietHours(
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

  const nowMinutes =
    localNow.getHours() * 60 +
    localNow.getMinutes();

  const [startHour, startMinute] =
    start.split(':').map(Number);

  const [endHour, endMinute] =
    end.split(':').map(Number);

  const startMinutes =
    startHour * 60 +
    startMinute;

  const endMinutes =
    endHour * 60 +
    endMinute;

  // Mesmo horário = silencioso desativado.
  if (startMinutes === endMinutes) {
    return false;
  }

  // Ex.: 13:00 → 18:00
  if (startMinutes < endMinutes) {
    return (
      nowMinutes >= startMinutes &&
      nowMinutes < endMinutes
    );
  }

  // Ex.: 23:00 → 07:00
  return (
    nowMinutes >= startMinutes ||
    nowMinutes < endMinutes
  );
}

function getQuietEndUtc(
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
    startHour * 60 +
    startMinute;

  const endMinutes =
    endHour * 60 +
    endMinute;

  const nowMinutes =
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

  // Ex.: 23:00 → 07:00
  // se agora é 23:30, 07:00 é amanhã.
  if (
    startMinutes > endMinutes &&
    nowMinutes >= startMinutes
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

/* =========================================================
   TRANSAÇÕES
========================================================= */

async function safeRollback(
  client: PoolClient
): Promise<void> {
  try {
    await client.query('rollback');
  } catch (error) {
    console.error(
      '[CRON] Erro durante rollback:',
      error
    );
  }
}

async function unlockJob(
  pool: Pool,
  deviceId: string,
  occurrenceId: string
): Promise<void> {
  try {
    await pool.query(
      `
        update reminder_jobs
        set
          locked_until = null,
          updated_at = now()
        where
          device_id = $1
          and occurrence_id = $2
      `,
      [
        deviceId,
        occurrenceId,
      ]
    );
  } catch (error) {
    console.error(
      '[CRON] Não foi possível liberar lock:',
      safeErrorMessage(error)
    );
  }
}

/* =========================================================
   PUSH SUBSCRIPTION

   IMPORTANTE:
   Esta função agora RETORNA explicitamente
   WebPushSubscription.

   Isso corrige o erro da Vercel:

   string | undefined is not assignable to string
========================================================= */

function parseSubscription(
  value: unknown
): WebPushSubscription {
  let parsed: unknown = value;

  if (typeof parsed === 'string') {
    try {
      parsed =
        JSON.parse(parsed);
    } catch {
      throw new Error(
        'Push subscription contém JSON inválido.'
      );
    }
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null
  ) {
    throw new Error(
      'Push subscription inválida.'
    );
  }

  const raw =
    parsed as {
      endpoint?: unknown;

      keys?: {
        p256dh?: unknown;
        auth?: unknown;
      };
    };

  if (
    typeof raw.endpoint !== 'string' ||
    raw.endpoint.trim() === ''
  ) {
    throw new Error(
      'Push subscription sem endpoint.'
    );
  }

  if (
    typeof raw.keys?.p256dh !== 'string' ||
    raw.keys.p256dh.trim() === ''
  ) {
    throw new Error(
      'Push subscription sem chave p256dh.'
    );
  }

  if (
    typeof raw.keys?.auth !== 'string' ||
    raw.keys.auth.trim() === ''
  ) {
    throw new Error(
      'Push subscription sem chave auth.'
    );
  }

  /*
   * Agora endpoint/p256dh/auth são
   * definitivamente strings.
   */
  const subscription: WebPushSubscription = {
    endpoint:
      raw.endpoint,

    keys: {
      p256dh:
        raw.keys.p256dh,

      auth:
        raw.keys.auth,
    },
  };

  return subscription;
}

/* =========================================================
   API
========================================================= */

export async function GET(
  request: Request
) {
  /* =======================================================
     1. CRON SECRET
  ======================================================= */

  const cronSecret =
    process.env.CRON_SECRET?.trim();

  if (!cronSecret) {
    return NextResponse.json(
      {
        ok: false,

        stage:
          'cron-configuration',

        error:
          'CRON_SECRET não configurado na Vercel.',
      },
      {
        status: 503,

        headers: {
          'Cache-Control':
            'no-store',
        },
      }
    );
  }

  const authorization =
    request.headers.get(
      'authorization'
    );

  if (
    authorization !==
    `Bearer ${cronSecret}`
  ) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Unauthorized',
      },
      {
        status: 401,

        headers: {
          'Cache-Control':
            'no-store',
        },
      }
    );
  }

  /* =======================================================
     2. DATABASE
  ======================================================= */

  let dbPool: Pool | null;

  try {
    dbPool =
      getDbPool();
  } catch (error) {
    console.error(
      '[CRON] Erro ao criar Pool:',
      error
    );

    return NextResponse.json(
      {
        ok: false,

        stage:
          'database-initialization',

        error:
          'Falha ao inicializar banco de dados.',

        detail:
          safeErrorMessage(error),
      },
      {
        status: 500,
      }
    );
  }

  if (!dbPool) {
    return NextResponse.json(
      {
        ok: false,

        stage:
          'database-configuration',

        error:
          'DATABASE_URL não configurada na Vercel.',
      },
      {
        status: 503,
      }
    );
  }

  /* =======================================================
     3. TESTE DO BANCO
  ======================================================= */

  let client: PoolClient;

  try {
    client =
      await dbPool.connect();
  } catch (error) {
    console.error(
      '[CRON] pool.connect() falhou:',
      error
    );

    return NextResponse.json(
      {
        ok: false,

        stage:
          'database-connection',

        error:
          'Falha ao conectar ao banco de dados.',

        detail:
          safeErrorMessage(error),
      },
      {
        status: 500,
      }
    );
  }

  try {
    await client.query(
      'select 1'
    );
  } catch (error) {
    client.release();

    console.error(
      '[CRON] SELECT 1 falhou:',
      error
    );

    return NextResponse.json(
      {
        ok: false,

        stage:
          'database-test',

        error:
          'PostgreSQL recusou a consulta de teste.',

        detail:
          safeErrorMessage(error),
      },
      {
        status: 500,
      }
    );
  }

  /* =======================================================
     4. VAPID / WEB PUSH
  ======================================================= */

  let webPush: ReturnType<
    typeof getWebPush
  >;

  try {
    webPush =
      getWebPush();
  } catch (error) {
    client.release();

    console.error(
      '[CRON] VAPID inválido:',
      error
    );

    return NextResponse.json(
      {
        ok: false,

        stage:
          'vapid',

        error:
          'Falha ao configurar Web Push.',

        detail:
          safeErrorMessage(error),
      },
      {
        status: 503,
      }
    );
  }

  /* =======================================================
     5. RESERVAR JOBS VENCIDOS
  ======================================================= */

  let jobs:
    ReminderJobRow[] = [];

  try {
    await client.query(
      'begin'
    );

    const result =
      await client.query<ReminderJobRow>(
        `
          select
            j.device_id,
            j.occurrence_id,
            j.medication_id,
            j.medication_label,

            j.scheduled_at,
            j.deadline_at,
            j.next_notify_at,

            j.repeat_minutes,
            j.phase,

            j.sound,
            j.vibration,
            j.required,

            j.url,
            j.active,

            j.last_sent_at,
            j.locked_until,

            d.subscription,
            d.timezone,

            d.quiet_enabled,
            d.quiet_start,
            d.quiet_end

          from reminder_jobs j

          inner join push_devices d
            on d.device_id =
               j.device_id

          where
            j.active = true

            and d.active = true

            and j.next_notify_at
              <= now()

            and (
              j.locked_until is null

              or

              j.locked_until
                < now()
            )

          order by
            j.next_notify_at asc

          for update of j
          skip locked

          limit 100
        `
      );

    jobs =
      result.rows;

    for (
      const job of jobs
    ) {
      await client.query(
        `
          update reminder_jobs

          set
            locked_until =
              now()
              + interval '2 minutes',

            updated_at =
              now()

          where
            device_id = $1

            and occurrence_id = $2
        `,
        [
          job.device_id,
          job.occurrence_id,
        ]
      );
    }

    await client.query(
      'commit'
    );
  } catch (error) {
    await safeRollback(
      client
    );

    client.release();

    console.error(
      '[CRON] Erro ao consultar reminder_jobs:',
      error
    );

    return NextResponse.json(
      {
        ok: false,

        stage:
          'reminder-query',

        error:
          'Falha ao consultar lembretes.',

        detail:
          safeErrorMessage(error),
      },
      {
        status: 500,
      }
    );
  }

  client.release();

  /* =======================================================
     6. PROCESSAR
  ======================================================= */

  let sent = 0;
  let failed = 0;
  let quiet = 0;
  let expired = 0;

  for (
    const job of jobs
  ) {
    const now =
      new Date();

    const timezone =
      typeof job.timezone ===
        'string' &&
      job.timezone
        ? job.timezone
        : 'UTC';

    /* =====================================================
       QUIET HOURS
    ===================================================== */

    if (
      job.quiet_enabled === true &&
      validTime(
        job.quiet_start
      ) &&
      validTime(
        job.quiet_end
      )
    ) {
      try {
        const localNow =
          toZonedTime(
            now,
            timezone
          );

        if (
          inQuietHours(
            localNow,
            job.quiet_start,
            job.quiet_end
          )
        ) {
          const resumeAt =
            getQuietEndUtc(
              now,
              timezone,
              job.quiet_start,
              job.quiet_end
            );

          await dbPool.query(
            `
              update reminder_jobs

              set
                next_notify_at = $3,
                locked_until = null,
                updated_at = now()

              where
                device_id = $1
                and occurrence_id = $2
            `,
            [
              job.device_id,
              job.occurrence_id,
              resumeAt,
            ]
          );

          quiet++;

          continue;
        }
      } catch (error) {
        failed++;

        console.error(
          '[CRON] Erro em quiet hours:',
          safeErrorMessage(error)
        );

        await unlockJob(
          dbPool,
          job.device_id,
          job.occurrence_id
        );

        continue;
      }
    }

    /* =====================================================
       ATRASO
    ===================================================== */

    const deadlinePassed =
      Boolean(
        job.deadline_at &&
        new Date(
          job.deadline_at
        ).getTime() <=
          now.getTime()
      );

    const overdue =
      deadlinePassed ||
      job.phase ===
        'deadline' ||
      job.phase ===
        'repeat';

    /* =====================================================
       PAYLOAD
    ===================================================== */

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

        requireInteraction:
          overdue,

        vibration:
          job.vibration !== false,

        sound:
          job.sound !== false,
      });

    /* =====================================================
       ENVIAR PUSH
    ===================================================== */

    try {
      const subscription:
        WebPushSubscription =
          parseSubscription(
            job.subscription
          );

      await webPush.sendNotification(
        subscription,
        payload,
        {
          TTL: 300,
        }
      );

      sent++;

      /* ===================================================
         OPCIONAL: ENCERRA APÓS PRINCIPAL
      =================================================== */

      if (
        job.phase === 'main' &&
        job.required === false
      ) {
        await dbPool.query(
          `
            update reminder_jobs

            set
              active = false,
              phase = 'done',

              last_sent_at =
                now(),

              locked_until =
                null,

              updated_at =
                now()

            where
              device_id = $1
              and occurrence_id = $2
          `,
          [
            job.device_id,
            job.occurrence_id,
          ]
        );

        continue;
      }

      /* ===================================================
         PRÓXIMA NOTIFICAÇÃO
      =================================================== */

      let nextNotifyAt: Date;

      let nextPhase:
        | 'deadline'
        | 'repeat';

      if (
        job.phase ===
          'main' &&
        job.deadline_at &&
        new Date(
          job.deadline_at
        ).getTime() >
          now.getTime()
      ) {
        nextNotifyAt =
          new Date(
            job.deadline_at
          );

        nextPhase =
          'deadline';
      } else {
        const configured =
          Number(
            job.repeat_minutes
          );

        const repeatMinutes =
          [10, 15, 30, 45, 60]
            .includes(configured)
            ? configured
            : 30;

        nextNotifyAt =
          new Date(
            now.getTime() +
            repeatMinutes *
              60_000
          );

        nextPhase =
          'repeat';
      }

      await dbPool.query(
        `
          update reminder_jobs

          set
            next_notify_at = $3,
            phase = $4,

            last_sent_at =
              now(),

            locked_until =
              null,

            updated_at =
              now()

          where
            device_id = $1
            and occurrence_id = $2
        `,
        [
          job.device_id,
          job.occurrence_id,
          nextNotifyAt,
          nextPhase,
        ]
      );
    } catch (error) {
      failed++;

      const statusCode =
        getStatusCode(
          error
        );

      console.error(
        '[CRON] Web Push falhou:',
        {
          occurrenceId:
            job.occurrence_id,

          medicationId:
            job.medication_id,

          statusCode,

          message:
            safeErrorMessage(
              error
            ),
        }
      );

      /* ===================================================
         SUBSCRIPTION EXPIRADA
      =================================================== */

      if (
        statusCode === 404 ||
        statusCode === 410
      ) {
        expired++;

        try {
          await dbPool.query(
            `
              update push_devices

              set
                active = false,
                updated_at = now()

              where
                device_id = $1
            `,
            [
              job.device_id,
            ]
          );

          await dbPool.query(
            `
              update reminder_jobs

              set
                active = false,
                locked_until = null,
                updated_at = now()

              where
                device_id = $1
                and occurrence_id = $2
            `,
            [
              job.device_id,
              job.occurrence_id,
            ]
          );
        } catch (
          databaseError
        ) {
          console.error(
            '[CRON] Não foi possível desativar subscription inválida:',
            safeErrorMessage(
              databaseError
            )
          );
        }

        continue;
      }

      /* ===================================================
         ERRO TRANSITÓRIO: RETENTAR EM 5 MIN
      =================================================== */

      try {
        await dbPool.query(
          `
            update reminder_jobs

            set
              next_notify_at =
                now()
                + interval '5 minutes',

              locked_until =
                null,

              updated_at =
                now()

            where
              device_id = $1
              and occurrence_id = $2
          `,
          [
            job.device_id,
            job.occurrence_id,
          ]
        );
      } catch (
        databaseError
      ) {
        console.error(
          '[CRON] Não foi possível reagendar:',
          safeErrorMessage(
            databaseError
          )
        );
      }
    }
  }

  /* =======================================================
     7. RESPOSTA
  ======================================================= */

  return NextResponse.json(
    {
      ok: true,

      database:
        'connected',

      push:
        'configured',

      selected:
        jobs.length,

      sent,

      failed,

      quiet,

      expiredSubscriptions:
        expired,

      timestamp:
        new Date().toISOString(),
    },
    {
      status: 200,

      headers: {
        'Cache-Control':
          'no-store, max-age=0',
      },
    }
  );
}
