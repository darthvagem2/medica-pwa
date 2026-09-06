import { NextResponse } from 'next/server';
import { Pool, type PoolClient } from 'pg';
import {
  fromZonedTime,
  toZonedTime,
} from 'date-fns-tz';

import { getWebPush } from '@/lib/push-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * =========================================================
 * POSTGRESQL
 * =========================================================
 *
 * O Pool fica dentro desta própria rota.
 *
 * Isso evita depender de server-db.ts durante o diagnóstico
 * e também evita criar uma nova conexão a cada chamada quando
 * a mesma instância serverless é reutilizada.
 */

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

    /**
     * Supabase exige SSL fora de localhost.
     */
    ssl: connectionString.includes('localhost')
      ? undefined
      : {
          rejectUnauthorized: false,
        },

    /**
     * Poucas conexões porque estamos usando
     * Supabase Transaction Pooler.
     */
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

/**
 * =========================================================
 * UTILIDADES
 * =========================================================
 */

function safeErrorMessage(
  error: unknown
): string {
  let message =
    error instanceof Error
      ? error.message
      : String(error);

  /**
   * Remove connection strings caso alguma biblioteca
   * inclua credenciais dentro da mensagem.
   */
  message = message.replace(
    /postgres(?:ql)?:\/\/[^@\s]+@/gi,
    'postgresql://***@'
  );

  /**
   * Remove Authorization Bearer caso apareça
   * acidentalmente em uma exceção.
   */
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
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error
  ) {
    const value = Number(
      (error as { statusCode?: unknown })
        .statusCode
    );

    return Number.isFinite(value)
      ? value
      : null;
  }

  return null;
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

  /**
   * Mesmo horário = horário silencioso desativado
   * para evitar interpretar como 24 horas.
   */
  if (startMinutes === endMinutes) {
    return false;
  }

  /**
   * Exemplo:
   * 13:00 → 15:00
   */
  if (startMinutes < endMinutes) {
    return (
      nowMinutes >= startMinutes &&
      nowMinutes < endMinutes
    );
  }

  /**
   * Exemplo:
   * 23:00 → 07:00
   */
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

  /**
   * Horário silencioso cruza meia-noite:
   *
   * 23:00 → 07:00
   *
   * Se agora for 23:30,
   * o fim será amanhã 07:00.
   */
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

async function safeRollback(
  client: PoolClient
): Promise<void> {
  try {
    await client.query('rollback');
  } catch (error) {
    console.error(
      '[CRON] Falha no rollback:',
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
      '[CRON] Falha ao liberar lock:',
      safeErrorMessage(error)
    );
  }
}

function parseSubscription(
  value: unknown
) {
  if (!value) {
    throw new Error(
      'Push subscription vazia.'
    );
  }

  let subscription = value;

  if (
    typeof subscription === 'string'
  ) {
    subscription =
      JSON.parse(subscription);
  }

  if (
    typeof subscription !== 'object' ||
    subscription === null
  ) {
    throw new Error(
      'Push subscription inválida.'
    );
  }

  const sub =
    subscription as {
      endpoint?: string;
      keys?: {
        p256dh?: string;
        auth?: string;
      };
    };

  if (
    !sub.endpoint ||
    !sub.keys?.p256dh ||
    !sub.keys?.auth
  ) {
    throw new Error(
      'Push subscription incompleta.'
    );
  }

  return sub;
}

/**
 * =========================================================
 * ENDPOINT DO CRON
 * =========================================================
 */

export async function GET(
  request: Request
) {
  /**
   * =======================================================
   * 1. AUTENTICAR CRON
   * =======================================================
   */

  const cronSecret =
    process.env.CRON_SECRET?.trim();

  if (!cronSecret) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'CRON_SECRET não configurado na Vercel.',
      },
      {
        status: 503,
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
      }
    );
  }

  /**
   * =======================================================
   * 2. INICIALIZAR POSTGRESQL
   * =======================================================
   */

  let dbPool: Pool | null;

  try {
    dbPool = getDbPool();
  } catch (error) {
    console.error(
      '[CRON] Falha ao criar Pool:',
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

  /**
   * =======================================================
   * 3. TESTAR CONEXÃO COM SUPABASE
   * =======================================================
   */

  let client: PoolClient;

  try {
    client =
      await dbPool.connect();
  } catch (error) {
    console.error(
      '[CRON] Falha em pool.connect():',
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

  /**
   * Antes de prosseguir, fazemos uma consulta simples.
   */
  try {
    await client.query(
      'select 1'
    );
  } catch (error) {
    client.release();

    console.error(
      '[CRON] Banco conectado, mas SELECT 1 falhou:',
      error
    );

    return NextResponse.json(
      {
        ok: false,

        stage:
          'database-test',

        error:
          'A conexão foi criada, mas o PostgreSQL recusou a consulta.',

        detail:
          safeErrorMessage(error),
      },
      {
        status: 500,
      }
    );
  }

  /**
   * =======================================================
   * 4. CONFIGURAR WEB PUSH
   * =======================================================
   */

  let webPush: ReturnType<
    typeof getWebPush
  >;

  try {
    webPush =
      getWebPush();
  } catch (error) {
    client.release();

    console.error(
      '[CRON] Falha no VAPID:',
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

  /**
   * =======================================================
   * 5. BUSCAR JOBS VENCIDOS
   * =======================================================
   */

  let jobs: any[] = [];

  try {
    await client.query(
      'begin'
    );

    const result =
      await client.query(
        `
          select
            j.*,

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

    /**
     * Reserva os jobs por 2 minutos.
     *
     * Assim dois cron workers não enviam
     * a mesma notificação simultaneamente.
     */
    for (const job of jobs) {
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
      '[CRON] Falha ao consultar reminder_jobs:',
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

  /**
   * =======================================================
   * 6. PROCESSAR JOBS
   * =======================================================
   */

  let sent = 0;
  let failed = 0;
  let quiet = 0;
  let expired = 0;

  for (const job of jobs) {
    const now =
      new Date();

    const timezone =
      typeof job.timezone ===
        'string'
        ? job.timezone
        : 'UTC';

    /**
     * =====================================================
     * HORÁRIO SILENCIOSO
     * =====================================================
     */

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
          '[CRON] Erro no horário silencioso:',
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

    /**
     * =====================================================
     * DEFINIR SE ESTÁ ATRASADO
     * =====================================================
     */

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

    /**
     * =====================================================
     * PAYLOAD DA NOTIFICAÇÃO
     * =====================================================
     */

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

    /**
     * =====================================================
     * ENVIAR WEB PUSH
     * =====================================================
     */

    try {
      const subscription =
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

      /**
       * ===================================================
       * MEDICAMENTO OPCIONAL
       * ===================================================
       */

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

      /**
       * ===================================================
       * CALCULAR PRÓXIMO ALERTA
       * ===================================================
       */

      let nextNotifyAt: Date;
      let nextPhase:
        | 'deadline'
        | 'repeat';

      /**
       * Se foi o primeiro lembrete e ainda existe
       * um deadline futuro, o próximo alerta ocorre
       * exatamente no deadline.
       */
      if (
        job.phase === 'main' &&
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
        /**
         * Após o limite, usamos o intervalo configurado.
         */
        const rawRepeat =
          Number(
            job.repeat_minutes
          );

        const repeatMinutes =
          [10, 15, 30, 45, 60]
            .includes(rawRepeat)
            ? rawRepeat
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
        getStatusCode(error);

      console.error(
        '[CRON] Erro no Web Push:',
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

      /**
       * ===================================================
       * PUSH SUBSCRIPTION EXPIRADA
       * ===================================================
       *
       * 404 ou 410 significa que o navegador não aceita
       * mais aquela subscription.
       */

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
            '[CRON] Falha ao desativar subscription:',
            safeErrorMessage(
              databaseError
            )
          );
        }

        continue;
      }

      /**
       * ===================================================
       * ERRO TEMPORÁRIO
       * ===================================================
       *
       * Reagenda em 5 minutos.
       */

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
          '[CRON] Não foi possível reagendar o job:',
          safeErrorMessage(
            databaseError
          )
        );
      }
    }
  }

  /**
   * =======================================================
   * 7. RESULTADO
   * =======================================================
   */

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
