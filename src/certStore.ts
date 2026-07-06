import { getPool, encrypt, decrypt } from './db';
import { loadP12FromDerBinary, keyFromEnv, KeyMaterial } from './signer';

const certCache = new Map<string, KeyMaterial>();

/**
 * Resolve the signing KeyMaterial for a given RNC.
 * Resolution order:
 *   1. In-process cache (per restart)
 *   2. tenant_certs row in Postgres (decrypted with CERT_STORE_KEY)
 *   3. Env cert (P12_BASE64 / P12_PATH + P12_PASSWORD) — covers ADSE / RNC 133470616
 * Returns null only when no cert is available at all.
 */
export async function keyForRnc(rnc: string): Promise<KeyMaterial | null> {
  const hit = certCache.get(rnc);
  if (hit) return hit;

  try {
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
  } catch {
    // DB unavailable or no row — fall through to env cert
  }

  const envKey = keyFromEnv();
  if (envKey) {
    certCache.set(rnc, envKey);
    return envKey;
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
