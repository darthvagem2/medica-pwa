import { NextResponse } from 'next/server';
import type { PoolClient } from 'pg';

import {
  fromZonedTime,
  toZonedTime,
} from 'date-fns-tz';

import { pool } from '@/lib/server-db';
import { getWebPush } from '@/lib/push-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function inQuiet(
  now: Date,
  start: string,
  end: string
) {
  const mins =
    now.getHours() * 60 +
    now.getMinutes();

  const [sh, sm] =
    start.split(':').map(Number);

  const [eh, em] =
    end.split(':').map(Number);

  const startMinutes =
    sh * 60 + sm;

  const endMinutes =
    eh * 60 + em;

  if (startMinutes < endMinutes) {
    return (
      mins >= startMinutes &&
      mins < endMinutes
    );
  }

  return (
    mins >= startMinutes ||
    mins < endMinutes
  );
}

function quietEndUtc(
  nowUtc: Date,
  timezone: string,
  start: string,
  end: string
) {
  const local =
    toZonedTime(nowUtc, timezone);

  const [endHour, endMinute] =
    end.split(':').map(Number);

  const target =
    new Date(local);

  target.setHours(
    endHour,
    endMinute,
    0,
    0
  );

  const [startHour, startMinute] =
    start.split(':').map(Number);

  const startMinutes =
    startHour * 60 +
    startMinute;

  const endMinutes =
    endHour * 60 +
    endMinute;

  const nowMinutes =
    local.getHours() * 60 +
    local.getMinutes();

  /**
   * Exemplo:
   *
   * silencioso:
   * 23:00 → 07:00
   *
   * Se agora forem 23:30,
   * o final é 07:00 do dia seguinte.
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
 * Evita mandar acidentalmente informações sensíveis
 * para a resposta HTTP caso alguma biblioteca inclua
 * connection strings no erro.
 */
function safeErrorMessage(
  error: unknown
): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  return error.message
    .replace(
      /postgres(?:ql)?:\/\/[^@\s]+@/gi,
      'postgresql://***@'
    )
    .replace(
      /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
      'Bearer ***'
    );
}

async function safeRollback(
  client: PoolClient
) {
  try {
    await client.query('rollback');
  } catch (error) {
    console.error(
      '[CRON] Falha também no rollback:',
      error
    );
  }
}

export async function GET(
  req: Request
) {
  /**
   * ============================
   * 1. AUTENTICAÇÃO DO CRON
   * ============================
   */

  const secret =
    process.env.CRON_SECRET;

  if (
    process.env.NODE_ENV ===
      'production' &&
    !secret
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
    secret &&
    authorization !==
      `Bearer ${secret}`
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
   * ============================
   * 2. BANCO
   * ============================
   */

  const dbPool = pool;

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
   * ============================
   * 3. VAPID / WEB PUSH
   * ============================
   */

  let push;

  try {
    push = getWebPush();
  } catch (error) {
    console.error(
      '[CRON] Falha ao configurar Web Push:',
      error
    );

    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : 'VAPID não configurado',
      },
      {
        status: 503,
      }
    );
  }

  /**
   * ============================
   * 4. CONEXÃO POSTGRESQL
   * ============================
   *
   * ESTE É O PONTO PRINCIPAL
   * DA CORREÇÃO.
   *
   * Antes pool.connect() estava
   * fora do try/catch.
   */

  let client: PoolClient;

  try {
    client =
      await dbPool.connect();
  } catch (error) {
    const detail =
      safeErrorMessage(error);

    console.error(
      '[CRON] Falha ao conectar ao PostgreSQL:',
      error
    );

    return NextResponse.json(
      {
        ok: false,

        error:
          'Falha ao conectar ao banco de dados',

        detail,
      },
      {
        status: 500,
      }
    );
  }

  /**
   * ============================
   * 5. SELECIONAR JOBS
   * ============================
   */

  let jobs: any[] = [];

  try {
    await client.query('begin');

    const selected =
      await client.query(`
        select
          j.*,
          d.subscription,
          d.timezone,
          d.quiet_enabled,
          d.quiet_start,
          d.quiet_end

        from reminder_jobs j

        join push_devices d
          on d.device_id = j.device_id

        where
          j.active = true

          and d.active = true

          and j.next_notify_at <= now()

          and (
            j.locked_until is null
            or j.locked_until < now()
          )

        order by
          j.next_notify_at asc

        for update of j
        skip locked

        limit 100
      `);

    jobs = selected.rows;

    /**
     * Lock temporário para impedir
     * dois workers de enviarem a
     * mesma notificação simultaneamente.
     */
    for (const job of jobs) {
      await client.query(
        `
          update reminder_jobs

          set
            locked_until =
              now() + interval '2 minutes',

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
      '[CRON] Erro ao selecionar reminder_jobs:',
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
   * ============================
   * 6. ENVIAR NOTIFICAÇÕES
   * ============================
   */

  let sent = 0;
  let failed = 0;
  let quiet = 0;

  for (const job of jobs) {
    const now =
      new Date();

    const timezone =
      job.timezone || 'UTC';

    /**
     * ============================
     * HORÁRIO SILENCIOSO
     * ============================
     */

    if (
      job.quiet_enabled &&
      inQuiet(
        toZonedTime(
          now,
          timezone
        ),
        job.quiet_start,
        job.quiet_end
      )
    ) {
      try {
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

            quietEndUtc(
              now,
              timezone,
              job.quiet_start,
              job.quiet_end
            ),
          ]
        );

        quiet++;
      } catch (error) {
        console.error(
          '[CRON] Falha ao adiar job por horário silencioso:',
          job.occurrence_id,
          error
        );

        failed++;
      }

      continue;
    }

    /**
     * Verifica se já passou do
     * horário limite.
     */
    const overdue =
      Boolean(
        job.deadline_at &&
          new Date(
            job.deadline_at
          ) <= now
      ) ||
      job.phase ===
        'deadline' ||
      job.phase ===
        'repeat';

    const payload =
      JSON.stringify({
        title: overdue
          ? '⚠️ Medicamento ainda não confirmado'
          : 'Hora do medicamento',

        body: overdue
          ? `Você ainda não marcou ${job.medication_label} como tomado.`
          : `Está na hora de ${job.medication_label}.`,

        tag:
          `med-${job.occurrence_id}`,

        url:
          job.url || '/',

        requireInteraction:
          overdue,

        vibration:
          job.vibration,

        sound:
          job.sound,
      });

    try {
      /**
       * ============================
       * ENVIO WEB PUSH
       * ============================
       */

      await push.sendNotification(
        job.subscription,
        payload,
        {
          TTL: 300,
        }
      );

      sent++;

      /**
       * Medicamentos opcionais:
       *
       * depois do lembrete principal
       * não precisam ficar repetindo.
       */
      if (
        job.phase === 'main' &&
        !job.required
      ) {
        await dbPool.query(
          `
            update reminder_jobs

            set
              active = false,
              phase = 'done',
              last_sent_at = now(),
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

        continue;
      }

      /**
       * Calcula o próximo lembrete.
       */

      let nextNotifyAt: Date;

      let nextPhase:
        | 'deadline'
        | 'repeat';

      if (
        job.phase === 'main' &&
        job.deadline_at &&
        new Date(
          job.deadline_at
        ) > now
      ) {
        /**
         * Exemplo:
         *
         * medicamento 08:00
         * limite 09:00
         *
         * próximo evento = 09:00
         */
        nextNotifyAt =
          new Date(
            job.deadline_at
          );

        nextPhase =
          'deadline';
      } else {
        /**
         * Depois do limite:
         *
         * 09:00
         * 09:30
         * 10:00
         * ...
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
            last_sent_at = now(),
            locked_until = null,
            updated_at = now()

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

      console.error(
        '[CRON] Falha no job:',
        {
          occurrenceId:
            job.occurrence_id,

          medicationId:
            job.medication_id,

          statusCode:
            error?.statusCode,

          message:
            safeErrorMessage(
              error
            ),
        }
      );

      /**
       * 404 ou 410:
       *
       * subscription Push expirou
       * ou foi removida pelo navegador.
       */
      if (
        error?.statusCode ===
          404 ||
        error?.statusCode ===
          410
      ) {
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
            '[CRON] Falha ao desativar subscription inválida:',
            databaseError
          );
        }

        continue;
      }

      /**
       * Qualquer outro erro:
       *
       * tenta novamente em 5 minutos.
       */

      try {
        await dbPool.query(
          `
            update reminder_jobs

            set
              next_notify_at =
                now() + interval '5 minutes',

              locked_until = null,

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
          '[CRON] Falha ao reagendar job:',
          databaseError
        );
      }
    }
  }

  /**
   * ============================
   * 7. RESPOSTA FINAL
   * ============================
   */

  return NextResponse.json({
    ok: true,

    selected:
      jobs.length,

    sent,

    failed,

    quiet,

    timestamp:
      new Date().toISOString(),
  });
}
