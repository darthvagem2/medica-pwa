import { Pool } from 'pg';
import crypto from 'node:crypto';

const connectionString = process.env.DATABASE_URL;
export const pool = connectionString ? new Pool({ connectionString, ssl: connectionString.includes('localhost') ? undefined : { rejectUnauthorized: false } }) : null;

export function hashSecret(secret: string) {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

export async function assertDevice(deviceId: string, secret: string) {
  if (!pool) throw new Error('DATABASE_URL não configurada');
  const result = await pool.query('select secret_hash from push_devices where device_id = $1', [deviceId]);
  if (!result.rowCount || result.rows[0].secret_hash !== hashSecret(secret)) throw new Error('Dispositivo não autorizado');
}
