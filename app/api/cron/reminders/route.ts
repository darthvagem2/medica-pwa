export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

function json(
  body: unknown,
  status = 200
) {
  return new Response(
    JSON.stringify(body),
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

function errorMessage(
  error: unknown
) {
  if (error instanceof Error) {
    return error.message
      .replace(
        /postgres(?:ql)?:\/\/[^@\s]+@/gi,
        'postgresql://***@'
      )
      .replace(
        /Bearer\s+\S+/gi,
        'Bearer ***'
      );
  }

  return String(error);
}

function getPushStatusCode(
  error: unknown
): number | null {
  if (
    typeof error !== 'object' ||
    error === null
  ) {
    return null;
  }

  const raw =
    error as {
      statusCode?: unknown;
    };

  const value =
    Number(
      raw.statusCode
    );

  return Number.isFinite(value)
    ? value
    : null;
}

function parseSubscription(
  value: unknown
) {
  let data:
    unknown = value;

  if (
    typeof data ===
      'string'
  ) {
    data =
      JSON.parse(data);
  }

  if (
    typeof data !==
      'object' ||
    data === null
  ) {
    throw new Error(
      'Push subscription inválida.'
    );
  }

  const raw =
    data as {
      endpoint?: unknown;

      keys?: {
        p256dh?: unknown;
        auth?: unknown;
      };
    };

  if (
    typeof raw.endpoint !==
      'string' ||
    !raw.endpoint
  ) {
    throw new Error(
      'Push subscription sem endpoint.'
    );
  }

  if (
    typeof raw.keys?.p256dh !==
      'string' ||
    !raw.keys.p256dh
  ) {
    throw new Error(
      'Push subscription sem p256dh.'
    );
  }

  if (
    typeof raw.keys.auth !==
      'string' ||
    !raw.keys.auth
  ) {
    throw new Error(
      'Push subscription sem auth.'
    );
  }

  return {
    endpoint:
      raw.endpoint,

    keys: {
      p256dh:
        raw.keys.p256dh,

      auth:
        raw.keys.auth,
    },
  };
}

function localMinutes(
  date: Date,
  timezone: string
): number {
  try {
    const parts =
      new Intl.DateTimeFormat(
        'en-US',
        {
          timeZone:
            timezone,

          hour:
            '2-digit',

          minute:
            '2-digit',

          hourCycle:
            'h23',
        }
      ).formatToParts(
        date
      );

    const hour =
      Number(
        parts.find(
          (part) =>
            part.type ===
            'hour'
        )?.value
      );

    const minute =
      Number(
        parts.find(
          (part) =>
            part.type ===
            'minute'
        )?.value
      );

    if (
      !Number.isFinite(
        hour
      ) ||
      !Number.isFinite(
        minute
      )
    ) {
      return 0;
    }

    return (
      hour * 60 +
      minute
    );
  } catch {
    return 0;
  }
}

function parseHHMM(
  value: unknown
): number | null {
  if (
    typeof value !==
      'string' ||
    !/^\d{2}:\d{2}$/.test(
      value
    )
  ) {
    return null;
  }

  const [
    hour,
    minute,
  ] =
    value
      .split(':')
      .map(Number);

  if (
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  return (
    hour * 60 +
    minute
  );
}

function isQuietNow(
  now: Date,
  timezone: string,
  startValue: unknown,
  endValue: unknown
): boolean {
  const start =
    parseHHMM(
      startValue
    );

  const end =
    parseHHMM(
      endValue
    );

  if (
    start === null ||
    end === null ||
    start === end
  ) {
    return false;
  }

  const current =
    localMinutes(
      now,
      timezone
    );

  if (start < end) {
    return (
      current >= start &&
      current < end
    );
  }

  return (
    current >= start ||
    current < end
  );
}

export async function GET(
  request: Request
) {
  let pool:
    {
      query: (
        text: string,
        values?: unknown[]
      ) => Promise<{
        rows: any[];
        rowCount?: number | null;
      }>;

      connect: () =>
        Promise<any>;

      end: () =>
        Promise<void>;
    }
    | null = null;

  /*
   * O try/catch envolve ABSOLUTAMENTE TODA
   * a execução da Function.
   */
  try {
    /* ===============================================
       1. AUTORIZAÇÃO
    =============================================== */

    const cronSecret =
      process.env
        .CRON_SECRET
        ?.trim();

    if (!cronSecret) {
      return json(
        {
          ok: false,
          stage:
            'cron-configuration',
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
      return json(
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

    /* ===============================================
       2. DATABASE_URL
    =============================================== */

    const databaseUrl =
      process.env
        .DATABASE_URL
        ?.trim();

    if (!databaseUrl) {
      return json(
        {
          ok: false,
          stage:
            'database-configuration',
          error:
            'DATABASE_URL não configurada.',
        },
        503
      );
    }

    /*
     * Isso não revela a senha.
     */
    let databaseInfo:
      {
        username: string;
        host:
