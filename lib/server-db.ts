import { Pool } from 'pg';
import crypto from 'node:crypto';

let cachedPool: Pool | null = null;

export function getPool(): Pool | null {
  const connectionString =
    process.env.DATABASE_URL?.trim();

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

    max: 5,

    idleTimeoutMillis: 30000,

    connectionTimeoutMillis: 10000,
  });

  cachedPool.on('error', (error) => {
    console.error(
      '[PostgreSQL Pool]',
      error
    );
  });

  return cachedPool;
}

export function hashSecret(
  secret: string
) {
  return crypto
    .createHash('sha256')
    .update(secret)
    .digest('hex');
}

export async function assertDevice(
  deviceId: string,
  secret: string
) {
  const pool = getPool();

  if (!pool) {
    throw new Error(
      'DATABASE_URL não configurada'
    );
  }

  const result =
    await pool.query(
      `
        select secret_hash
        from push_devices
        where device_id = $1
      `,
      [deviceId]
    );

  if (
    !result.rowCount ||
    result.rows[0].secret_hash !==
      hashSecret(secret)
  ) {
    throw new Error(
      'Dispositivo não autorizado'
    );
  }
}
