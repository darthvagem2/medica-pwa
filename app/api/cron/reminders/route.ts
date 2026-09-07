export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  const secret =
    process.env.CRON_SECRET?.trim();

  if (!secret) {
    return new Response(
      JSON.stringify({
        ok: false,
        version: 'ENV_ONLY_V1',
        stage: 'cron-secret',
        error: 'CRON_SECRET ausente',
      }),
      {
        status: 503,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        },
      }
    );
  }

  const authorization =
    request.headers.get('authorization');

  if (
    authorization !==
    `Bearer ${secret}`
  ) {
    return new Response(
      JSON.stringify({
        ok: false,
        version: 'ENV_ONLY_V1',
        stage: 'authorization',
        error: 'Unauthorized',
      }),
      {
        status: 401,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        },
      }
    );
  }

  return new Response(
    JSON.stringify({
      ok: true,

      version:
        'ENV_ONLY_V1',

      stage:
        'environment-ok',

      environment: {
        databaseUrl:
          Boolean(
            process.env.DATABASE_URL
          ),

        databaseUrlLength:
          process.env.DATABASE_URL
            ?.length ?? 0,

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
    }),
    {
      status: 200,

      headers: {
        'content-type':
          'application/json; charset=utf-8',

        'cache-control':
          'no-store',
      },
    }
  );
}
