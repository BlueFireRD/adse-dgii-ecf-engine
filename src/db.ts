import { Pool } from 'pg';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGO = 'aes-256-gcm';

let _pool: Pool | null = null;

/** Get (or lazily create) the shared connection pool. Throws if DATABASE_URL is absent. */
export function getPool(): Pool {
  if (!_pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is not configured');
    }
    const ssl = process.env.PGSSLMODE === 'disable'
      ? undefined
      : { rejectUnauthorized: false };
    _pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl });
  }
  return _pool;
}

function getStoreKey(): Buffer {
  const hex = process.env.CERT_STORE_KEY;
  if (!hex) throw new Error('CERT_STORE_KEY is required for tenant cert storage');
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== 32) throw new Error('CERT_STORE_KEY must be 32 bytes (64 hex chars)');
  return buf;
}

/**
 * Encrypt plaintext with AES-256-GCM.
 * Wire format: base64( iv[12] || authTag[16] || ciphertext )
 */
export function encrypt(plaintext: string): string {
  const key = getStoreKey();
  const iv  = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct  = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

/** Decrypt a value produced by encrypt(). */
export function decrypt(encoded: string): string {
  const key = getStoreKey();
  const buf = Buffer.from(encoded, 'base64');
  const iv  = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct  = buf.subarray(28);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/**
 * Idempotent schema migration — creates both tables if they do not exist.
 * Silently no-ops when DATABASE_URL is absent (env-cert-only mode).
 * Call once at server startup.
 */
export async function runMigration(): Promise<void> {
  let db: Pool;
  try {
    db = getPool();
  } catch {
    return; // DATABASE_URL not set — skip
  }
  await db.query(`
    CREATE TABLE IF NOT EXISTS tenant_certs (
      rnc             TEXT PRIMARY KEY,
      p12_base64_enc  TEXT NOT NULL,
      password_enc    TEXT NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS tenant_sequences (
      rnc         TEXT    NOT NULL,
      ecf_type    TEXT    NOT NULL,
      environment TEXT    NOT NULL DEFAULT 'certecf',
      desde       BIGINT  NOT NULL,
      hasta       BIGINT  NOT NULL,
      actual      BIGINT  NOT NULL,
      vencimiento DATE,
      activo      BOOLEAN NOT NULL DEFAULT TRUE,
      PRIMARY KEY (rnc, ecf_type, environment)
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS tenant_registry (
      rnc          TEXT PRIMARY KEY,
      display_name TEXT,
      channel      TEXT NOT NULL DEFAULT 'crm'
                   CHECK (channel IN ('crm','pos','external_api')),
      status       TEXT NOT NULL DEFAULT 'onboarding'
                   CHECK (status IN ('onboarding','active','offboarding','closed')),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS tenant_certifications (
      rnc            TEXT PRIMARY KEY REFERENCES tenant_registry(rnc),
      state          TEXT NOT NULL DEFAULT 'prerequisites_check',
      required_types JSONB NOT NULL DEFAULT '[]',
      updated_by     TEXT,
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS tenant_lifecycle_events (
      id         BIGSERIAL PRIMARY KEY,
      rnc        TEXT NOT NULL,
      from_state TEXT,
      to_state   TEXT NOT NULL,
      actor      TEXT NOT NULL,
      evidence   JSONB,
      notes      TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_lifecycle_events_rnc
      ON tenant_lifecycle_events (rnc, created_at)
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS receptor_seeds (
      valor      TEXT PRIMARY KEY,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS receptor_received_encf (
      rnc_comprador TEXT NOT NULL,
      encf          TEXT NOT NULL,
      first_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (rnc_comprador, encf)
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS receptor_documents (
      id            BIGSERIAL PRIMARY KEY,
      kind          TEXT NOT NULL CHECK (kind IN ('recepcion','aprobacion_comercial','recepcion_fc')),
      rnc_comprador TEXT,
      rnc_emisor    TEXT,
      encf          TEXT,
      tipo          TEXT,
      verdict       TEXT NOT NULL,
      xml           TEXT NOT NULL,
      response_xml  TEXT,
      received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      forwarded_at  TIMESTAMPTZ,
      forward_error TEXT
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_receptor_docs_tenant
      ON receptor_documents (rnc_comprador, received_at)
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS tenant_test_sets (
      id           BIGSERIAL PRIMARY KEY,
      rnc          TEXT NOT NULL,
      kind         TEXT NOT NULL CHECK (kind IN ('ecf','rfce','acecf','paso4_plan')),
      cases        JSONB NOT NULL,
      case_count   INT  NOT NULL,
      source_note  TEXT,
      uploaded_by  TEXT NOT NULL,
      active       BOOLEAN NOT NULL DEFAULT TRUE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_test_sets_active
      ON tenant_test_sets (rnc, kind) WHERE active
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS test_runs (
      id               BIGSERIAL PRIMARY KEY,
      rnc              TEXT NOT NULL,
      scope            TEXT NOT NULL CHECK (scope IN ('set_pruebas','acecf','simulacion')),
      environment      TEXT NOT NULL,
      dry_run          BOOLEAN NOT NULL,
      actor            TEXT NOT NULL,
      status           TEXT NOT NULL CHECK (status IN
        ('running','completed','completed_with_errors','failed','cancelled','interrupted')),
      cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
      params           JSONB,
      totals           JSONB,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at       TIMESTAMPTZ,
      finished_at      TIMESTAMPTZ
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_test_runs_rnc
      ON test_runs (rnc, created_at DESC)
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_test_runs_running
      ON test_runs (rnc) WHERE status = 'running'
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS test_run_cases (
      run_id           BIGINT NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
      position         INT NOT NULL,
      encf             TEXT NOT NULL,
      tipo             TEXT,
      kind             TEXT NOT NULL CHECK (kind IN ('ecf','rfce','acecf')),
      status           TEXT NOT NULL CHECK (status IN
        ('pending','preparing','sent','aceptado','rechazado','already_accepted',
         'skipped','error','cancelled')),
      track_id         TEXT,
      mensajes         JSONB,
      codigo_seguridad TEXT,
      fecha_firma      TEXT,
      qr_url           TEXT,
      signed_xml       TEXT,
      full_invoice_xml TEXT,
      error            TEXT,
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (run_id, position)
    )
  `);

  // Surface any run that was mid-flight when the process restarted.
  await db.query(`
    UPDATE test_runs SET status='interrupted', finished_at=now() WHERE status='running'
  `);

  // Widen CHECK constraints for existing DBs (idempotent — skips if already widened).
  // Log actual constraint names for operational reporting.
  const { rows: kindCons } = await db.query(`
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'tenant_test_sets'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%kind%'`);
  console.log('[db] tenant_test_sets kind constraint:', kindCons[0]?.conname ?? '(none)');
  await db.query(`
    DO $$
    DECLARE cname TEXT;
    BEGIN
      SELECT conname INTO cname FROM pg_constraint
      WHERE conrelid = 'tenant_test_sets'::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%kind%'
        AND pg_get_constraintdef(oid) NOT LIKE '%paso4_plan%';
      IF cname IS NOT NULL THEN
        EXECUTE 'ALTER TABLE tenant_test_sets DROP CONSTRAINT ' || quote_ident(cname);
        ALTER TABLE tenant_test_sets ADD CONSTRAINT tenant_test_sets_kind_check
          CHECK (kind IN ('ecf','rfce','acecf','paso4_plan'));
      END IF;
    END $$
  `);

  const { rows: scopeCons } = await db.query(`
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'test_runs'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%scope%'`);
  console.log('[db] test_runs scope constraint:', scopeCons[0]?.conname ?? '(none)');
  await db.query(`
    DO $$
    DECLARE cname TEXT;
    BEGIN
      SELECT conname INTO cname FROM pg_constraint
      WHERE conrelid = 'test_runs'::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%scope%'
        AND pg_get_constraintdef(oid) NOT LIKE '%simulacion%';
      IF cname IS NOT NULL THEN
        EXECUTE 'ALTER TABLE test_runs DROP CONSTRAINT ' || quote_ident(cname);
        ALTER TABLE test_runs ADD CONSTRAINT test_runs_scope_check
          CHECK (scope IN ('set_pruebas','acecf','simulacion'));
      END IF;
    END $$
  `);

  console.log('[db] schema OK');
}
