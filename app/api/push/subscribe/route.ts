import { NextResponse } from 'next/server';
import { Pool } from 'pg';
import { z } from 'zod';
import crypto from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

let cachedPool: Pool | null = null;

function getPool(): Pool | null {
  const connectionString = process.env.DATABASE_URL?.trim();

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
    max: 2,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  return cachedPool;
}

function hashSecret(secret: string) {
  return crypto
    .createHash('sha256')
    .update(secret)
    .digest('hex');
}

function safeError(error: unknown) {
  if (error instanceof Error) {
    return error.message.replace(
      /postgres(?:ql)?:\/\/[^@\s]+@/gi,
      'postgresql://***@'
    );
  }

  return String(error);
}

const schema = z.object({
  deviceId: z.string().min(20),
  deviceSecret: z.string().min(32),
  timezone: z.string().min(1),

  subscription: z.object({
    endpoint: z.string().url(),

    expirationTime:
      z.number().nullable().optional(),

    keys: z.object({
      p256dh: z.string().min(1),
      auth: z.string().min(1),
    }),
  }),
});

export async function POST(req: Request) {
  let body: z.infer<typeof schema>;

  try {
    body = schema.parse(await req.json());
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        stage: 'validation',
        error: 'Dados de inscrição inválidos.',
        detail: safeError(error),
      },
      {
        status: 400,
      }
    );
  }

  const pool = getPool();

  if (!pool) {
    return NextResponse.json(
      {
        ok: false,
        stage: 'database-configuration',
        error: 'DATABASE_URL não configurada.',
      },
      {
        status: 503,
      }
    );
  }

  try {
    await pool.query('select 1');
  } catch (error) {
    console.error(
      '[PUSH SUBSCRIBE] Falha ao conectar ao PostgreSQL:',
      error
    );

    return NextResponse.json(
      {
        ok: false,
        stage: 'database-connection',
        error: 'Falha ao conectar ao banco de dados.',
        detail: safeError(error),
      },
      {
        status: 500,
      }
    );
  }

  try {
    await pool.query(
      `
        insert into push_devices (
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

        on conflict (device_id)

        do update set
          secret_hash = excluded.secret_hash,
          timezone = excluded.timezone,
          subscription = excluded.subscription,
          active = true,
          updated_at = now()
      `,
      [
        body.deviceId,
        hashSecret(body.deviceSecret),
        body.timezone,
        JSON.stringify(body.subscription),
      ]
    );

    return NextResponse.json(
      {
        ok: true,
        registered: true,
      },
      {
        status: 200,
      }
    );
  } catch (error) {
    console.error(
      '[PUSH SUBSCRIBE] Falha ao salvar inscrição:',
      error
    );

    return NextResponse.json(
      {
        ok: false,
        stage: 'database-write',
        error: 'Falha ao registrar push.',
        detail: safeError(error),
      },
      {
        status: 500,
      }
    );
  }
}
