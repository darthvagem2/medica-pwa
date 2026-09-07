export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

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

function safeError(
  error: unknown
): string {
  let message =
    error instanceof Error
      ? error.message
      : String(error);

  message =
    message.replace(
      /postgres(?:ql)?:\/\/[^@\s]+@/gi,
      'postgresql://***@'
    );

  return message;
}

export async function GET(
  request: Request
) {
  try {
    /* ==============================
       1. CRON SECRET
    ============================== */

    const cronSecret =
      process.env
        .CRON_SECRET
        ?.trim();

    if (!cronSecret) {
      return reply(
        {
          ok: false,
          stage:
            'cron-secret',
          error:
            'CRON_SECRET não configurado.',
        },
        503
      );
    }

    const authorization =
      request.headers.get(
        'authorization'
      );

    if (
      authorization !==
      `Bearer ${cronSecret}`
    ) {
      return reply(
        {
          ok: false,
          stage:
            'authorization',
          error:
            'Unauthorized',
        },
        401
      );
    }

    /* ==============================
       2. DATABASE_URL
    ============================== */

    const databaseUrl =
      process.env
        .DATABASE_URL
        ?.trim();

    if (!databaseUrl) {
      return reply(
        {
          ok: false,
          stage:
            'database-url',
          error:
            'DATABASE_URL não configurada.',
        },
        503
      );
    }

    /* ==============================
       3. MOSTRAR URL SEM SENHA
    ============================== */

    let databaseInfo:
      {
        username: string;
        host: string;
        port: string;
        database: string;
      };

    try {
      const url =
        new URL(
          databaseUrl
        );

      databaseInfo = {
        username:
          decodeURIComponent(
            url.username
          ),

        host:
          url.hostname,

        port:
          url.port ||
          '(padrão)',

        database:
          url.pathname,
      };
    } catch {
      return reply(
        {
          ok: false,
          stage:
            'database-url-format',
          error:
            'DATABASE_URL possui formato inválido.',
        },
        500
      );
    }

    /* ==============================
       4. CARREGAR PG
    ============================== */

    let pg:
      typeof import('pg');

    try {
      pg =
        await import(
          'pg'
        );
    } catch (error) {
      return reply(
        {
          ok: false,
          stage:
            'pg-import',
          error:
            'Não foi possível carregar pg.',
          detail:
            safeError(
              error
            ),
        },
        500
      );
    }

    /* ==============================
       5. CONEXÃO
    ============================== */

    const pool =
      new pg.Pool({
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
      const connection =
        await pool.query<{
          current_user:
            string;

          current_database:
            string;
        }>(
          `
            select
              current_user,
              current_database()
                as current_database
          `
        );

      /* ==============================
         6. TABELAS
      ============================== */

      const tables =
        await pool.query<{
          push_devices:
            string | null;

          reminder_jobs:
            string | null;
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

      return reply({
        ok: true,

        stage:
          'diagnostic-complete',

        databaseUrl: {
          username:
            databaseInfo.username,

          host:
            databaseInfo.host,

          port:
            databaseInfo.port,

          database:
            databaseInfo.database,
        },

        connectedAs:
          connection.rows[0]
            ?.current_user,

        connectedDatabase:
          connection.rows[0]
            ?.current_database,

        tables:
          tables.rows[0],

        environment: {
          vapidPublic:
            Boolean(
              process.env
                .NEXT_PUBLIC_VAPID_PUBLIC_KEY
            ),

          vapidPrivate:
            Boolean(
              process.env
                .VAPID_PRIVATE_KEY
            ),

          vapidSubject:
            Boolean(
              process.env
                .VAPID_SUBJECT
            ),
        },
      });
    } catch (error) {
      return reply(
        {
          ok: false,

          stage:
            'database-connection',

          error:
            'Falha ao conectar ao PostgreSQL.',

          detail:
            safeError(
              error
            ),

          databaseUrl: {
            username:
              databaseInfo.username,

            host:
              databaseInfo.host,

            port:
              databaseInfo.port,

            database:
              databaseInfo.database,
          },
        },
        500
      );
    } finally {
      try {
        await pool.end();
      } catch {
        // ignore
      }
    }
  } catch (error) {
    return reply(
      {
        ok: false,

        stage:
          'unhandled',

        error:
          'Erro inesperado.',

        detail:
          safeError(
            error
          ),
      },
      500
    );
  }
}
