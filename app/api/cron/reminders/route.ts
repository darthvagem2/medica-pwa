export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();

  if (!secret) {
    return reply(
      {
        ok: false,
        version: 'ENV_ONLY_V2',
        stage: 'cron-secret',
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
        version: 'ENV_ONLY_V2',
        stage: 'authorization',
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
        version: 'ENV_ONLY_V2',
        stage: 'database-url',
      },
      503
    );
  }

  try {
    const parsed =
      new URL(databaseUrl);

    const username =
      decodeURIComponent(
        parsed.username
      );

    return reply({
      ok: true,

      version:
        'ENV_ONLY_V2',

      stage:
        'database-url-ok',

      database: {
        protocol:
          parsed.protocol,

        username,

        host:
          parsed.hostname,

        port:
          parsed.port ||
          'default',

        database:
          parsed.pathname,

        passwordPresent:
          parsed.password.length > 0,

        transactionPooler:
          parsed.hostname.includes(
            '.pooler.supabase.com'
          ) &&
          parsed.port === '6543',

        poolerUsername:
          username.startsWith(
            'postgres.'
          ),
      },

      vapid: {
        public:
          Boolean(
            process.env
              .NEXT_PUBLIC_VAPID_PUBLIC_KEY
          ),

        private:
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
  } catch {
    return reply(
      {
        ok: false,
        version: 'ENV_ONLY_V2',
        stage: 'database-url-format',
        error: 'DATABASE_URL inválida',
      },
      500
    );
  }
}
