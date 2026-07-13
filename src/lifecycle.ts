import * as forge from 'node-forge';
import { getPool } from './db';
import { keyFromEnv } from './signer';

const ANCHOR_RNC = '133470616';

// Lazily-computed, module-cached env-cert metadata for the anchor.
// undefined = not yet attempted; null = attempt failed or env not set.
let _envCertMeta: { subject: string | null; notAfter: string | null } | null | undefined =
  undefined;

function getEnvCertMeta(): { subject: string | null; notAfter: string | null } | null {
  if (_envCertMeta !== undefined) return _envCertMeta;
  try {
    const km = keyFromEnv();
    if (!km) { _envCertMeta = null; return null; }
    const cert = forge.pki.certificateFromPem(km.certPem);
    const cnAttr = cert.subject.getField('CN');
    const subject =
      (cnAttr?.value as string | undefined) ||
      cert.subject.attributes.map((a: any) => a.value).filter(Boolean).join(', ') ||
      null;
    _envCertMeta = { subject, notAfter: cert.validity.notAfter?.toISOString() ?? null };
  } catch (e) {
    console.error('[lifecycle] env cert metadata read failed:', (e as any)?.message);
    _envCertMeta = null;
  }
  return _envCertMeta;
}

export const STATES: string[] = [
  'prerequisites_check',
  'solicitud_submitted',
  'fe_portal_access',
  'postulacion_submitted',
  'postulacion_validated',
  'simulacion_in_progress',
  'simulacion_passed',
  'urls_produccion_confirmed',
  'declaracion_jurada_sent',
  'certified',
  'production_setup',
  'first_production_aceptado',
  'live',
];

const ACTIVE_REGISTRY_STATUSES = new Set(['onboarding', 'active']);

// ---------------------------------------------------------------------------
// Shared result type — handlers spread error fields and forward statusCode.
// ---------------------------------------------------------------------------
export type OkResult = { ok: true; state: string; eventId: string };
export type ErrResult = {
  error: string;
  currentState?: string;
  expectedNext?: string | null;
  statusCode: number;
};
export type LifecycleResult = OkResult | ErrResult;

// ---------------------------------------------------------------------------
// POST /tenants — upsert
// ---------------------------------------------------------------------------
export async function upsertTenant(opts: {
  rnc: string;
  displayName?: string | null;
  channel?: string | null;
  status?: string | null;
}): Promise<Record<string, unknown>> {
  const db = getPool();
  const { rows } = await db.query(
    `INSERT INTO tenant_registry (rnc, display_name, channel, status)
     VALUES ($1, $2, COALESCE($3, 'crm'), COALESCE($4, 'onboarding'))
     ON CONFLICT (rnc) DO UPDATE SET
       display_name = COALESCE($2, tenant_registry.display_name),
       channel      = COALESCE($3, tenant_registry.channel),
       status       = COALESCE($4, tenant_registry.status),
       updated_at   = now()
     RETURNING rnc, display_name AS "displayName", channel, status,
               created_at AS "createdAt", updated_at AS "updatedAt"`,
    [opts.rnc, opts.displayName ?? null, opts.channel ?? null, opts.status ?? null]
  );
  return rows[0] as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// GET /tenants — registry list LEFT JOINed to cert state + cert metadata
// ---------------------------------------------------------------------------
export async function listTenants(): Promise<Record<string, unknown>[]> {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT r.rnc,
            r.display_name   AS "displayName",
            r.channel,
            r.status,
            c.state          AS "certState",
            c.updated_at     AS "certUpdatedAt",
            tc.subject       AS "certSubject",
            tc.not_after     AS "certNotAfter",
            tc.updated_at    AS "certFileUpdatedAt",
            CASE WHEN tc.rnc IS NOT NULL THEN 'db' ELSE NULL END AS "certSource"
     FROM tenant_registry r
     LEFT JOIN tenant_certifications c  ON c.rnc  = r.rnc
     LEFT JOIN tenant_certs          tc ON tc.rnc = r.rnc
     ORDER BY r.created_at DESC`
  );
  // For the anchor (no DB cert row), fill metadata from the env P12.
  return (rows as Record<string, unknown>[]).map(row => {
    if (row.rnc === ANCHOR_RNC && !row.certSource) {
      const envMeta = getEnvCertMeta();
      if (envMeta) {
        return {
          ...row,
          certSubject:       envMeta.subject,
          certNotAfter:      envMeta.notAfter,
          certFileUpdatedAt: null,
          certSource:        'env',
        };
      }
    }
    return row;
  });
}

// ---------------------------------------------------------------------------
// GET /certificaciones/:rnc — full record with events
// ---------------------------------------------------------------------------
export async function getTenantFull(rnc: string): Promise<{
  tenant: Record<string, unknown>;
  certification: Record<string, unknown> | null;
  events: Record<string, unknown>[];
} | null> {
  const db = getPool();
  const [tenantRes, certRes, eventRes] = await Promise.all([
    db.query(
      `SELECT rnc, display_name AS "displayName", channel, status,
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM tenant_registry WHERE rnc = $1`,
      [rnc]
    ),
    db.query(
      `SELECT rnc, state, required_types AS "requiredTypes",
              updated_by AS "updatedBy", updated_at AS "updatedAt"
       FROM tenant_certifications WHERE rnc = $1`,
      [rnc]
    ),
    db.query(
      `SELECT id, rnc, from_state AS "fromState", to_state AS "toState",
              actor, evidence, notes, created_at AS "createdAt"
       FROM tenant_lifecycle_events
       WHERE rnc = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [rnc]
    ),
  ]);
  if (!tenantRes.rows.length) return null;
  return {
    tenant:        tenantRes.rows[0]  as Record<string, unknown>,
    certification: (certRes.rows[0]   as Record<string, unknown>) ?? null,
    events:        eventRes.rows      as Record<string, unknown>[],
  };
}

// ---------------------------------------------------------------------------
// POST /certificaciones/:rnc/advance — state machine transition
// ---------------------------------------------------------------------------
export async function advanceCertification(
  rnc: string,
  opts: {
    toState: string;
    actor: string;
    evidence?: unknown;
    notes?: string;
    regress?: boolean;
  }
): Promise<LifecycleResult> {
  const { toState, actor, evidence, notes, regress } = opts;

  const toIdx = STATES.indexOf(toState);
  if (toIdx === -1) return { error: `unknown state "${toState}"`, statusCode: 400 };

  const db = getPool();

  const { rows: tenantRows } = await db.query<{ status: string }>(
    'SELECT status FROM tenant_registry WHERE rnc = $1',
    [rnc]
  );
  if (!tenantRows.length) return { error: 'tenant not found in registry', statusCode: 404 };
  if (!ACTIVE_REGISTRY_STATUSES.has(tenantRows[0].status)) {
    return {
      error: `registry status "${tenantRows[0].status}" does not permit certification transitions`,
      statusCode: 409,
    };
  }

  const { rows: certRows } = await db.query<{ state: string }>(
    'SELECT state FROM tenant_certifications WHERE rnc = $1',
    [rnc]
  );
  const currentState: string | null = certRows[0]?.state ?? null;
  const isInit = currentState === null;

  if (isInit) {
    if (toState !== 'prerequisites_check') {
      return {
        error: 'certification not initialized; first advance must target "prerequisites_check"',
        statusCode: 409,
      };
    }
  } else {
    const fromIdx = STATES.indexOf(currentState!);
    if (regress) {
      if (toIdx >= fromIdx) {
        return {
          error: 'regress:true but toState is not earlier than current state',
          currentState: currentState!,
          statusCode: 409,
        };
      }
      if (!notes?.trim()) {
        return { error: 'notes are required for a regression', statusCode: 400 };
      }
    } else {
      if (toIdx !== fromIdx + 1) {
        const expectedNext: string | undefined = STATES[fromIdx + 1];
        return {
          error: 'out-of-order transition; use regress:true to move backward or advance to the immediate next state',
          currentState: currentState!,
          expectedNext: expectedNext ?? null,
          statusCode: 409,
        };
      }
    }
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    if (isInit) {
      await client.query(
        `INSERT INTO tenant_certifications (rnc, state, updated_by)
         VALUES ($1, $2, $3)`,
        [rnc, toState, actor]
      );
    } else {
      await client.query(
        `UPDATE tenant_certifications
         SET state = $1, updated_by = $2, updated_at = now()
         WHERE rnc = $3`,
        [toState, actor, rnc]
      );
    }

    const { rows: evtRows } = await client.query<{ id: string }>(
      `INSERT INTO tenant_lifecycle_events (rnc, from_state, to_state, actor, evidence, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [rnc, currentState, toState, actor, evidence !== undefined ? evidence : null, notes ?? null]
    );

    await client.query('COMMIT');
    console.log(`[lifecycle] ${rnc}: ${currentState ?? '(init)'} → ${toState} (actor=${actor})`);
    return { ok: true, state: toState, eventId: String(evtRows[0].id) };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// POST /certificaciones/:rnc/genesis — backfill for pre-Phase-C tenants
// ---------------------------------------------------------------------------
export async function genesisCertification(
  rnc: string,
  opts: { state: string; actor: string; notes: string }
): Promise<LifecycleResult> {
  const { state, actor, notes } = opts;

  if (STATES.indexOf(state) === -1) return { error: `unknown state "${state}"`, statusCode: 400 };

  const db = getPool();

  const { rows: tenantRows } = await db.query(
    'SELECT rnc FROM tenant_registry WHERE rnc = $1',
    [rnc]
  );
  if (!tenantRows.length) return { error: 'tenant not found in registry', statusCode: 404 };

  const { rows: certRows } = await db.query(
    'SELECT rnc FROM tenant_certifications WHERE rnc = $1',
    [rnc]
  );
  if (certRows.length) {
    return {
      error: 'certification row already exists; genesis is only allowed for tenants with no prior certification row',
      statusCode: 409,
    };
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO tenant_certifications (rnc, state, updated_by)
       VALUES ($1, $2, $3)`,
      [rnc, state, actor]
    );

    const { rows: evtRows } = await client.query<{ id: string }>(
      `INSERT INTO tenant_lifecycle_events (rnc, from_state, to_state, actor, evidence, notes)
       VALUES ($1, NULL, $2, $3, NULL, $4)
       RETURNING id`,
      [rnc, state, actor, notes]
    );

    await client.query('COMMIT');
    console.log(`[lifecycle] ${rnc}: genesis → ${state} (actor=${actor})`);
    return { ok: true, state, eventId: String(evtRows[0].id) };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
