import { getPool, encrypt, decrypt } from './db';
import { loadP12FromDerBinary, keyFromEnv, KeyMaterial } from './signer';

const certCache = new Map<string, KeyMaterial>();

/**
 * Resolve the signing KeyMaterial for a given RNC.
 * Resolution order:
 *   1. In-process cache (per restart)
 *   2. tenant_certs row in Postgres (decrypted with CERT_STORE_KEY)
 *   3. Env cert (P12_BASE64 / P12_PATH + P12_PASSWORD) — ANCHOR ONLY (RNC 133470616)
 * DB errors rethrow — a database outage must never silently swap signing identities.
 * Returns null when no cert is available (non-anchor with no DB row).
 */
export async function keyForRnc(rnc: string): Promise<KeyMaterial | null> {
  const hit = certCache.get(rnc);
  if (hit) return hit;

  const db = getPool();
  const { rows } = await db.query<{ p12_base64_enc: string; password_enc: string }>(
    'SELECT p12_base64_enc, password_enc FROM tenant_certs WHERE rnc = $1',
    [rnc]
  );
  if (rows.length > 0) {
    const p12Base64 = decrypt(rows[0].p12_base64_enc);
    const password  = decrypt(rows[0].password_enc);
    const der = Buffer.from(p12Base64, 'base64').toString('binary');
    const key = loadP12FromDerBinary(der, password);
    certCache.set(rnc, key);
    return key;
  }

  if (rnc === '133470616') {
    const envKey = keyFromEnv();
    if (envKey) {
      certCache.set(rnc, envKey);
      return envKey;
    }
  }

  return null;
}

/**
 * Store or replace a tenant cert (p12 as raw base64, password in clear-text).
 * Both values are encrypted with AES-256-GCM before writing.
 * Clears the in-process cache entry so the next keyForRnc re-reads from DB.
 */
export async function upsertCert(rnc: string, p12Base64: string, password: string): Promise<void> {
  const db = getPool();
  await db.query(
    `INSERT INTO tenant_certs (rnc, p12_base64_enc, password_enc, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (rnc) DO UPDATE SET
       p12_base64_enc = EXCLUDED.p12_base64_enc,
       password_enc   = EXCLUDED.password_enc,
       updated_at     = now()`,
    [rnc, encrypt(p12Base64), encrypt(password)]
  );
  certCache.delete(rnc);
}

/**
 * Atomically reserve the next eNCF in the tenant's active sequence range.
 * Uses a single UPDATE ... RETURNING so two concurrent calls never get the
 * same number. Returns the formatted eNCF ("E" + ecfType + 10-digit seq).
 * Throws when no active range exists or the range is exhausted.
 */
export async function reservarEncf(rnc: string, ecfType: string, environment: string): Promise<string> {
  const db = getPool();
  const env = normalizeEnv(environment);
  const { rows } = await db.query<{ actual: string }>(
    `UPDATE tenant_sequences
        SET actual = actual + 1
      WHERE rnc = $1 AND ecf_type = $2 AND environment = $3
        AND activo = TRUE AND actual < hasta
      RETURNING actual`,
    [rnc, ecfType, env]
  );
  if (rows.length === 0) {
    throw new Error(`No active sequence for RNC=${rnc} type=${ecfType} env=${env}`);
  }
  const num = Number(rows[0].actual);
  return `E${ecfType}${String(num).padStart(10, '0')}`;
}

/** Insert or update an eNCF sequence range for a tenant. */
export async function upsertSequence(opts: {
  rnc: string;
  ecfType: string;
  environment: string;
  desde: number;
  hasta: number;
  actual: number;
  vencimiento?: string;
}): Promise<void> {
  const db = getPool();
  const env = normalizeEnv(opts.environment);
  await db.query(
    `INSERT INTO tenant_sequences
       (rnc, ecf_type, environment, desde, hasta, actual, vencimiento, activo)
     VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
     ON CONFLICT (rnc, ecf_type, environment) DO UPDATE SET
       desde       = EXCLUDED.desde,
       hasta       = EXCLUDED.hasta,
       actual      = EXCLUDED.actual,
       vencimiento = EXCLUDED.vencimiento,
       activo      = TRUE`,
    [opts.rnc, opts.ecfType, env, opts.desde, opts.hasta, opts.actual, opts.vencimiento ?? null]
  );
}

/** Normalize an environment string to the canonical DB value ('certecf' or 'ecf').
 * requireEnvironment() in api.ts now rejects all unknown values at the API boundary,
 * so inputs arriving here are guaranteed to be 'certecf' or 'ecf'. */
export function normalizeEnv(env: string): string {
  const e = (env || '').toLowerCase().trim();
  return (e === 'ecf' || e === 'prod' || e === 'produccion' || e === 'production')
    ? 'ecf'
    : 'certecf';
}
