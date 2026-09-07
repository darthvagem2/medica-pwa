import { NextResponse } from 'next/server';
import {
  createHash,
  timingSafeEqual,
} from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const VERSION =
  'SUPABASE_REMINDERS_SYNC_V1';

const READ_PAGE_SIZE = 1000;
const WRITE_BATCH_SIZE = 500;

/* =========================================================
   TIPOS
========================================================= */

type ReminderPhase =
  | 'main'
  | 'deadline'
  | 'repeat'
  | 'done';

type ExistingJob = {
  occurrence_id: string;
  scheduled_at: string;
  deadline_at: string | null;
  next_notify_at: string;
  phase: ReminderPhase;
  active: boolean;
};

type IncomingJob = z.infer<
  typeof jobSchema
>;

/* =========================================================
   VALIDAÇÃO
========================================================= */

const timeSchema =
  z.string().regex(
    /^(?:[01]\d|2[0-3]):[0-5]\d$/,
    'Horário precisa estar no formato HH:mm'
  );

const jobSchema =
  z.object({
    occurrenceId:
      z.string()
        .trim()
        .min(1)
        .max(512),

    medicationId:
      z.string()
        .trim()
        .min(1)
        .max(512),

    medicationLabel:
      z.string()
        .trim()
        .min(1)
        .max(120),

    scheduledAt:
      z.string()
        .datetime(),

    deadlineAt:
      z.string()
        .datetime()
        .optional(),

    repeatMinutes:
      z.number()
        .int()
        .min(10)
        .max(60),

    sound:
      z.boolean(),

    vibration:
      z.boolean(),

    required:
      z.boolean(),

    url:
      z.string()
        .min(1)
        .max(2048),
  });

const schema =
  z.object({
    deviceId:
      z.string()
        .trim()
        .min(1)
        .max(512),

    deviceSecret:
      z.string()
        .trim()
        .min(1)
        .max(2048),

    timezone:
      z.string()
        .trim()
        .min(1)
        .max(256),

    quietHours:
      z.object({
        enabled:
          z.boolean(),

        start:
          timeSchema,

        end:
          timeSchema,
      })
      .optional(),

    jobs:
      z.array(
        jobSchema
      )
      .max(10000),
  });

/* =========================================================
   RESPONSE
========================================================= */

function reply(
  body: unknown,
  status = 200
) {
  return NextResponse.json(
    body,
    {
      status,

      headers: {
        'Cache-Control':
          'no-store',
      },
    }
  );
}

/* =========================================================
   SEGREDO DO DEVICE
========================================================= */

function hashSecret(
  secret: string
): string {
  return createHash(
    'sha256'
  )
    .update(
      secret,
      'utf8'
    )
    .digest(
      'hex'
    );
}

function safeHashCompare(
  left: string,
  right: string
): boolean {
  try {
    const leftBuffer =
      Buffer.from(
        left,
        'hex'
      );

    const rightBuffer =
      Buffer.from(
        right,
        'hex'
      );

    if (
      leftBuffer.length === 0 ||
      leftBuffer.length !==
        rightBuffer.length
    ) {
      return false;
    }

    return timingSafeEqual(
      leftBuffer,
      rightBuffer
    );
  } catch {
    return false;
  }
}

/* =========================================================
   ERROS
========================================================= */

function safeError(
  error: unknown
): string {
  let value =
    error instanceof Error
      ? error.message
      : String(error);

  value =
    value.replace(
      /sb_secret_[A-Za-z0-9_-]+/gi,
      'sb_secret_***'
    );

  value =
    value.replace(
      /Bearer\s+\S+/gi,
      'Bearer ***'
    );

  return value;
}

/* =========================================================
   COMPARAÇÃO DE DATAS

   O PostgreSQL pode devolver:
   2026-09-07T04:00:00+00:00

   enquanto o iPhone envia:
   2026-09-07T04:00:00.000Z

   Ambos representam o mesmo instante.
========================================================= */

function sameInstant(
  first:
    | string
    | null
    | undefined,

  second:
    | string
    | null
    | undefined
): boolean {
  if (
    !first &&
    !second
  ) {
    return true;
  }

  if (
    !first ||
    !second
  ) {
    return false;
  }

  const a =
    Date.parse(first);

  const b =
    Date.parse(second);

  if (
    Number.isNaN(a) ||
    Number.isNaN(b)
  ) {
    return (
      first === second
    );
  }

  return a === b;
}

/* =========================================================
   POST /api/reminders/sync
========================================================= */

export async function POST(
  request: Request
) {
  try {
    /* =====================================================
       1. JSON
    ===================================================== */

    let rawBody:
      unknown;

    try {
      rawBody =
        await request.json();
    } catch {
      return reply(
        {
          ok: false,
          version: VERSION,
          stage: 'json',

          error:
            'O corpo da requisição não contém JSON válido.',
        },
        400
      );
    }

    /* =====================================================
       2. VALIDAR PAYLOAD
    ===================================================== */

    const parsed =
      schema.safeParse(
        rawBody
      );

    if (
      !parsed.success
    ) {
      const issues =
        parsed.error
          .issues
          .map(
            issue => ({
              field:
                issue.path
                  .join('.') ||
                'body',

              message:
                issue.message,
            })
          );

      return reply(
        {
          ok: false,
          version: VERSION,

          stage:
            'validation',

          error:
            'Dados de sincronização inválidos.',

          issues,

          fields:
            Array.from(
              new Set(
                issues.map(
                  issue =>
                    issue.field
                )
              )
            ),
        },
        400
      );
    }

    const body =
      parsed.data;

    /* =====================================================
       3. CONFIGURAÇÃO SUPABASE
    ===================================================== */

    const supabaseUrl =
      process.env
        .SUPABASE_URL
        ?.trim();

    const supabaseSecretKey =
      process.env
        .SUPABASE_SECRET_KEY
        ?.trim();

    if (
      !supabaseUrl ||
      !supabaseSecretKey
    ) {
      return reply(
        {
          ok: false,
          version: VERSION,

          stage:
            'supabase-configuration',

          error:
            'SUPABASE_URL ou SUPABASE_SECRET_KEY não configurada.',
        },
        503
      );
    }

    /* =====================================================
       4. CLIENTE SUPABASE
    ===================================================== */

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

          global: {
            headers: {
              'X-Client-Info':
                'medica-pwa-reminders-sync',
            },
          },
        }
      );

    /* =====================================================
       5. AUTENTICAR DEVICE

       Substitui assertDevice() e elimina DATABASE_URL.
    ===================================================== */

    const {
      data:
        device,

      error:
        deviceError,
    } =
      await supabase
        .from(
          'push_devices'
        )
        .select(
          'device_id, secret_hash, active'
        )
        .eq(
          'device_id',
          body.deviceId
        )
        .maybeSingle();

    if (
      deviceError
    ) {
      return reply(
        {
          ok: false,
          version: VERSION,

          stage:
            'device-query',

          error:
            'Falha ao consultar o dispositivo.',

          code:
            deviceError.code,

          detail:
            deviceError.message,

          hint:
            deviceError.hint,
        },
        500
      );
    }

    if (!device) {
      return reply(
        {
          ok: false,
          version: VERSION,

          stage:
            'device-auth',

          error:
            'Dispositivo não autorizado.',
        },
        401
      );
    }

    if (
      device.active ===
        false
    ) {
      return reply(
        {
          ok: false,
          version: VERSION,

          stage:
            'device-auth',

          error:
            'Dispositivo desativado.',
        },
        403
      );
    }

    const suppliedHash =
      hashSecret(
        body.deviceSecret
      );

    if (
      typeof device.secret_hash !==
        'string' ||
      !safeHashCompare(
        suppliedHash,
        device.secret_hash
      )
    ) {
      return reply(
        {
          ok: false,
          version: VERSION,

          stage:
            'device-auth',

          error:
            'Dispositivo não autorizado.',
        },
        401
      );
    }

    /* =====================================================
       6. ATUALIZAR TIMEZONE / QUIET HOURS
    ===================================================== */

    const now =
      new Date()
        .toISOString();

    const {
      error:
        deviceUpdateError,
    } =
      await supabase
        .from(
          'push_devices'
        )
        .update({
          timezone:
            body.timezone,

          quiet_enabled:
            body.quietHours
              ?.enabled ??
            false,

          quiet_start:
            body.quietHours
              ?.start ??
            '23:00',

          quiet_end:
            body.quietHours
              ?.end ??
            '07:00',

          updated_at:
            now,
        })
        .eq(
          'device_id',
          body.deviceId
        );

    if (
      deviceUpdateError
    ) {
      return reply(
        {
          ok: false,
          version: VERSION,

          stage:
            'device-update',

          error:
            'Falha ao atualizar as configurações do dispositivo.',

          code:
            deviceUpdateError
              .code,

          detail:
            deviceUpdateError
              .message,

          hint:
            deviceUpdateError
              .hint,
        },
        500
      );
    }

    /* =====================================================
       7. CARREGAR JOBS JÁ EXISTENTES

       Precisamos deles para manter a mesma lógica da
       versão PostgreSQL anterior:

       - se horário NÃO mudou:
         mantém phase e next_notify_at.

       - se horário mudou:
         volta para phase "main".

       - se já estava "done" e nada mudou:
         continua inativo.
    ===================================================== */

    const existingJobs:
      ExistingJob[] = [];

    let offset = 0;

    while (true) {
      const {
        data:
          page,

        error:
          existingError,
      } =
        await supabase
          .from(
            'reminder_jobs'
          )
          .select(
            `
              occurrence_id,
              scheduled_at,
              deadline_at,
              next_notify_at,
              phase,
              active
            `
          )
          .eq(
            'device_id',
            body.deviceId
          )
          .order(
            'occurrence_id',
            {
              ascending:
                true,
            }
          )
          .range(
            offset,
            offset +
              READ_PAGE_SIZE -
              1
          );

      if (
        existingError
      ) {
        return reply(
          {
            ok: false,
            version: VERSION,

            stage:
              'existing-jobs',

            error:
              'Falha ao consultar lembretes existentes.',

            code:
              existingError.code,

            detail:
              existingError.message,

            hint:
              existingError.hint,
          },
          500
        );
      }

      const rows =
        (
          page ??
          []
        ) as ExistingJob[];

      existingJobs.push(
        ...rows
      );

      if (
        rows.length <
        READ_PAGE_SIZE
      ) {
        break;
      }

      offset +=
        READ_PAGE_SIZE;
    }

    const existingMap =
      new Map<
        string,
        ExistingJob
      >();

    for (
      const existing of
      existingJobs
    ) {
      existingMap.set(
        existing.occurrence_id,
        existing
      );
    }

    /* =====================================================
       8. PREPARAR UPSERT
    ===================================================== */

    const rowsToUpsert:
      Record<
        string,
        unknown
      >[] = [];

    const incomingIds =
      new Set<string>();

    for (
      const job of
      body.jobs
    ) {
      incomingIds.add(
        job.occurrenceId
      );

      const existing =
        existingMap.get(
          job.occurrenceId
        );

      const deadlineAt =
        job.deadlineAt ??
        null;

      /*
       * O SQL antigo comparava scheduled_at/deadline_at.
       */
      const scheduleChanged =
        !existing ||
        !sameInstant(
          existing.scheduled_at,
          job.scheduledAt
        ) ||
        !sameInstant(
          existing.deadline_at,
          deadlineAt
        );

      let phase:
        ReminderPhase =
          'main';

      let nextNotifyAt =
        job.scheduledAt;

      let active =
        true;

      if (
        existing &&
        !scheduleChanged
      ) {
        /*
         * Horário igual:
         * mantém o estado atual do cron.
         */
        phase =
          existing.phase;

        nextNotifyAt =
          existing.next_notify_at;

        /*
         * Equivalente à lógica antiga:
         *
         * phase = done + mesmo horário
         * => NÃO reativa o lembrete.
         */
        active =
          existing.phase !==
          'done';
      }

      if (
        scheduleChanged
      ) {
        /*
         * Se o horário/deadline mudou,
         * é uma nova programação.
         */
        phase =
          'main';

        nextNotifyAt =
          job.scheduledAt;

        active =
          true;
      }

      rowsToUpsert.push({
        device_id:
          body.deviceId,

        occurrence_id:
          job.occurrenceId,

        medication_id:
          job.medicationId,

        medication_label:
          job.medicationLabel,

        scheduled_at:
          job.scheduledAt,

        deadline_at:
          deadlineAt,

        next_notify_at:
          nextNotifyAt,

        repeat_minutes:
          job.repeatMinutes,

        phase,

        sound:
          job.sound,

        vibration:
          job.vibration,

        required:
          job.required,

        url:
          job.url,

        active,

        updated_at:
          now,
      });
    }

    /* =====================================================
       9. UPSERT EM LOTES

       Evita enviar 10.000 registros em uma única request.
    ===================================================== */

    let upserted = 0;

    for (
      let index = 0;
      index <
      rowsToUpsert.length;
      index +=
        WRITE_BATCH_SIZE
    ) {
      const batch =
        rowsToUpsert.slice(
          index,
          index +
            WRITE_BATCH_SIZE
        );

      const {
        error:
          upsertError,
      } =
        await supabase
          .from(
            'reminder_jobs'
          )
          .upsert(
            batch,
            {
              onConflict:
                'device_id,occurrence_id',
            }
          );

      if (
        upsertError
      ) {
        return reply(
          {
            ok: false,
            version: VERSION,

            stage:
              'jobs-upsert',

            error:
              'Falha ao salvar lembretes no Supabase.',

            code:
              upsertError.code,

            detail:
              upsertError.message,

            hint:
              upsertError.hint,

            batchStart:
              index,
          },
          500
        );
      }

      upserted +=
        batch.length;
    }

    /* =====================================================
       10. DESATIVAR JOBS QUE NÃO VIERAM MAIS DO IPHONE

       Equivalente ao:

       UPDATE reminder_jobs
       SET active=false
       WHERE device_id=...
       AND occurrence_id NOT IN (...)
    ===================================================== */

    const idsToDisable =
      existingJobs
        .filter(
          existing =>
            !incomingIds.has(
              existing.occurrence_id
            )
        )
        .map(
          existing =>
            existing.occurrence_id
        );

    let disabled = 0;

    for (
      let index = 0;
      index <
      idsToDisable.length;
      index +=
        WRITE_BATCH_SIZE
    ) {
      const batch =
        idsToDisable.slice(
          index,
          index +
            WRITE_BATCH_SIZE
        );

      if (
        batch.length ===
        0
      ) {
        continue;
      }

      const {
        error:
          disableError,
      } =
        await supabase
          .from(
            'reminder_jobs'
          )
          .update({
            active:
              false,

            updated_at:
              now,
          })
          .eq(
            'device_id',
            body.deviceId
          )
          .in(
            'occurrence_id',
            batch
          );

      if (
        disableError
      ) {
        return reply(
          {
            ok: false,
            version: VERSION,

            stage:
              'jobs-disable',

            error:
              'Os novos lembretes foram salvos, mas houve falha ao desativar lembretes antigos.',

            code:
              disableError.code,

            detail:
              disableError.message,

            hint:
              disableError.hint,
          },
          500
        );
      }

      disabled +=
        batch.length;
    }

    /* =====================================================
       11. VERIFICAR QUANTOS JOBS ATIVOS EXISTEM
    ===================================================== */

    const {
      count:
        activeCount,

      error:
        countError,
    } =
      await supabase
        .from(
          'reminder_jobs'
        )
        .select(
          'occurrence_id',
          {
            count:
              'exact',

            head:
              true,
          }
        )
        .eq(
          'device_id',
          body.deviceId
        )
        .eq(
          'active',
          true
        );

    if (
      countError
    ) {
      console.warn(
        '[REMINDERS SYNC] Não foi possível contar jobs:',
        countError
      );
    }

    /* =====================================================
       12. SUCESSO
    ===================================================== */

    return reply({
      ok: true,

      version:
        VERSION,

      stage:
        'synced',

      device:
        'authorized',

      received:
        body.jobs.length,

      upserted,

      disabled,

      activeJobs:
        countError
          ? null
          : activeCount ??
            0,

      timezone:
        body.timezone,

      quietHours: {
        enabled:
          body.quietHours
            ?.enabled ??
          false,

        start:
          body.quietHours
            ?.start ??
          '23:00',

        end:
          body.quietHours
            ?.end ??
          '07:00',
      },

      timestamp:
        new Date()
          .toISOString(),
    });
  } catch (error) {
    console.error(
      '[REMINDERS SYNC][UNHANDLED]',
      error
    );

    return reply(
      {
        ok: false,

        version:
          VERSION,

        stage:
          'unhandled',

        error:
          'Erro inesperado ao sincronizar lembretes.',

        detail:
          safeError(
            error
          ),
      },
      500
    );
  }
}
