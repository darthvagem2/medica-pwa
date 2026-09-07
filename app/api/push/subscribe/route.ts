import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const VERSION =
  'SUPABASE_PUSH_SUBSCRIBE_V1';

/* =========================================================
   TIPOS
========================================================= */

type NormalizedSubscription = {
  endpoint: string;

  expirationTime:
    | number
    | null;

  keys: {
    p256dh: string;
    auth: string;
  };
};

/* =========================================================
   VALIDAÇÃO DO BODY
========================================================= */

const requestSchema =
  z.object({
    deviceId:
      z.string()
        .trim()
        .min(
          1,
          'deviceId ausente'
        )
        .max(
          512,
          'deviceId muito grande'
        ),

    deviceSecret:
      z.string()
        .trim()
        .min(
          1,
          'deviceSecret ausente'
        )
        .max(
          2048,
          'deviceSecret muito grande'
        ),

    timezone:
      z.string()
        .trim()
        .min(
          1,
          'timezone ausente'
        )
        .max(
          256,
          'timezone muito grande'
        ),

    subscription:
      z.unknown(),
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
   HASH DO DEVICE SECRET
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

/* =========================================================
   MENSAGEM DE ERRO SEGURA
========================================================= */

function safeError(
  error: unknown
): string {
  let message =
    error instanceof Error
      ? error.message
      : String(
          error
        );

  /*
   * Evita devolver Secret Key
   * por acidente.
   */
  message =
    message.replace(
      /sb_secret_[A-Za-z0-9_-]+/gi,
      'sb_secret_***'
    );

  message =
    message.replace(
      /Bearer\s+\S+/gi,
      'Bearer ***'
    );

  return message;
}

/* =========================================================
   NORMALIZAR PUSH SUBSCRIPTION
========================================================= */

function normalizeSubscription(
  value: unknown
):
  | {
      ok: true;

      value:
        NormalizedSubscription;
    }
  | {
      ok: false;

      fields:
        string[];

      detail:
        string;
    } {
  if (
    typeof value !==
      'object' ||
    value === null
  ) {
    return {
      ok: false,

      fields: [
        'subscription',
      ],

      detail:
        'subscription precisa ser um objeto.',
    };
  }

  const raw =
    value as {
      endpoint?:
        unknown;

      expirationTime?:
        unknown;

      keys?: {
        p256dh?:
          unknown;

        auth?:
          unknown;
      };

      /*
       * Fallback para formatos antigos.
       */
      p256dh?:
        unknown;

      auth?:
        unknown;
    };

  const endpoint =
    typeof raw.endpoint ===
      'string'
      ? raw.endpoint
          .trim()
      : '';

  const nestedP256dh =
    raw.keys &&
    typeof raw.keys ===
      'object'
      ? raw.keys
          .p256dh
      : undefined;

  const nestedAuth =
    raw.keys &&
    typeof raw.keys ===
      'object'
      ? raw.keys
          .auth
      : undefined;

  const p256dh =
    typeof nestedP256dh ===
      'string'
      ? nestedP256dh
          .trim()
      : typeof raw.p256dh ===
          'string'
        ? raw.p256dh
            .trim()
        : '';

  const auth =
    typeof nestedAuth ===
      'string'
      ? nestedAuth
          .trim()
      : typeof raw.auth ===
          'string'
        ? raw.auth
            .trim()
        : '';

  const invalidFields:
    string[] = [];

  if (!endpoint) {
    invalidFields.push(
      'subscription.endpoint'
    );
  }

  if (!p256dh) {
    invalidFields.push(
      'subscription.keys.p256dh'
    );
  }

  if (!auth) {
    invalidFields.push(
      'subscription.keys.auth'
    );
  }

  if (
    invalidFields.length >
    0
  ) {
    return {
      ok: false,

      fields:
        invalidFields,

      detail:
        `Campos ausentes ou inválidos: ${invalidFields.join(
          ', '
        )}`,
    };
  }

  /*
   * Endpoints Web Push reais
   * precisam usar HTTPS.
   */
  if (
    !endpoint
      .toLowerCase()
      .startsWith(
        'https://'
      )
  ) {
    return {
      ok: false,

      fields: [
        'subscription.endpoint',
      ],

      detail:
        'O endpoint Push precisa começar com https://.',
    };
  }

  let expirationTime:
    number | null =
      null;

  if (
    typeof raw.expirationTime ===
      'number' &&
    Number.isFinite(
      raw.expirationTime
    )
  ) {
    expirationTime =
      raw.expirationTime;
  }

  return {
    ok: true,

    value: {
      endpoint,

      expirationTime,

      keys: {
        p256dh,
        auth,
      },
    },
  };
}

/* =========================================================
   POST /api/push/subscribe
========================================================= */

export async function POST(
  request: Request
) {
  try {
    /* =====================================================
       1. LER JSON
    ===================================================== */

    let rawBody:
      unknown;

    try {
      rawBody =
        await request
          .json();
    } catch (error) {
      console.warn(
        '[PUSH SUBSCRIBE] JSON inválido:',
        safeError(
          error
        )
      );

      return reply(
        {
          ok: false,

          version:
            VERSION,

          stage:
            'json',

          error:
            'O corpo da requisição não contém JSON válido.',
        },
        400
      );
    }

    /* =====================================================
       2. VALIDAR CAMPOS
    ===================================================== */

    const parsed =
      requestSchema.safeParse(
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
                  .join(
                    '.'
                  ) ||
                'body',

              message:
                issue.message,
            })
          );

      return reply(
        {
          ok: false,

          version:
            VERSION,

          stage:
            'validation',

          error:
            'Dados de inscrição inválidos.',

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

    const {
      deviceId,
      deviceSecret,
      timezone,
      subscription:
        rawSubscription,
    } =
      parsed.data;

    /* =====================================================
       3. VALIDAR SUBSCRIPTION
    ===================================================== */

    const normalized =
      normalizeSubscription(
        rawSubscription
      );

    if (
      !normalized.ok
    ) {
      return reply(
        {
          ok: false,

          version:
            VERSION,

          stage:
            'subscription-validation',

          error:
            'A inscrição Web Push está incompleta ou inválida.',

          fields:
            normalized.fields,

          detail:
            normalized.detail,
        },
        400
      );
    }

    const subscription =
      normalized.value;

    /* =====================================================
       4. CONFIGURAÇÃO SUPABASE
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
      !supabaseUrl
    ) {
      return reply(
        {
          ok: false,

          version:
            VERSION,

          stage:
            'supabase-configuration',

          error:
            'SUPABASE_URL não configurada na Vercel.',
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
            VERSION,

          stage:
            'supabase-configuration',

          error:
            'SUPABASE_SECRET_KEY não configurada na Vercel.',
        },
        503
      );
    }

    /* =====================================================
       5. CRIAR CLIENTE SUPABASE

       Usamos <any> por enquanto porque o projeto
       ainda não possui database.types.ts gerado.
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
                'medica-pwa-push-subscribe',
            },
          },
        }
      );

    /* =====================================================
       6. TESTAR ACESSO À TABELA
    ===================================================== */

    const {
      error:
        tableError,
    } =
      await supabase
        .from(
          'push_devices'
        )
        .select(
          'device_id',
          {
            head:
              true,

            count:
              'exact',
          }
        );

    if (
      tableError
    ) {
      console.error(
        '[PUSH SUBSCRIBE] Falha ao acessar push_devices:',
        tableError
      );

      return reply(
        {
          ok: false,

          version:
            VERSION,

          stage:
            'supabase-connection',

          error:
            'Não foi possível acessar a tabela push_devices.',

          code:
            tableError.code,

          detail:
            tableError.message,

          hint:
            tableError.hint,
        },
        500
      );
    }

    /* =====================================================
       7. SALVAR / ATUALIZAR DEVICE
    ===================================================== */

    const now =
      new Date()
        .toISOString();

    const secretHash =
      hashSecret(
        deviceSecret
      );

    const {
      data:
        savedDevice,

      error:
        saveError,
    } =
      await supabase
        .from(
          'push_devices'
        )
        .upsert(
          {
            device_id:
              deviceId,

            secret_hash:
              secretHash,

            timezone,

            subscription,

            active:
              true,

            updated_at:
              now,
          },
          {
            onConflict:
              'device_id',
          }
        )
        .select(
          'device_id, active, timezone'
        )
        .single();

    /* =====================================================
       8. ERRO AO SALVAR
    ===================================================== */

    if (
      saveError
    ) {
      console.error(
        '[PUSH SUBSCRIBE] Falha ao registrar device:',
        {
          code:
            saveError.code,

          message:
            saveError.message,

          detail:
            saveError.details,

          hint:
            saveError.hint,
        }
      );

      return reply(
        {
          ok: false,

          version:
            VERSION,

          stage:
            'supabase-write',

          error:
            'Falha ao registrar Push no Supabase.',

          code:
            saveError.code,

          detail:
            saveError.message,

          hint:
            saveError.hint,
        },
        500
      );
    }

    /* =====================================================
       9. CONFIRMAR QUE REALMENTE EXISTE NO BACKEND
    ===================================================== */

    const {
      data:
        verification,

      error:
        verificationError,
    } =
      await supabase
        .from(
          'push_devices'
        )
        .select(
          'device_id, active'
        )
        .eq(
          'device_id',
          deviceId
        )
        .maybeSingle();

    if (
      verificationError
    ) {
      console.error(
        '[PUSH SUBSCRIBE] Falha ao verificar registro:',
        verificationError
      );

      return reply(
        {
          ok: false,

          version:
            VERSION,

          stage:
            'verification',

          error:
            'O dispositivo foi enviado ao Supabase, mas não foi possível confirmar o registro.',

          code:
            verificationError
              .code,

          detail:
            verificationError
              .message,
        },
        500
      );
    }

    if (
      !verification ||
      verification.active !==
        true
    ) {
      return reply(
        {
          ok: false,

          version:
            VERSION,

          stage:
            'verification',

          error:
            'O dispositivo não foi encontrado como ativo após o registro.',
        },
        500
      );
    }

    /* =====================================================
       10. SUCESSO
    ===================================================== */

    console.info(
      '[PUSH SUBSCRIBE] Registrado com sucesso:',
      deviceId
    );

    return reply(
      {
        ok: true,

        version:
          VERSION,

        stage:
          'registered',

        registered:
          true,

        backend:
          'registered',

        active:
          true,

        deviceId:
          savedDevice
            ?.device_id ??
          deviceId,

        timezone:
          savedDevice
            ?.timezone ??
          timezone,
      },
      200
    );
  } catch (error) {
    console.error(
      '[PUSH SUBSCRIBE][UNHANDLED]',
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
          'Erro inesperado ao registrar Push.',

        detail:
          safeError(
            error
          ),
      },
      500
    );
  }
}
