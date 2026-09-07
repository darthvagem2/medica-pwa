import { createClient } from '@supabase/supabase-js';

import type {
  PushSubscription as WebPushSubscription,
} from 'web-push';

import {
  fromZonedTime,
  toZonedTime,
} from 'date-fns-tz';

import {
  getWebPush,
} from '@/lib/push-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/* =========================================================
   VERSÃO
========================================================= */

const CRON_VERSION =
  'SUPABASE_CRON_V1';

/* =========================================================
   TIPOS
========================================================= */

type ReminderPhase =
  | 'main'
  | 'deadline'
  | 'repeat'
  | 'done';

type PushDeviceRow = {
  subscription:
    unknown;

  timezone:
    string | null;

  quiet_enabled:
    boolean | null;

  quiet_start:
    string | null;

  quiet_end:
    string | null;

  active:
    boolean | null;
};

type ReminderJobRow = {
  device_id:
    string;

  occurrence_id:
    string;

  medication_id:
    string;

  medication_label:
    string;

  scheduled_at:
    string;

  deadline_at:
    string | null;

  next_notify_at:
    string;

  repeat_minutes:
    number;

  phase:
    ReminderPhase;

  sound:
    boolean;

  vibration:
    boolean;

  required:
    boolean;

  url:
    string | null;

  active:
    boolean;

  last_sent_at:
    string | null;

  locked_until:
    string | null;

  push_devices:
    | PushDeviceRow
    | PushDeviceRow[]
    | null;
};

/* =========================================================
   RESPONSE
========================================================= */

function reply(
  body: unknown,
  status = 200
) {
  return new Response(
    JSON.stringify(
      body,
      null,
      2
    ),
    {
      status,

      headers: {
        'content-type':
          'application/json; charset=utf-8',

        'cache-control':
          'no-store',
      },
    }
  );
}

/* =========================================================
   ERROS
========================================================= */

function safeError(
  error: unknown
): string {
  if (
    error instanceof Error
  ) {
    return error.message
      .replace(
        /Bearer\s+\S+/gi,
        'Bearer ***'
      )
      .replace(
        /sb_secret_[A-Za-z0-9_-]+/gi,
        'sb_secret_***'
      );
  }

  if (
    typeof error === 'string'
  ) {
    return error;
  }

  try {
    return JSON.stringify(
      error
    );
  } catch {
    return String(
      error
    );
  }
}

function getPushStatusCode(
  error: unknown
): number | null {
  if (
    typeof error !==
      'object' ||
    error === null
  ) {
    return null;
  }

  const raw =
    error as {
      statusCode?: unknown;
    };

  const status =
    Number(
      raw.statusCode
    );

  return Number.isFinite(
    status
  )
    ? status
    : null;
}

/* =========================================================
   SUBSCRIPTION
========================================================= */

function parseSubscription(
  value: unknown
): WebPushSubscription {
  let parsed:
    unknown = value;

  if (
    typeof parsed ===
      'string'
  ) {
    try {
      parsed =
        JSON.parse(
          parsed
        );
    } catch {
      throw new Error(
        'Subscription contém JSON inválido.'
      );
    }
  }

  if (
    typeof parsed !==
      'object' ||
    parsed === null
  ) {
    throw new Error(
      'Subscription Push inválida.'
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
    typeof raw.endpoint !==
      'string' ||
    !raw.endpoint.trim()
  ) {
    throw new Error(
      'Subscription sem endpoint.'
    );
  }

  if (
    typeof raw.keys?.p256dh !==
      'string' ||
    !raw.keys.p256dh.trim()
  ) {
    throw new Error(
      'Subscription sem p256dh.'
    );
  }

  if (
    typeof raw.keys.auth !==
      'string' ||
    !raw.keys.auth.trim()
  ) {
    throw new Error(
      'Subscription sem auth.'
    );
  }

  return {
    endpoint:
      raw.endpoint,

    keys: {
      p256dh:
        raw.keys.p256dh,

      auth:
        raw.keys.auth,
    },
  };
}

/* =========================================================
   DEVICE EMBED
========================================================= */

function getDevice(
  job: ReminderJobRow
): PushDeviceRow | null {
  if (
    Array.isArray(
      job.push_devices
    )
  ) {
    return (
      job.push_devices[0] ??
      null
    );
  }

  return (
    job.push_devices ??
    null
  );
}

/* =========================================================
   QUIET HOURS
========================================================= */

function validTime(
  value: unknown
): value is string {
  if (
    typeof value !==
      'string' ||
    !/^\d{2}:\d{2}$/.test(
      value
    )
  ) {
    return false;
  }

  const [
    hour,
    minute,
  ] =
    value
      .split(':')
      .map(Number);

  return (
    Number.isInteger(
      hour
    ) &&
    Number.isInteger(
      minute
    ) &&
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
    localNow.getHours() *
      60 +
    localNow.getMinutes();

  const [
    startHour,
    startMinute,
  ] =
    start
      .split(':')
      .map(Number);

  const [
    endHour,
    endMinute,
  ] =
    end
      .split(':')
      .map(Number);

  const startMinutes =
    startHour * 60 +
    startMinute;

  const endMinutes =
    endHour * 60 +
    endMinute;

  if (
    startMinutes ===
      endMinutes
  ) {
    return false;
  }

  /*
   * Exemplo:
   * 13:00 → 18:00
   */
  if (
    startMinutes <
      endMinutes
  ) {
    return (
      current >=
        startMinutes &&
      current <
        endMinutes
    );
  }

  /*
   * Exemplo:
   * 23:00 → 07:00
   */
  return (
    current >=
      startMinutes ||
    current <
      endMinutes
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

  const [
    startHour,
    startMinute,
  ] =
    start
      .split(':')
      .map(Number);

  const [
    endHour,
    endMinute,
  ] =
    end
      .split(':')
      .map(Number);

  const startMinutes =
    startHour * 60 +
    startMinute;

  const endMinutes =
    endHour * 60 +
    endMinute;

  const current =
    localNow.getHours() *
      60 +
    localNow.getMinutes();

  const target =
    new Date(
      localNow
    );

  target.setHours(
    endHour,
    endMinute,
    0,
    0
  );

  /*
   * Janela atravessa meia-noite:
   * 23:00 → 07:00.
   *
   * Se agora for 23:30,
   * 07:00 é amanhã.
   */
  if (
    startMinutes >
      endMinutes &&
    current >=
      startMinutes
  ) {
    target.setDate(
      target.getDate() +
        1
    );
  }

  return fromZonedTime(
    target,
    timezone
  );
}

/* =========================================================
   GET /api/cron/reminders
========================================================= */

export async function GET(
  request: Request
) {
  try {
    /* =====================================================
       1. AUTORIZAÇÃO DO CRON
    ===================================================== */

    const cronSecret =
      process.env
        .CRON_SECRET
        ?.trim();

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

    /* =====================================================
       2. SUPABASE ENV
    ===================================================== */

    const supabaseUrl =
      process.env
        .SUPABASE_URL
        ?.trim();

    const supabaseSecretKey =
      process.env
        .SUPABASE_SECRET_KEY
        ?.trim();

    if (!supabaseUrl) {
      return reply(
        {
          ok: false,

          version:
            CRON_VERSION,

          stage:
            'supabase-configuration',

          error:
            'SUPABASE_URL não configurada.',
        },
        503
      );
    }

    if (
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
            'SUPABASE_SECRET_KEY não configurada.',
        },
        503
      );
    }

    /* =====================================================
       3. CRIAR CLIENTE SUPABASE
    ===================================================== */

    let supabase:
      ReturnType<
        typeof createClient
      >;

    try {
      supabase =
        createClient(
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
                  'medica-pwa-cron',
              },
            },
          }
        );
    } catch (error) {
      return reply(
        {
          ok: false,

          version:
            CRON_VERSION,

          stage:
            'supabase-client',

          error:
            'Falha ao criar cliente Supabase.',

          detail:
            safeError(
              error
            ),
        },
        500
      );
    }

    /* =====================================================
       4. TESTAR SUPABASE
    ===================================================== */

    const {
      count:
        deviceCount,

      error:
        connectionError,
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

    if (
      connectionError
    ) {
      return reply(
        {
          ok: false,

          version:
            CRON_VERSION,

          stage:
            'supabase-connection',

          error:
            'Falha ao acessar push_devices.',

          detail:
            connectionError
              .message,

          code:
            connectionError
              .code,

          hint:
            connectionError
              .hint,
        },
        500
      );
    }

    /* =====================================================
       5. VAPID
    ===================================================== */

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
            'Falha ao configurar Web Push.',

          detail:
            safeError(
              error
            ),
        },
        503
      );
    }

    /* =====================================================
       6. BUSCAR JOBS VENCIDOS
    ===================================================== */

    const now =
      new Date();

    const nowIso =
      now.toISOString();

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
          nowIso
        )
        .order(
          'next_notify_at',
          {
            ascending:
              true,
          }
        )
        .limit(
          100
        );

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

          hint:
            jobsError.hint,
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

    /* =====================================================
       7. CONTADORES
    ===================================================== */

    let selected = 0;
    let claimed = 0;
    let sent = 0;
    let failed = 0;
    let quiet = 0;
    let expired = 0;
    let skippedLocked = 0;

    selected =
      jobs.length;

    /* =====================================================
       8. PROCESSAR JOBS
    ===================================================== */

    for (
      const job of jobs
    ) {
      const iterationNow =
        new Date();

      const iterationNowIso =
        iterationNow
          .toISOString();

      /* ===================================================
         8.1 IGNORAR LOCK ATIVO
      =================================================== */

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

      /* ===================================================
         8.2 CLAIM / LOCK

         Evita duas execuções simultâneas enviarem
         o mesmo lembrete.
      =================================================== */

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
              iterationNowIso,
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

        console.error(
          '[CRON] Falha ao criar lock:',
          claimError
        );

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
        getDevice(
          job
        );

      /* ===================================================
         8.3 DEVICE AUSENTE
      =================================================== */

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
        device.timezone
          .trim()
          ? device.timezone
          : 'UTC';

      /* ===================================================
         8.4 QUIET HOURS
      =================================================== */

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

            const {
              error:
                quietError,
            } =
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

            if (
              quietError
            ) {
              failed++;

              console.error(
                '[CRON] Quiet hours update:',
                quietError
              );
            } else {
              quiet++;
            }

            continue;
          }
        } catch (error) {
          console.error(
            '[CRON] Quiet hours inválido:',
            error
          );
        }
      }

      /* ===================================================
         8.5 DETERMINAR ATRASO
      =================================================== */

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
            iterationNow.getTime()
        );

      const overdue =
        deadlinePassed ||
        job.phase ===
          'deadline' ||
        job.phase ===
          'repeat';

      /* ===================================================
         8.6 PAYLOAD
      =================================================== */

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
            job.url ||
            '/',

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

      /* ===================================================
         8.7 ENVIAR WEB PUSH
      =================================================== */

      try {
        const subscription =
          parseSubscription(
            device.subscription
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

        /* =================================================
           NÃO OBRIGATÓRIO:
           envia uma vez e encerra.
        ================================================= */

        if (
          job.phase ===
            'main' &&
          job.required ===
            false
        ) {
          const {
            error:
              doneError,
          } =
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

          if (
            doneError
          ) {
            console.error(
              '[CRON] Falha ao finalizar job:',
              doneError
            );
          }

          continue;
        }

        /* =================================================
           MAIN → DEADLINE
        ================================================= */

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
          const {
            error:
              deadlineError,
          } =
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

          if (
            deadlineError
          ) {
            console.error(
              '[CRON] Falha ao definir deadline:',
              deadlineError
            );
          }

          continue;
        }

        /* =================================================
           REPETIR
        ================================================= */

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

        const {
          error:
            repeatError,
        } =
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

        if (
          repeatError
        ) {
          console.error(
            '[CRON] Falha ao reagendar:',
            repeatError
          );
        }
      } catch (error) {
        failed++;

        const statusCode =
          getPushStatusCode(
            error
          );

        console.error(
          '[CRON] Web Push falhou:',
          {
            occurrenceId:
              job.occurrence_id,

            statusCode,

            error:
              safeError(
                error
              ),
          }
        );

        /* =================================================
           SUBSCRIPTION EXPIRADA
        ================================================= */

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

        /* =================================================
           ERRO TEMPORÁRIO:
           tentar novamente em 5 minutos
        ================================================= */

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

    /* =====================================================
       9. SUCESSO
    ===================================================== */

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
        deviceCount ??
        0,

      selected,

      claimed,

      skippedLocked,

      sent,

      failed,

      quiet,

      expiredSubscriptions:
        expired,

      timestamp:
        new Date()
          .toISOString(),
    });
  } catch (error) {
    console.error(
      '[CRON][UNHANDLED]',
      error
    );

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
