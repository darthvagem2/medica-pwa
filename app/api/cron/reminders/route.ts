export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function errorText(error: unknown) {
  if (error instanceof Error) {
    return error.message.replace(
      /postgres(?:ql)?:\/\/[^@\s]+@/gi,
      'postgresql://***@'
    );
  }

  return String(error);
}

export async function GET(request: Request) {
  try {
    // 1. CRON_SECRET
    const secret =
      process.env.CRON_SECRET?.trim();

    if (!secret) {
      return response(
        {
          ok: false,
          stage: 'cron-secret',
          error: 'CRON_SECRET não configurado',
        },
        503
      );
    }

    if (
      request.headers.get('authorization') !==
      `Bearer ${secret}`
    ) {
      return response(
        {
          ok: false,
          stage: 'authorization',
          error: 'Unauthorized',
        },
        401
      );
    }

    // 2. DATABASE_URL
    const databaseUrl =
      process.env.DATABASE_URL?.trim();

    if (!databaseUrl) {
      return response(
        {
          ok: false,
          stage: 'database-url',
          error: 'DATABASE_URL não configurada',
        },
        503
      );
    }

    // Mostra informações seguras, sem senha.
    let databaseInfo;

    try {
      const url = new URL(databaseUrl);

      databaseInfo = {
        username: decodeURIComponent(url.username),
        host: url.hostname,
        port: url.port || 'default',
        database: url.pathname,
      };
    } catch {
      return response(
        {
          ok: false,
          stage: 'database-url-format',
          error: 'DATABASE_URL possui formato inválido',
        },
        500
      );
    }

    // 3. PostgreSQL
    const { Pool } =
      await import('pg');

    const pool =
      new Pool({
        connectionString: databaseUrl,
        ssl: {
          rejectUnauthorized: false,
        },
        max: 1,
        connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 5000,
        allowExitOnIdle: true,
      });

    try {
      const connection =
        await pool.query(`
          select
            current_user,
            current_database() as current_database
        `);

      const tables =
        await pool.query(`
          select
            to_regclass('public.push_devices')::text
              as push_devices,
            to_regclass('public.reminder_jobs')::text
              as reminder_jobs
        `);

      return response({
        ok: true,
        stage: 'diagnostic-complete',

        databaseUrl: databaseInfo,

        connectedAs:
          connection.rows[0]?.current_user,

        connectedDatabase:
          connection.rows[0]?.current_database,

        tables:
          tables.rows[0],

        vapid: {
          publicKey:
            Boolean(
              process.env
                .NEXT_PUBLIC_VAPID_PUBLIC_KEY
            ),

          privateKey:
            Boolean(
              process.env
                .VAPID_PRIVATE_KEY
            ),

          subject:
            Boolean(
              process.env
                .VAPID_SUBJECT
            ),
        },
      });
    } catch (error) {
      return response(
        {
          ok: false,
          stage: 'database-connection',
          error: 'Falha ao conectar ao PostgreSQL',
          detail: errorText(error),
          databaseUrl: databaseInfo,
        },
        500
      );
    } finally {
      await pool
        .end()
        .catch(() => undefined);
    }
  } catch (error) {
    return response(
      {
        ok: false,
        stage: 'unhandled',
        error: 'Erro inesperado',
        detail: errorText(error),
      },
      500
    );
  }
}
