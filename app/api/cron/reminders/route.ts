export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

function reply(body: unknown, status = 200) {
  return new Response(
    JSON.stringify(body, null, 2),
    {
      status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    }
  );
}

export async function GET(request: Request) {
  try {
    const secret =
      process.env.CRON_SECRET?.trim();

    if (!secret) {
      return reply(
        {
          ok: false,
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
          stage: 'authorization',
          error: 'Unauthorized',
        },
        401
      );
    }

    const databaseUrl =
      process.env.DATABASE_URL?.trim();

    if (!databaseUrl) {
      return reply(
        {
          ok: false,
          stage: 'database-url',
          error: 'DATABASE_URL ausente',
        },
        503
      );
    }

    let parsed: URL;

    try {
      parsed =
        new URL(databaseUrl);
    } catch {
      return reply(
        {
          ok: false,
          stage: 'database-url-format',
          error: 'DATABASE_URL inválida',
        },
        500
      );
    }

    return reply({
      ok: true,
      stage: 'environment-ok',

      database: {
        username:
          decodeURIComponent(
            parsed.username
          ),

        host:
          parsed.hostname,

        port:
          parsed.port || 'default',

        database:
          parsed.pathname,
      },

      environment: {
        databaseUrl: true,

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
        stage: 'unhandled',

        detail:
          error instanceof Error
            ? error.message
            : String(error),
      },
      500
    );
  }
}
