import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const VERSION = 'SUPABASE_PUSH_SUBSCRIBE_V1';

/* =========================================================
   TIPOS
========================================================= */

type NormalizedSubscription = {
  endpoint: string;
  expirationTime: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
};

/* =========================================================
   VALIDAÇÃO
========================================================= */

const requestSchema = z.object({
  deviceId: z
    .string()
    .trim()
    .min(1, 'deviceId ausente')
    .max(512),

  deviceSecret: z
    .string()
    .trim()
    .min(1, 'deviceSecret ausente')
    .max(2048),

  timezone: z
    .string()
    .trim()
    .min(1, 'timezone ausente')
    .max(256),

  subscription: z.unknown(),
});

/* =========================================================
   HELPERS
========================================================= */

function response(
  body: unknown,
  status = 200
) {
  return NextResponse.json(
    body,
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
      },
    }
  );
}

function hashSecret(
  secret: string
): string {
  return createHash('sha256')
    .update(secret, 'utf8')
    .digest('hex');
}

function normalizeSubscription(
  value: unknown
):
  | {
      ok: true;
      value: NormalizedSubscription;
    }
  | {
      ok: false;
      fields: string[];
      detail: string;
    } {
  if (
    typeof value !== 'object' ||
    value === null
  ) {
    return {
      ok: false,
      fields: ['subscription'],
      detail:
        'subscription precisa ser um objeto.',
    };
  }

  const raw = value as {
    endpoint?: unknown;

    expirationTime?: unknown;

    keys?: {
      p256dh?: unknown;
      auth?: unknown;
    };

    p256dh?: unknown;
    auth?: unknown;
  };

  const endpoint =
    typeof raw.endpoint === 'string'
      ? raw.endpoint.trim()
      : '';

  const nestedP256dh =
    raw.keys &&
    typeof raw.keys === 'object'
      ? raw.keys.p256dh
      : undefined;

  const nestedAuth =
    raw.keys &&
    typeof raw.keys === 'object'
      ? raw.keys.auth
      : undefined;

  const p256dh =
    typeof nestedP256dh === 'string'
      ? nestedP256dh.trim()
      : typeof raw.p256dh === 'string'
        ? raw.p256dh.trim()
        : '';

  const auth =
    typeof nestedAuth === 'string'
      ? nestedAuth.trim()
      : typeof raw.auth === 'string'
        ? raw.auth.trim()
        : '';

  const fields: string[] = [];

  if (!endpoint) {
    fields.push(
      'subscription.endpoint'
    );
  }

  if (!p256dh) {
    fields.push(
      'subscription.keys.p256dh'
    );
  }

  if (!auth) {
    fields.push(
      'subscription.keys.auth'
    );
  }

  if (fields.length > 0) {
    return {
      ok: false,
      fields,
      detail:
        `Campos ausentes ou inválidos: ${fields.join(
          ', '
        )}`,
    };
  }

  if (
    !endpoint
      .toLowerCase()
      .startsWith('https://')
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
    number | null = null;

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

    let rawBody: unknown;

    try {
      rawBody =
        await request.json();
    } catch {
      return response(
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
       2. VALIDAR BODY
    ===================================================== */

    const parsed =
      requestSchema.safeParse(
        rawBody
      );

    if (!parsed.success) {
      const issues =
        parsed.error.issues.map(
          issue => ({
            field:
              issue.path.join('.') ||
              'body',

            message:
              issue.message,
          })
        );

      return response(
        {
          ok: false,
          version: VERSION,
          stage: 'validation',
          error:
            'Dados de inscrição inválidos.',
          issues,
        },
        400
      );
    }

    const body =
      parsed.data;

    /* =====================================================
       3. NORMALIZAR SUBSCRIPTION
    ===================================================== */

    const normalized =
      normalizeSubscription(
        body.subscription
      );

    if (!normalized.ok) {
      return response(
        {
          ok: false,
          version: VERSION,

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

    /* =====================================================
       4. VARIÁVEIS SUPABASE
    ===================================================== */

    const supabaseUrl =
      process.env
        .SUPABASE_URL
        ?.trim();

    const supabaseSecret =
      process.env
        .SUPABASE_SECRET_KEY
        ?.trim();

    if (
      !supabaseUrl ||
      !supabaseSecret
    ) {
      return response(
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
       5. CLIENTE SUPABASE
    ===================================================== */

    const supabase =
      createClient<any>(
        supabaseUrl,
        supabaseSecret,
        {
          auth: {
            persistSession: false,
            autoRefreshToken:
              false,
            detectSessionInUrl:
              false,
          },
        }
      );

    /* =====================================================
       6. SALVAR PUSH DEVICE
    ===================================================== */

    const now =
      new Date()
        .toISOString();

    const {
      data,
      error,
    } =
      await supabase
        .from('push_devices')
        .upsert(
          {
            device_id:
              body.deviceId,

            secret_hash:
              hashSecret(
                body.deviceSecret
              ),

            timezone:
              body.timezone,

            subscription:
              normalized.value,

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
          'device_id'
        )
        .single();

    /* =====================================================
       7. ERRO SUPABASE
    ===================================================== */

    if (error) {
      console.error(
        '[PUSH SUBSCRIBE][SUPABASE]',
        {
          code:
            error.code,

          message:
            error.message,

          hint:
            error.hint,
        }
      );

      return response(
        {
          ok: false,
          version: VERSION,

          stage:
            'supabase-write',

          error:
            'Falha ao registrar Push no Supabase.',

          code:
            error.code,

          detail:
            error.message,

          hint:
            error.hint,
        },
        500
      );
    }

    /* =====================================================
       8. SUCESSO
    ===================================================== */

    return response({
      ok: true,

      version:
        VERSION,

      stage:
        'registered',

      registered:
        true,

      deviceId:
        data?.device_id ??
        body.deviceId,
    });
  } catch (error) {
    console.error(
      '[PUSH SUBSCRIBE][UNHANDLED]',
      error
    );

    return response(
      {
        ok: false,

        version:
          VERSION,

        stage:
          'unhandled',

        error:
          error instanceof Error
            ? error.message
            : 'Erro inesperado.',
      },
      500
    );
  }
}
