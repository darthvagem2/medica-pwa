import { NextResponse } from 'next/server';
import { z } from 'zod';

import {
  getPool,
  hashSecret,
} from '@/lib/server-db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

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
   VALIDAÇÃO INICIAL

   Não usamos z.string().url() no endpoint.

   O Safari/iOS pode usar endpoints longos e queremos
   evitar rejeição desnecessária antes de chegar ao banco.
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

    /*
     * Deixamos subscription como unknown inicialmente.
     *
     * Depois fazemos uma normalização própria,
     * com mensagens de erro muito mais claras.
     */
    subscription:
      z.unknown(),
  });

/* =========================================================
   HELPERS DE ERRO
========================================================= */

function safeErrorMessage(
  error: unknown
): string {
  let message =
    error instanceof Error
      ? error.message
      : String(error);

  /*
   * Evita devolver credenciais de PostgreSQL
   * caso alguma biblioteca inclua a URL no erro.
   */
  message =
    message.replace(
      /postgres(?:ql)?:\/\/[^@\s]+@/gi,
      'postgresql://***@'
    );

  message =
    message.replace(
      /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
      'Bearer ***'
    );

  return message;
}

function getPostgresError(
  error: unknown
) {
  if (
    typeof error !== 'object' ||
    error === null
  ) {
    return {
      code: null as
        | string
        | null,

      message:
        safeErrorMessage(
          error
        ),

      detail: null as
        | string
        | null,

      hint: null as
        | string
        | null,

      table: null as
        | string
        | null,

      column: null as
        | string
        | null,

      constraint: null as
        | string
        | null,
    };
  }

  const pgError =
    error as {
      code?: unknown;
      message?: unknown;
      detail?: unknown;
      hint?: unknown;
      table?: unknown;
      column?: unknown;
      constraint?: unknown;
    };

  return {
    code:
      typeof pgError.code ===
        'string'
        ? pgError.code
        : null,

    message:
      typeof pgError.message ===
        'string'
        ? pgError.message
        : safeErrorMessage(
            error
          ),

    detail:
      typeof pgError.detail ===
        'string'
        ? pgError.detail
        : null,

    hint:
      typeof pgError.hint ===
        'string'
        ? pgError.hint
        : null,

    table:
      typeof pgError.table ===
        'string'
        ? pgError.table
        : null,

    column:
      typeof pgError.column ===
        'string'
        ? pgError.column
        : null,

    constraint:
      typeof pgError.constraint ===
        'string'
        ? pgError.constraint
        : null,
  };
}

/* =========================================================
   NORMALIZAR SUBSCRIPTION

   Aceitamos o formato padrão:

   {
     endpoint: "...",
     expirationTime: null,
     keys: {
       p256dh: "...",
       auth: "..."
     }
   }

   Também toleramos chaves no nível superior como fallback.
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
      fields: string[];
      detail: string;
    } {
  if (
    typeof value !== 'object' ||
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
      endpoint?: unknown;

      expirationTime?: unknown;

      keys?: {
        p256dh?: unknown;
        auth?: unknown;
      };

      /*
       * Fallback para implementações/versões
       * antigas que eventualmente salvem as
       * chaves no nível superior.
       */
      p256dh?: unknown;
      auth?: unknown;
    };

  const invalidFields:
    string[] = [];

  const endpoint =
    typeof raw.endpoint ===
      'string'
      ? raw.endpoint.trim()
      : '';

  const nestedP256dh =
    raw.keys &&
    typeof raw.keys ===
      'object'
      ? raw.keys.p256dh
      : undefined;

  const nestedAuth =
    raw.keys &&
    typeof raw.keys ===
      'object'
      ? raw.keys.auth
      : undefined;

  const p256dh =
    typeof nestedP256dh ===
      'string'
      ? nestedP256dh.trim()
      : typeof raw.p256dh ===
          'string'
        ? raw.p256dh.trim()
        : '';

  const auth =
    typeof nestedAuth ===
      'string'
      ? nestedAuth.trim()
      : typeof raw.auth ===
          'string'
        ? raw.auth.trim()
        : '';

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
   * Web Push em produção deve possuir endpoint HTTPS.
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
  /* =======================================================
     1. LER JSON
  ======================================================= */

  let rawBody:
    unknown;

  try {
    rawBody =
      await request.json();
  } catch (error) {
    console.warn(
      '[PUSH SUBSCRIBE] JSON inválido:',
      safeErrorMessage(
        error
      )
    );

    return NextResponse.json(
      {
        ok: false,

        stage:
          'json',

        error:
          'O corpo da requisição não contém JSON válido.',
      },
      {
        status: 400,

        headers: {
          'Cache-Control':
            'no-store',
        },
      }
    );
  }

  /* =======================================================
     2. VALIDAR CAMPOS PRINCIPAIS
  ======================================================= */

  const parsed =
    requestSchema.safeParse(
      rawBody
    );

  if (!parsed.success) {
    const issues =
      parsed.error.issues.map(
        (issue) => ({
          field:
            issue.path.join(
              '.'
            ) || 'body',

          message:
            issue.message,
        })
      );

    const fields =
      Array.from(
        new Set(
          issues.map(
            (issue) =>
              issue.field
          )
        )
      );

    const detail =
      issues
        .map(
          (issue) =>
            `${issue.field}: ${issue.message}`
        )
        .join('; ');

    console.warn(
      '[PUSH SUBSCRIBE] Payload principal inválido:',
      fields
    );

    return NextResponse.json(
      {
        ok: false,

        stage:
          'validation',

        error:
          'Dados de inscrição inválidos.',

        fields,

        detail,
      },
      {
        status: 400,

        headers: {
          'Cache-Control':
            'no-store',
        },
      }
    );
  }

  const body =
    parsed.data;

  /* =======================================================
     3. NORMALIZAR SUBSCRIPTION
  ======================================================= */

  const normalized =
    normalizeSubscription(
      body.subscription
    );

  if (!normalized.ok) {
    console.warn(
      '[PUSH SUBSCRIBE] Subscription inválida:',
      normalized.fields
    );

    return NextResponse.json(
      {
        ok: false,

        stage:
          'subscription-validation',

        error:
          'A inscrição Web Push está incompleta ou inválida.',

        fields:
          normalized.fields,

        detail:
          normalized.detail,
      },
      {
        status: 400,

        headers: {
          'Cache-Control':
            'no-store',
        },
      }
    );
  }

  const subscription =
    normalized.value;

  /* =======================================================
     4. BANCO
  ======================================================= */

  let pool:
    ReturnType<
      typeof getPool
    >;

  try {
    pool =
      getPool();
  } catch (error) {
    console.error(
      '[PUSH SUBSCRIBE] Falha ao inicializar Pool:',
      error
    );

    return NextResponse.json(
      {
        ok: false,

        stage:
          'database-initialization',

        error:
          'Falha ao inicializar o banco de dados.',

        detail:
          safeErrorMessage(
            error
          ),
      },
      {
        status: 500,

        headers: {
          'Cache-Control':
            'no-store',
        },
      }
    );
  }

  if (!pool) {
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

        headers: {
          'Cache-Control':
            'no-store',
        },
      }
    );
  }

  /* =======================================================
     5. TESTAR POSTGRESQL
  ======================================================= */

  try {
    await pool.query(
      'select 1'
    );
  } catch (error) {
    const pg =
      getPostgresError(
        error
      );

    console.error(
      '[PUSH SUBSCRIBE] Falha de conexão:',
      {
        code:
          pg.code,

        message:
          pg.message,
      }
    );

    return NextResponse.json(
      {
        ok: false,

        stage:
          'database-connection',

        error:
          'Falha ao conectar ao banco de dados.',

        code:
          pg.code,

        detail:
          pg.message,
      },
      {
        status: 500,

        headers: {
          'Cache-Control':
            'no-store',
        },
      }
    );
  }

  /* =======================================================
     6. VERIFICAR TABELA
  ======================================================= */

  try {
    const tableCheck =
      await pool.query<{
        table_name:
          string | null;
      }>(
        `
          select
            to_regclass(
              'public.push_devices'
            )::text
              as table_name
        `
      );

    if (
      !tableCheck.rows[0]
        ?.table_name
    ) {
      return NextResponse.json(
        {
          ok: false,

          stage:
            'database-table',

          error:
            'A tabela public.push_devices não existe.',

          detail:
            'A DATABASE_URL da Vercel está conectada a um banco onde public.push_devices não foi encontrada.',
        },
        {
          status: 500,

          headers: {
            'Cache-Control':
              'no-store',
          },
        }
      );
    }
  } catch (error) {
    const pg =
      getPostgresError(
        error
      );

    console.error(
      '[PUSH SUBSCRIBE] Falha ao verificar tabela:',
      pg
    );

    return NextResponse.json(
      {
        ok: false,

        stage:
          'database-table-check',

        error:
          'Não foi possível verificar public.push_devices.',

        code:
          pg.code,

        detail:
          pg.message,
      },
      {
        status: 500,

        headers: {
          'Cache-Control':
            'no-store',
        },
      }
    );
  }

  /* =======================================================
     7. SALVAR / ATUALIZAR DEVICE
  ======================================================= */

  try {
    const result =
      await pool.query<{
        device_id:
          string;
      }>(
        `
          insert into
            public.push_devices
          (
            device_id,
            secret_hash,
            timezone,
            subscription,
            active,
            updated_at
          )

          values (
            $1,
            $2,
            $3,
            $4::jsonb,
            true,
            now()
          )

          on conflict (
            device_id
          )

          do update set
            secret_hash =
              excluded.secret_hash,

            timezone =
              excluded.timezone,

            subscription =
              excluded.subscription,

            active =
              true,

            updated_at =
              now()

          returning
            device_id
        `,
        [
          body.deviceId,

          hashSecret(
            body.deviceSecret
          ),

          body.timezone,

          JSON.stringify(
            subscription
          ),
        ]
      );

    const registeredDeviceId =
      result.rows[0]
        ?.device_id ??
      body.deviceId;

    console.info(
      '[PUSH SUBSCRIBE] Registrado com sucesso:',
      registeredDeviceId
    );

    return NextResponse.json(
      {
        ok: true,

        registered:
          true,

        deviceId:
          registeredDeviceId,
      },
      {
        status: 200,

        headers: {
          'Cache-Control':
            'no-store',
        },
      }
    );
  } catch (error) {
    const pg =
      getPostgresError(
        error
      );

    console.error(
      '[PUSH SUBSCRIBE] Falha ao salvar inscrição:',
      {
        code:
          pg.code,

        message:
          pg.message,

        detail:
          pg.detail,

        hint:
          pg.hint,

        table:
          pg.table,

        column:
          pg.column,

        constraint:
          pg.constraint,
      }
    );

    const details =
      [
        pg.message,
        pg.detail,
        pg.hint,

        pg.table
          ? `table=${pg.table}`
          : null,

        pg.column
          ? `column=${pg.column}`
          : null,

        pg.constraint
          ? `constraint=${pg.constraint}`
          : null,
      ]
        .filter(
          (
            value
          ): value is string =>
            Boolean(value)
        )
        .join(
          ' | '
        );

    return NextResponse.json(
      {
        ok: false,

        stage:
          'database-write',

        error:
          'Falha ao registrar Push.',

        code:
          pg.code,

        detail:
          details,
      },
      {
        status: 500,

        headers: {
          'Cache-Control':
            'no-store',
        },
      }
    );
  }
}
