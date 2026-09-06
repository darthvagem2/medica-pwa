import { NextResponse } from 'next/server';
import type { PoolClient, Pool } from 'pg';

import {
  fromZonedTime,
  toZonedTime,
} from 'date-fns-tz';

import { getPool } from '@/lib/server-db';
import { getWebPush } from '@/lib/push-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Verifica se o horário local atual está dentro
 * do período silencioso.
 */
function inQuiet(
  now: Date,
  start: string,
  end: string
): boolean {
  const nowMinutes =
    now.getHours() * 60 +
    now.getMinutes();

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
   * Exemplo:
   * 22:00 → 23:00
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

/**
 * Calcula quando termina o horário silencioso,
 * respeitando o fuso horário do dispositivo.
 */
function quietEndUtc(
  nowUtc: Date,
  timezone: string,
  start: string,
  end: string
): Date {
  const local =
    toZonedTime(
      nowUtc,
      timezone
    );

  const [endHour, endMinute] =
    end.split(':').map(Number);

  const [startHour, startMinute] =
    start.split(':').map(Number);

  const nowMinutes =
    local.getHours() * 60 +
    local.getMinutes();

  const startMinutes =
    startHour * 60 +
    startMinute;

  const endMinutes =
    endHour * 60 +
    endMinute;

  const target =
    new Date(local);

  target.setHours(
    endHour,
    endMinute,
    0,
    0
  );

  /**
   * Exemplo:
   *
   * silencioso:
   * 23:00 → 07:00
   *
   * agora:
   * 23:30
   *
   * o término é amanhã às 07:00.
   */
  if (
    startMinutes >= endMinutes &&
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

/**
 * Evita vazar connection strings,
 * tokens e outros dados sensíveis
 * nas respostas de diagnóstico.
 */
function safeErrorMessage(
  error: unknown
): string {
  let message: string;

  if (error instanceof Error) {
    message = error.message;
  } else {
    message = String(error);
  }

  return message
    .replace(
      /postgres(?:ql)?:\/\/[^@\s]+@/gi,
      'postgresql://***@'
    )
    .replace(
      /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
      'Bearer ***'
    );
}

/**
 * Tenta executar rollback sem mascarar
 * o erro original.
 */
async function safeRollback(
  client: PoolClient
): Promise<void> {
  try {
    await client.query('rollback');
  } catch (rollbackError) {
    console.error(
      '[CRON] Falha ao executar rollback:',
      rollbackError
    );
  }
}

/**
 * Libera o lock de um job em caso de falha.
 */
async function unlockJob(
  dbPool: Pool,
  deviceId: string,
  occurrenceId: string
): Promise<void> {
  try {
    await dbPool.query(
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
      error
    );
  }
}

export async function GET(
  req: Request
) {
  /**
   * ===================================
   * 1. AUTENTICAÇÃO DO CRON
   * ===================================
   */

  const cronSecret =
    process.env.CRON_SECRET?.trim();

  if (
    process.env.NODE_ENV ===
      'production' &&
    !cronSecret
  ) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'CRON_SECRET não configurado',
      },
      {
        status: 503,
      }
    );
  }

  const authorization =
    req.headers.get(
      'authorization'
    );

  if (
    cronSecret &&
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
   * ===================================
   * 2. INICIALIZAR POSTGRESQL
   * ===================================
   *
   * Agora usamos getPool().
   *
   * Dessa forma o Pool não é criado
   * automaticamente durante o import
   * do módulo.
   */

  let dbPool: Pool | null;

  try {
    dbPool = getPool();
  } catch (error) {
    console.error(
      '[CRON] Falha ao inicializar PostgreSQL:',
      error
    );

    return NextResponse.json(
      {
        ok: false,

        error:
          'Falha ao inicializar banco de dados',

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
        error:
          'DATABASE_URL não configurada',
      },
      {
        status: 503,
      }
    );
  }

  /**
   * ===================================
   * 3. INICIALIZAR WEB PUSH / VAPID
   * ===================================
   */

  let webPush: ReturnType<
    typeof getWebPush
  >;

  try {
    webPush = getWebPush();
  } catch (error) {
    console.error(
      '[CRON] Falha ao inicializar Web Push:',
      error
    );

    return NextResponse.json(
      {
        ok: false,

        error:
          'Falha ao configurar Web Push',

        detail:
          safeErrorMessage(error),
      },
      {
        status: 503,
      }
    );
  }

  /**
   * ===================================
   * 4. TESTAR CONEXÃO COM POSTGRESQL
   * ===================================
   */

  let client: PoolClient;

  try {
    client =
      await dbPool.connect();
  } catch (error) {
    console.error(
      '[CRON] Falha ao conectar ao PostgreSQL:',
      error
    );

    return NextResponse.json(
      {
        ok: false,

        error:
          'Falha ao conectar ao banco de dados',

        detail:
          safeErrorMessage(error),
      },
      {
        status: 500,
      }
    );
  }

  /**
   * ===================================
   * 5. BUSCAR JOBS VENCIDOS
   * ===================================
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
              j.locked_until < now()
            )

          order by
            j.next_notify_at asc

          for update of j
          skip locked

          limit 100
        `
      );

    jobs = result.rows;

    /**
     * Reserva os jobs por dois minutos.
     *
     * Isso reduz a chance de dois workers
     * enviarem o mesmo lembrete.
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

    console.error(
      '[CRON] Falha ao consultar reminder_jobs:',
      error
    );

    return NextResponse.json(
      {
        ok: false,

        error:
          'Falha ao consultar lembretes',

        detail:
          safeErrorMessage(error),
      },
      {
        status: 500,
      }
    );
  } finally {
    client.release();
  }

  /**
   * ===================================
   * 6. PROCESSAR JOBS
   * ===================================
   */

  let sent = 0;
  let failed = 0;
  let quiet = 0;
  let expiredSubscriptions = 0;

  for (const job of jobs) {
    const now =
      new Date();

    const timezone =
      job.timezone ||
      'UTC';

    /**
     * ===================================
     * HORÁRIO SILENCIOSO
     * ===================================
     */

    if (
      job.quiet_enabled === true &&
      job.quiet_start &&
      job.quiet_end
    ) {
      const localNow =
        toZonedTime(
          now,
          timezone
        );

      const isQuiet =
        inQuiet(
          localNow,
          job.quiet_start,
          job.quiet_end
        );

      if (isQuiet) {
        try {
          const resumeAt =
            quietEndUtc(
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
              resumeAt,
            ]
          );

          quiet++;

          continue;
        } catch (error) {
          failed++;

          console.error(
            '[CRON] Falha ao adiar lembrete por horário silencioso:',
            {
              occurrenceId:
                job.occurrence_id,

              error:
                safeErrorMessage(
                  error
                ),
            }
          );

          await unlockJob(
            dbPool,
            job.device_id,
            job.occurrence_id
          );

          continue;
        }
      }
    }

    /**
     * ===================================
     * DEFINIR TIPO DO ALERTA
     * ===================================
     */

    const deadlinePassed =
      Boolean(
        job.deadline_at &&
        new Date(
          job.deadline_at
        ) <= now
      );

    const overdue =
      deadlinePassed ||
      job.phase ===
        'deadline' ||
      job.phase ===
        'repeat';

    const title =
      overdue
        ? '⚠️ Medicamento ainda não confirmado'
        : 'Hora do medicamento';

    const body =
      overdue
        ? `Você ainda não marcou ${job.medication_label} como tomado.`
        : `Está na hora de ${job.medication_label}.`;

    const payload =
      JSON.stringify({
        title,

        body,

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
          Boolean(
            job.vibration
          ),

        sound:
          Boolean(
            job.sound
          ),
      });

    /**
     * ===================================
     * ENVIAR WEB PUSH
     * ===================================
     */

    try {
      let subscription =
        job.subscription;

      /**
       * PostgreSQL/jsonb normalmente
       * já devolve objeto.
       *
       * Mas aceitamos string também
       * para maior robustez.
       */
      if (
        typeof subscription ===
        'string'
      ) {
        subscription =
          JSON.parse(
            subscription
          );
      }

      await webPush.sendNotification(
        subscription,
        payload,
        {
          TTL: 300,
        }
      );

      sent++;

      /**
       * ===================================
       * MEDICAMENTO OPCIONAL
       * ===================================
       *
       * Se não for obrigatório,
       * depois do lembrete principal
       * encerramos este job.
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
       * ===================================
       * CALCULAR PRÓXIMO ALERTA
       * ===================================
       */

      let nextNotifyAt: Date;

      let nextPhase:
        | 'deadline'
        | 'repeat';

      /**
       * Primeiro alerta ocorreu
       * antes do horário limite.
       *
       * O próximo será exatamente
       * no deadline.
       */
      if (
        job.phase === 'main' &&
        job.deadline_at &&
        new Date(
          job.deadline_at
        ) > now
      ) {
        nextNotifyAt =
          new Date(
            job.deadline_at
          );

        nextPhase =
          'deadline';
      } else {
        /**
         * Já passou do deadline.
         *
         * Agora repete de acordo
         * com repeat_minutes.
         */
        const repeatMinutes =
          Number(
            job.repeat_minutes
          ) || 30;

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
    } catch (error: any) {
      failed++;

      const statusCode =
        Number(
          error?.statusCode
        ) || null;

      console.error(
        '[CRON] Falha ao enviar Web Push:',
        {
          occurrenceId:
            job.occurrence_id,

          medicationId:
            job.medication_id,

          statusCode,

          error:
            safeErrorMessage(
              error
            ),
        }
      );

      /**
       * ===================================
       * SUBSCRIPTION EXPIRADA
       * ===================================
       *
       * 404 ou 410 significam que
       * o endpoint Push não é mais
       * válido.
       */

      if (
        statusCode === 404 ||
        statusCode === 410
      ) {
        expiredSubscriptions++;

        try {
          await dbPool.query(
            `
              update push_devices

              set
                active = false,

                updated_at =
                  now()

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
            '[CRON] Falha ao desativar subscription expirada:',
            databaseError
          );
        }

        continue;
      }

      /**
       * ===================================
       * ERRO TEMPORÁRIO
       * ===================================
       *
       * Reagenda para cinco minutos.
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
          '[CRON] Falha ao reagendar job após erro:',
          databaseError
        );
      }
    }
  }

  /**
   * ===================================
   * 7. RESPOSTA
   * ===================================
   */

  return NextResponse.json(
    {
      ok: true,

      selected:
        jobs.length,

      sent,

      failed,

      quiet,

      expiredSubscriptions,

      timestamp:
        new Date().toISOString(),
    },
    {
      status: 200,
    }
  );
}
