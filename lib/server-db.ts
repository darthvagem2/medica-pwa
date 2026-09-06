import { Pool } from 'pg';
import {
  createHash,
  timingSafeEqual,
} from 'node:crypto';

/**
 * =========================================================
 * POSTGRESQL / SUPABASE
 * =========================================================
 *
 * Uma única instância do Pool pode ser reutilizada enquanto
 * a Function da Vercel continuar "quente".
 */

let cachedPool: Pool | null = null;

/**
 * Retorna o Pool PostgreSQL.
 *
 * Se DATABASE_URL não existir, retorna null.
 */
export function getPool(): Pool | null {
  const connectionString =
    process.env.DATABASE_URL?.trim();

  if (!connectionString) {
    return null;
  }

  /**
   * Reutiliza a conexão já criada.
   */
  if (cachedPool) {
    return cachedPool;
  }

  cachedPool = new Pool({
    connectionString,

    /**
     * Supabase exige SSL.
     *
     * Em desenvolvimento local podemos
     * deixar SSL desabilitado.
     */
    ssl:
      connectionString.includes('localhost') ||
      connectionString.includes('127.0.0.1')
        ? undefined
        : {
            rejectUnauthorized: false,
          },

    /**
     * Como estamos usando Vercel + Supabase
     * Transaction Pooler, mantemos um número
     * pequeno de conexões.
     */
    max: 2,

    idleTimeoutMillis: 30_000,

    connectionTimeoutMillis: 10_000,

    allowExitOnIdle: true,
  });

  /**
   * Evita que erro inesperado de conexão
   * derrube silenciosamente o processo.
   */
  cachedPool.on(
    'error',
    (error) => {
      console.error(
        '[PostgreSQL Pool] Erro inesperado:',
        error
      );
    }
  );

  return cachedPool;
}

/**
 * =========================================================
 * COMPATIBILIDADE COM ROTAS ANTIGAS
 * =========================================================
 *
 * Algumas rotas atuais ainda fazem:
 *
 * import { pool } from '@/lib/server-db';
 *
 * Portanto mantemos este export enquanto essas rotas
 * não forem migradas para getPool().
 */
export const pool: Pool | null =
  getPool();

/**
 * =========================================================
 * DEVICE SECRET
 * =========================================================
 */

/**
 * Cria um SHA-256 do segredo do dispositivo.
 *
 * Nunca salvamos o deviceSecret original no banco.
 */
export function hashSecret(
  secret: string
): string {
  return createHash('sha256')
    .update(secret, 'utf8')
    .digest('hex');
}

/**
 * Compara dois hashes de forma mais segura.
 */
function safeHashCompare(
  left: string,
  right: string
): boolean {
  try {
    const leftBuffer =
      Buffer.from(
        left,
        'hex'
      );

    const rightBuffer =
      Buffer.from(
        right,
        'hex'
      );

    if (
      leftBuffer.length === 0 ||
      leftBuffer.length !==
        rightBuffer.length
    ) {
      return false;
    }

    return timingSafeEqual(
      leftBuffer,
      rightBuffer
    );
  } catch {
    return false;
  }
}

/**
 * =========================================================
 * AUTENTICAR DISPOSITIVO
 * =========================================================
 *
 * Usado por:
 *
 * /api/reminders/sync
 * /api/reminders/cancel
 * /api/push/unsubscribe
 *
 * e outras rotas privadas do dispositivo.
 */

export async function assertDevice(
  deviceId: string,
  secret: string
): Promise<void> {
  if (!deviceId) {
    throw new Error(
      'deviceId não informado'
    );
  }

  if (!secret) {
    throw new Error(
      'deviceSecret não informado'
    );
  }

  /**
   * Preferimos o pool exportado para manter
   * compatibilidade com as rotas atuais.
   *
   * Se por algum motivo ele for null,
   * tentamos getPool() novamente.
   */
  const db =
    pool ?? getPool();

  if (!db) {
    throw new Error(
      'DATABASE_URL não configurada'
    );
  }

  const result =
    await db.query<{
      secret_hash: string;
      active: boolean;
    }>(
      `
        select
          secret_hash,
          active

        from push_devices

        where device_id = $1

        limit 1
      `,
      [
        deviceId,
      ]
    );

  /**
   * Dispositivo não existe.
   */
  if (
    result.rowCount === 0 ||
    !result.rows[0]
  ) {
    throw new Error(
      'Dispositivo não autorizado'
    );
  }

  const device =
    result.rows[0];

  /**
   * Dispositivo foi desativado.
   */
  if (
    device.active === false
  ) {
    throw new Error(
      'Dispositivo desativado'
    );
  }

  const suppliedHash =
    hashSecret(secret);

  const storedHash =
    device.secret_hash;

  if (
    !safeHashCompare(
      suppliedHash,
      storedHash
    )
  ) {
    throw new Error(
      'Dispositivo não autorizado'
    );
  }
}

/**
 * =========================================================
 * TESTE DE CONEXÃO
 * =========================================================
 *
 * Pode ser usado posteriormente em health checks.
 */
export async function testDatabaseConnection(): Promise<boolean> {
  const db =
    pool ?? getPool();

  if (!db) {
    return false;
  }

  try {
    await db.query(
      'select 1'
    );

    return true;
  } catch (error) {
    console.error(
      '[PostgreSQL] Teste de conexão falhou:',
      error
    );

    return false;
  }
}

/**
 * =========================================================
 * ENCERRAMENTO
 * =========================================================
 *
 * Normalmente NÃO precisamos chamar isso na Vercel.
 * É útil principalmente em testes automatizados.
 */
export async function closeDatabasePool(): Promise<void> {
  if (!cachedPool) {
    return;
  }

  const currentPool =
    cachedPool;

  cachedPool = null;

  await currentPool.end();
}
