export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

function reply(body: unknown, status = 200) {
  return new Response(
    JSON.stringify(body, null, 2),
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

function safeError(error: unknown) {
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
    /* =========================================
       1. AUTORIZAÇÃO
    ========================================= */

    const secret =
      process.env.CRON_SECRET?.trim();

    if (!secret) {
      return reply(
        {
          ok: false,
          version: 'POSTGRES_TEST_V1',
          stage: 'cron-secret',
          error: 'CRON_SECRET ausente',
        },
        503
      );
    }

    if (
      request.headers.get('authorization') !==
      `Bearer ${secret}`
    ) {
      return reply(
        {
          ok: false,
          version: 'POSTGRES_TEST_V1',
          stage: 'authorization',
          error: 'Unauthorized',
        },
        401
      );
    }

    /* =========================================
       2. DATABASE_URL
    ========================================= */

    const databaseUrl =
      process.env.DATABASE_URL?.trim();

    if (!databaseUrl) {
      return reply(
        {
          ok: false,
          version: 'POSTGRES_TEST_V1',
          stage: 'database-url',
          error: 'DATABASE_URL ausente',
        },
        503
      );
    }

    /* =========================================
       3. CARREGAR PG
    ========================================= */

    let Pool:
      typeof import('pg').Pool;

    try {
      const pg =
        await import('pg');

      Pool =
        pg.Pool;
    } catch (error) {
      return reply(
        {
          ok: false,
          version: 'POSTGRES_TEST_V1',
          stage: 'pg-import',
          error: 'Falha ao carregar pg',
          detail: safeError(error),
        },
        500
      );
    }

    /* =========================================
       4. CRIAR POOL
    ========================================= */

    const pool =
      new Pool({
        connectionString:
          databaseUrl,

        ssl: {
          rejectUnauthorized:
            false,
        },

        max: 1,

        connectionTimeoutMillis:
          10000,

        idleTimeoutMillis:
          5000,

        allowExitOnIdle:
          true,
      });

    try {
      /* =======================================
         5. TESTAR CONEXÃO REAL
      ======================================= */

      const connection =
        await pool.query<{
          current_user: string;
          current_database: string;
          postgres_version: string;
        }>(
          `
            select
              current_user,
              current_database()
                as current_database,
              version()
                as postgres_version
          `
        );

      /* =======================================
         6. VERIFICAR TABELAS
      ======================================= */

      const tables =
        await pool.query<{
          push_devices: string | null;
          reminder_jobs: string | null;
        }>(
          `
            select
              to_regclass(
                'public.push_devices'
              )::text
                as push_devices,

              to_regclass(
                'public.reminder_jobs'
              )::text
                as reminder_jobs
          `
        );

      /* =======================================
         7. CONTAR REGISTROS
      ======================================= */

      const counts =
        await pool.query<{
          push_devices_count: string;
          reminder_jobs_count: string;
        }>(
          `
            select
              (
                select count(*)
                from public.push_devices
              )::text
                as push_devices_count,

              (
                select count(*)
                from public.reminder_jobs
              )::text
                as reminder_jobs_count
          `
        );

      return reply({
        ok: true,

        version:
          'POSTGRES_TEST_V1',

        stage:
          'postgres-connected',

        postgres: {
          user:
            connection.rows[0]
              ?.current_user,

          database:
            connection.rows[0]
              ?.current_database,

          version:
            connection.rows[0]
              ?.postgres_version,
        },

        tables:
          tables.rows[0],

        counts:
          counts.rows[0],
      });
    } catch (error) {
      return reply(
        {
          ok: false,

          version:
            'POSTGRES_TEST_V1',

          stage:
            'postgres-connection',

          error:
            'Falha ao conectar ao PostgreSQL.',

          detail:
            safeError(error),
        },
        500
      );
    } finally {
      await pool
        .end()
        .catch(() => undefined);
    }
  } catch (error) {
    return reply(
      {
        ok: false,

        version:
          'POSTGRES_TEST_V1',

        stage:
          'unhandled',

        detail:
          safeError(error),
      },
      500
    );
  }
}
