import { Router, Request, Response } from 'express';
import { getPool } from './db';
import { checkEncoding } from './inputGuard';
import { keyForRnc } from './certStore';
import { buildEcf } from './xmlBuilder';
import { buildRfce } from './rfceBuilder';
import { buildAcecf, AcecfCase } from './acecfBuilder';
import { signXml, extractSecurityCode } from './signer';
import {
  validateXml,
  schemaPathForEcf,
  schemaPathForRfce,
  schemaPathForAcecf,
} from './validator';
import {
  authenticate,
  sendEcf,
  sendRfce,
  sendAprobacion,
  consultaResultado,
} from './dgiiClient';
import {
  extractFechaFirma,
  buildEcfQrUrl,
  buildFcQrUrl,
  xmlTag,
} from './qrBuilder';
import { normalize } from './dataset';
import { KeyMaterial } from './signer';

const VALID_RNC_RE = /^\d{9}$|^\d{11}$/;
const VALID_KINDS = new Set(['ecf', 'rfce', 'acecf', 'paso4_plan']);
const ACTIVE_REGISTRY_STATUSES = new Set(['onboarding', 'active']);
const ANCHOR_RNC = '133470616';

// ── Paso-4 plan type + reKey (DB-sourced; no file I/O) ────────────────────────

interface Paso4Plan {
  orden: number | string;
  tipo: string;
  nuevo_encf: string;
  origen_paso2: string;
  fecha: string;
  rnc_comprador: string;
  monto_total: string;
  itbis: string;
  doc_class: string;
  qr: string;
  ncf_modificado_override?: string;
  fecha_ncf_modificado_override?: string;
  fecha_override?: string;
  indicador_nota_credito_override?: string;
}

function reKeyPaso4(origen: Record<string, unknown>, plan: Paso4Plan): Record<string, unknown> {
  const fecha = plan.fecha_override || plan.fecha;
  const out: Record<string, unknown> = { ...origen, ENCF: plan.nuevo_encf, FechaEmision: fecha };
  if (plan.ncf_modificado_override) out.NCFModificado = plan.ncf_modificado_override;
  if (plan.fecha_ncf_modificado_override) out.FechaNCFModificado = plan.fecha_ncf_modificado_override;
  if (plan.indicador_nota_credito_override !== undefined) out.IndicadorNotaCredito = plan.indicador_nota_credito_override;
  return out;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function has1209(body: unknown): boolean {
  const m = (body as any)?.mensajes ?? (body as any)?.Mensajes;
  return Array.isArray(m) && m.some((x: any) => String(x?.codigo ?? x?.Codigo) === '1209');
}

function byTipoCounts(cases: Record<string, unknown>[], kind: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of cases) {
    const key = kind === 'acecf'
      ? String((c as any).Estado ?? 'unknown')
      : kind === 'paso4_plan'
        ? String((c as any).tipo ?? 'unknown')
        : String((c as any).TipoeCF ?? (c as any).Tipo ?? 'unknown');
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

async function getTenantGuard(
  rnc: string,
  res: Response
): Promise<{ registryStatus: string; certState: string | null } | null> {
  const db = getPool();
  const { rows: regRows } = await db.query<{ status: string }>(
    'SELECT status FROM tenant_registry WHERE rnc = $1',
    [rnc]
  );
  if (!regRows.length) {
    res.status(404).json({ error: 'tenant not found' });
    return null;
  }
  const registryStatus = regRows[0].status;
  if (!ACTIVE_REGISTRY_STATUSES.has(registryStatus)) {
    res.status(409).json({ error: `registry status "${registryStatus}" does not permit this operation` });
    return null;
  }
  const { rows: certRows } = await db.query<{ state: string }>(
    'SELECT state FROM tenant_certifications WHERE rnc = $1',
    [rnc]
  );
  const certState = certRows[0]?.state ?? null;
  if (certState === 'live') {
    res.status(409).json({ error: 'tenant is live; test sets are frozen' });
    return null;
  }
  return { registryStatus, certState };
}

// ── POST /test-sets ───────────────────────────────────────────────────────────

async function handleUploadTestSet(req: Request, res: Response): Promise<void> {
  try {
    const { rnc, kind, cases, sourceNote, uploadedBy } = req.body;

    // 1. RNC format
    if (!rnc || !VALID_RNC_RE.test(String(rnc))) {
      res.status(400).json({ error: 'rnc must be 9 or 11 digits' });
      return;
    }
    // 2. Registry + cert state
    const guard = await getTenantGuard(String(rnc), res);
    if (!guard) return;

    // 3. kind + uploadedBy
    if (!kind || !VALID_KINDS.has(String(kind))) {
      res.status(400).json({ error: 'kind must be one of: ecf, rfce, acecf, paso4_plan' });
      return;
    }
    if (!uploadedBy || !String(uploadedBy).trim()) {
      res.status(400).json({ error: 'uploadedBy is required' });
      return;
    }

    // 4. cases array
    if (!Array.isArray(cases) || cases.length === 0) {
      res.status(400).json({ error: 'cases must be a non-empty array' });
      return;
    }
    if (cases.length > 200) {
      res.status(400).json({ error: 'cases array exceeds maximum of 200 entries' });
      return;
    }
    const offenders: string[] = [];
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      if (!c || typeof c !== 'object' || Array.isArray(c)) {
        res.status(400).json({ error: `cases[${i}] must be a flat object` });
        return;
      }
      for (const [k, v] of Object.entries(c)) {
        if (v !== null && typeof v === 'object') {
          res.status(400).json({ error: `cases[${i}].${k} must be string, number, or null — no nested objects or arrays` });
          return;
        }
      }
      const k = String(kind);
      if (k === 'ecf' || k === 'rfce') {
        if (!c.ENCF) offenders.push(`cases[${i}] missing ENCF`);
      } else if (k === 'acecf') {
        if (!c.eNCF) offenders.push(`cases[${i}] missing eNCF`);
      }
    }
    if (offenders.length > 0) {
      res.status(422).json({ error: 'cases missing required key', offenders });
      return;
    }

    // 5. encoding guard over every case + meta fields
    const encErr = checkEncoding({
      sourceNote: sourceNote != null ? String(sourceNote) : '',
      uploadedBy: String(uploadedBy),
    });
    if (encErr) { res.status(400).json(encErr); return; }
    for (let i = 0; i < cases.length; i++) {
      const caseErr = checkEncoding(
        Object.fromEntries(
          Object.entries(cases[i]).map(([k, v]) => [k, v == null ? '' : String(v)])
        )
      );
      if (caseErr) { res.status(400).json({ error: `cases[${i}]: ${caseErr.error}` }); return; }
    }

    // 6. paso4_plan-specific validation
    const kindStr = String(kind);
    if (kindStr === 'paso4_plan') {
      // Required fields: orden (coercible int), nuevo_encf, origen_paso2, tipo, doc_class
      const p4BadRows: number[] = [];
      for (let i = 0; i < cases.length; i++) {
        const c = cases[i] as any;
        const ok = c.orden != null && !isNaN(Number(c.orden))
          && c.nuevo_encf != null && String(c.nuevo_encf).trim() !== ''
          && c.origen_paso2 != null && String(c.origen_paso2).trim() !== ''
          && c.tipo != null && String(c.tipo).trim() !== ''
          && c.doc_class != null && String(c.doc_class).trim() !== '';
        if (!ok) p4BadRows.push(i);
      }
      if (p4BadRows.length > 0) {
        res.status(422).json({
          error: 'paso4_plan rows missing required fields (orden, nuevo_encf, origen_paso2, tipo, doc_class)',
          offending_rows: p4BadRows,
        });
        return;
      }
      // nuevo_encf must be unique within the plan
      const allNew = (cases as any[]).map((c: any) => String(c.nuevo_encf));
      if (new Set(allNew).size !== allNew.length) {
        const seen = new Set<string>();
        const dupes = allNew.filter(e => { if (seen.has(e)) return true; seen.add(e); return false; });
        res.status(422).json({ error: 'nuevo_encf must be unique within the plan', duplicates: [...new Set(dupes)] });
        return;
      }
      // Tenant must have an active ecf set; every origen_paso2 must be in it
      const db2 = getPool();
      const { rows: ecfSetRows } = await db2.query<{ cases: any[] }>(
        `SELECT cases FROM tenant_test_sets WHERE rnc = $1 AND kind = 'ecf' AND active`,
        [String(rnc)]
      );
      if (!ecfSetRows.length) {
        res.status(422).json({ error: 'missing required active test set: ecf' });
        return;
      }
      const ecfEncfs = new Set<string>((ecfSetRows[0].cases ?? []).map((c: any) => String(c.ENCF)));
      const orphans = (cases as any[]).map((c: any) => String(c.origen_paso2)).filter(e => !ecfEncfs.has(e));
      if (orphans.length > 0) {
        res.status(422).json({ error: 'origen_paso2 not found in active ecf set', orphans });
        return;
      }
      // For consumo rows: active rfce set required and origen_paso2 must be in it
      const consumoRows = (cases as any[]).filter((c: any) => /RFCE/i.test(String(c.doc_class ?? '')));
      if (consumoRows.length > 0) {
        const { rows: rfceSetRows } = await db2.query<{ cases: any[] }>(
          `SELECT cases FROM tenant_test_sets WHERE rnc = $1 AND kind = 'rfce' AND active`,
          [String(rnc)]
        );
        if (!rfceSetRows.length) {
          res.status(422).json({ error: 'missing required active test set: rfce (needed for consumo rows)' });
          return;
        }
        const rfceEncfs = new Set<string>((rfceSetRows[0].cases ?? []).map((c: any) => String(c.ENCF)));
        const consumoOrphans = consumoRows.map((c: any) => String(c.origen_paso2)).filter(e => !rfceEncfs.has(e));
        if (consumoOrphans.length > 0) {
          res.status(422).json({ error: 'consumo origen_paso2 not found in active rfce set', consumo_orphans: consumoOrphans });
          return;
        }
      }
    }

    // 7. rfce orphan check
    if (kindStr === 'rfce') {
      const db = getPool();
      const { rows: ecfSetRows } = await db.query<{ cases: any[] }>(
        `SELECT cases FROM tenant_test_sets WHERE rnc = $1 AND kind = 'ecf' AND active`,
        [String(rnc)]
      );
      const ecfEncfs = new Set<string>(
        (ecfSetRows[0]?.cases ?? []).map((c: any) => String(c.ENCF))
      );
      const orphans = (cases as any[])
        .map((c: any) => String(c.ENCF))
        .filter((e: string) => !ecfEncfs.has(e));
      if (orphans.length > 0) {
        res.status(422).json({ error: 'rfce cases without matching ecf case', orphans });
        return;
      }
    }

    // 7. Transaction: deactivate old, insert new
    const db = getPool();
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE tenant_test_sets SET active = FALSE WHERE rnc = $1 AND kind = $2 AND active`,
        [String(rnc), kindStr]
      );
      const { rows: ins } = await client.query<{ id: string }>(
        `INSERT INTO tenant_test_sets (rnc, kind, cases, case_count, source_note, uploaded_by)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6) RETURNING id`,
        [
          String(rnc), kindStr, JSON.stringify(cases), cases.length,
          sourceNote != null ? String(sourceNote) : null, String(uploadedBy),
        ]
      );
      await client.query('COMMIT');
      res.json({
        ok: true,
        id: ins[0].id,
        caseCount: cases.length,
        byTipo: byTipoCounts(cases as any[], kindStr),
      });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}

// ── GET /test-sets/:rnc ───────────────────────────────────────────────────────

async function handleGetTestSets(req: Request, res: Response): Promise<void> {
  try {
    const rnc = req.params.rnc;
    const db = getPool();

    const { rows: regRows } = await db.query(
      'SELECT rnc FROM tenant_registry WHERE rnc = $1', [rnc]
    );
    if (!regRows.length) { res.status(404).json({ error: 'tenant not found' }); return; }

    const wantFull = req.query.full === '1';
    const kindFilter = req.query.kind ? String(req.query.kind) : null;

    const { rows } = await db.query<{
      id: string; kind: string; case_count: number; cases: any[];
      created_at: string; uploaded_by: string; source_note: string | null;
    }>(
      `SELECT id, kind, case_count, cases, created_at, uploaded_by, source_note
       FROM tenant_test_sets WHERE rnc = $1 AND active ORDER BY kind`,
      [rnc]
    );

    const out = rows.map(r => {
      const base: Record<string, unknown> = {
        kind: r.kind,
        caseCount: r.case_count,
        byTipo: byTipoCounts(r.cases, r.kind),
        createdAt: r.created_at,
        uploadedBy: r.uploaded_by,
        sourceNote: r.source_note,
      };
      if (wantFull && (!kindFilter || kindFilter === r.kind)) {
        base.cases = r.cases;
      }
      return base;
    });
    res.json(out);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}

// ── POST /test-runs ───────────────────────────────────────────────────────────

const PROD_SPELLINGS = new Set(['ecf', 'prod', 'produccion', 'production']);

async function handleStartRun(req: Request, res: Response): Promise<void> {
  try {
    const { rnc, scope, environment, dryRun, skipEncfs, actor } = req.body;

    // 1. environment guard — certecf ONLY
    const envRaw = typeof environment === 'string' ? environment.trim().toLowerCase() : '';
    if (!envRaw || envRaw !== 'certecf') {
      const refused = envRaw || '(missing)';
      res.status(400).json({
        error: `test runs accept only environment "certecf"; refused: ${refused}`,
      });
      return;
    }

    // 2. other field validation
    const VALID_SCOPES = new Set(['set_pruebas', 'acecf', 'simulacion']);
    if (!scope || !VALID_SCOPES.has(String(scope))) {
      res.status(400).json({ error: 'scope must be one of: set_pruebas, acecf, simulacion' });
      return;
    }
    if (!actor || !String(actor).trim()) {
      res.status(400).json({ error: 'actor is required' });
      return;
    }
    if (skipEncfs !== undefined && !Array.isArray(skipEncfs)) {
      res.status(400).json({ error: 'skipEncfs must be an array of strings' });
      return;
    }
    const encErr = checkEncoding({ actor: String(actor) });
    if (encErr) { res.status(400).json(encErr); return; }

    // 3. registry + cert-state guard (reuse getTenantGuard but without live check)
    if (!rnc || !VALID_RNC_RE.test(String(rnc))) {
      res.status(400).json({ error: 'rnc must be 9 or 11 digits' });
      return;
    }
    const db = getPool();
    const { rows: regRows } = await db.query<{ status: string }>(
      'SELECT status FROM tenant_registry WHERE rnc = $1', [String(rnc)]
    );
    if (!regRows.length) { res.status(404).json({ error: 'tenant not found' }); return; }
    if (!ACTIVE_REGISTRY_STATUSES.has(regRows[0].status)) {
      res.status(409).json({ error: `registry status "${regRows[0].status}" does not permit test runs` });
      return;
    }
    const { rows: certRows } = await db.query<{ state: string }>(
      'SELECT state FROM tenant_certifications WHERE rnc = $1', [String(rnc)]
    );
    const certState = certRows[0]?.state ?? null;
    if (certState === 'live') {
      res.status(409).json({ error: 'tenant is live; test runs are frozen' });
      return;
    }

    // 4. cert guard — non-anchor RNC must have a tenant_certs row (direct query, no keyForRnc)
    if (String(rnc) !== ANCHOR_RNC) {
      const { rows: certKeyRows } = await db.query(
        'SELECT rnc FROM tenant_certs WHERE rnc = $1', [String(rnc)]
      );
      if (!certKeyRows.length) {
        res.status(412).json({ error: 'tenant_cert_required' });
        return;
      }
    }

    // 5. required active sets
    const scopeStr = String(scope);
    const { rows: setRows } = await db.query<{ kind: string }>(
      `SELECT kind FROM tenant_test_sets WHERE rnc = $1 AND active`, [String(rnc)]
    );
    const presentKinds = new Set(setRows.map(r => r.kind));
    if (scopeStr === 'set_pruebas' && !presentKinds.has('ecf')) {
      res.status(422).json({ error: 'missing required active test set: ecf' });
      return;
    }
    if (scopeStr === 'acecf' && !presentKinds.has('acecf')) {
      res.status(422).json({ error: 'missing required active test set: acecf' });
      return;
    }
    if (scopeStr === 'simulacion') {
      if (!presentKinds.has('paso4_plan')) {
        res.status(422).json({ error: 'missing required active test set: paso4_plan' });
        return;
      }
      if (!presentKinds.has('ecf')) {
        res.status(422).json({ error: 'missing required active test set: ecf' });
        return;
      }
      // rfce required only if any plan row is consumo
      const { rows: planPeek } = await db.query<{ cases: any[] }>(
        `SELECT cases FROM tenant_test_sets WHERE rnc = $1 AND kind = 'paso4_plan' AND active`,
        [String(rnc)]
      );
      const planPeekRows: any[] = planPeek[0]?.cases ?? [];
      if (planPeekRows.some((r: any) => /RFCE/i.test(String(r.doc_class ?? ''))) && !presentKinds.has('rfce')) {
        res.status(422).json({ error: 'missing required active test set: rfce (needed for consumo rows)' });
        return;
      }
    }

    // 6. concurrency guard
    const { rows: runningRows } = await db.query<{ id: string }>(
      `SELECT id FROM test_runs WHERE rnc = $1 AND status = 'running'`, [String(rnc)]
    );
    if (runningRows.length > 0) {
      res.status(409).json({ error: 'run already in progress', activeRunId: runningRows[0].id });
      return;
    }

    // Create run + materialize cases
    const skipSet = new Set<string>((skipEncfs ?? []).map(String));

    // Load active sets needed for this scope
    const kindsNeeded = scopeStr === 'set_pruebas'
      ? ['ecf', 'rfce']
      : scopeStr === 'simulacion'
        ? ['paso4_plan', 'ecf', 'rfce']
        : ['acecf'];
    const { rows: loadedSets } = await db.query<{ kind: string; cases: any[] }>(
      `SELECT kind, cases FROM tenant_test_sets WHERE rnc = $1 AND active AND kind = ANY($2::text[])`,
      [String(rnc), kindsNeeded]
    );
    const setsByKind: Record<string, any[]> = {};
    for (const s of loadedSets) setsByKind[s.kind] = s.cases;

    // Build ordered case list
    type CaseRow = {
      encf: string; tipo: string | null; kind: string;
      status: string; caseData: Record<string, unknown>;
    };
    let orderedCases: CaseRow[] = [];

    if (scopeStr === 'set_pruebas') {
      const ecfCases: any[] = setsByKind['ecf'] ?? [];
      const rfceEncfs = new Set<string>(
        (setsByKind['rfce'] ?? []).map((c: any) => String(c.ENCF))
      );
      // Dependency order: notas (tipo 33/34) after their referenced ECF
      const sorted = dependencyOrder(ecfCases);
      // (1) non-nota e-CF — exclude RFCE members (they materialize only as kind='rfce' in loop 2)
      for (const c of sorted) {
        const tipo = String(c.TipoeCF ?? c.Tipo ?? '');
        if (tipo !== '33' && tipo !== '34' && !rfceEncfs.has(String(c.ENCF))) {
          orderedCases.push({
            encf: String(c.ENCF), tipo, kind: 'ecf',
            status: skipSet.has(String(c.ENCF)) ? 'skipped' : 'pending',
            caseData: c,
          });
        }
      }
      // (2) RFCE consumo — membership driven by tenant's active rfce set
      for (const c of sorted) {
        const tipo = String(c.TipoeCF ?? c.Tipo ?? '');
        if (tipo !== '33' && tipo !== '34' && rfceEncfs.has(String(c.ENCF))) {
          orderedCases.push({
            encf: String(c.ENCF), tipo: '32', kind: 'rfce',
            status: skipSet.has(String(c.ENCF) + ':rfce') ? 'skipped' : 'pending',
            caseData: c,
          });
        }
      }
      // (3) notas last
      for (const c of sorted) {
        const tipo = String(c.TipoeCF ?? c.Tipo ?? '');
        if (tipo === '33' || tipo === '34') {
          orderedCases.push({
            encf: String(c.ENCF), tipo, kind: 'ecf',
            status: skipSet.has(String(c.ENCF)) ? 'skipped' : 'pending',
            caseData: c,
          });
        }
      }
    } else if (scopeStr === 'simulacion') {
      // Materialize from paso4_plan rows; sort by orden ASC
      const planRows = (setsByKind['paso4_plan'] ?? []).slice().sort(
        (a: any, b: any) => Number(a.orden) - Number(b.orden)
      );
      const ecfByEncf = new Map<string, any>(
        (setsByKind['ecf'] ?? []).map((c: any) => [String(c.ENCF), c])
      );
      const rfceByEncf = new Map<string, any>(
        (setsByKind['rfce'] ?? []).map((c: any) => [String(c.ENCF), c])
      );
      for (const row of planRows) {
        const isConsumo = /RFCE/i.test(String(row.doc_class ?? ''));
        const origenEcf = ecfByEncf.get(String(row.origen_paso2));
        if (!origenEcf) continue; // guaranteed present by upload validation
        const reKeyed = reKeyPaso4(origenEcf, row as Paso4Plan);
        orderedCases.push({
          encf: String(row.nuevo_encf),
          tipo: String(row.tipo),
          kind: 'ecf',
          status: skipSet.has(String(row.nuevo_encf)) ? 'skipped' : 'pending',
          caseData: reKeyed,
        });
        if (isConsumo) {
          const origenRfce = rfceByEncf.get(String(row.origen_paso2));
          if (!origenRfce) continue; // guaranteed present by upload validation
          const reKeyedRfce = reKeyPaso4(origenRfce, row as Paso4Plan);
          orderedCases.push({
            encf: String(row.nuevo_encf),
            tipo: String(row.tipo),
            kind: 'rfce',
            status: skipSet.has(String(row.nuevo_encf)) ? 'skipped' : 'pending',
            caseData: reKeyedRfce,
          });
        }
      }
    } else {
      // acecf
      for (const c of (setsByKind['acecf'] ?? [])) {
        orderedCases.push({
          encf: String(c.eNCF), tipo: null, kind: 'acecf',
          status: skipSet.has(String(c.eNCF)) ? 'skipped' : 'pending',
          caseData: c,
        });
      }
    }

    // Persist run + cases in a transaction
    const client = await db.connect();
    let runId: string;
    try {
      await client.query('BEGIN');
      const { rows: runRows } = await client.query<{ id: string }>(
        `INSERT INTO test_runs
           (rnc, scope, environment, dry_run, actor, status, params, started_at)
         VALUES ($1, $2, $3, $4, $5, 'running', $6, now())
         RETURNING id`,
        [
          String(rnc), scopeStr, 'certecf', dryRun === true,
          String(actor), JSON.stringify({ skipEncfs: [...skipSet] }),
        ]
      );
      runId = runRows[0].id;

      for (let i = 0; i < orderedCases.length; i++) {
        const c = orderedCases[i];
        await client.query(
          `INSERT INTO test_run_cases
             (run_id, position, encf, tipo, kind, status, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())`,
          [runId, i + 1, c.encf, c.tipo, c.kind, c.status]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    res.status(202).json({ runId });

    // Fire executor asynchronously — must never crash the process
    setImmediate(() => {
      runExecutor(
        runId, String(rnc), scopeStr, dryRun === true, orderedCases
      ).catch((e) => {
        console.error(`[orchestrator] executor unhandled error run=${runId}:`, e?.message ?? e);
        getPool()
          .query(
            `UPDATE test_runs SET status='failed', finished_at=now(),
               totals=$1 WHERE id=$2`,
            [JSON.stringify({ error: String(e?.message ?? e) }), runId]
          )
          .catch(() => {});
      });
    });
  } catch (e: any) {
    if (e.code === '23505') {
      res.status(409).json({ error: 'run already in progress (concurrent)' });
    } else {
      res.status(500).json({ error: e.message });
    }
  }
}

// ── Executor ─────────────────────────────────────────────────────────────────

type ExecCase = {
  encf: string; tipo: string | null; kind: string;
  status: string; caseData: Record<string, unknown>;
};

async function updateCase(
  runId: string, position: number, fields: Record<string, unknown>
): Promise<void> {
  const db = getPool();
  const sets: string[] = ['updated_at = now()'];
  const vals: unknown[] = [];
  let idx = 1;
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = $${idx}`);
    vals.push(v);
    idx++;
  }
  vals.push(runId, position);
  await db.query(
    `UPDATE test_run_cases SET ${sets.join(', ')} WHERE run_id = $${idx} AND position = $${idx + 1}`,
    vals
  );
}

async function runExecutor(
  runId: string,
  rnc: string,
  scope: string,
  dryRun: boolean,
  cases: ExecCase[]
): Promise<void> {
  const db = getPool();

  // Resolve signing key
  const key = await keyForRnc(rnc) as KeyMaterial;

  // ── PREPARE PHASE ──
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const pos = i + 1;

    if (c.status === 'skipped') continue;

    await updateCase(runId, pos, { status: 'preparing' });

    try {
      if (c.kind === 'ecf') {
        const data = normalize(c.caseData as any);
        const tipo = c.tipo ?? String(data.TipoeCF ?? '');
        const unsigned = buildEcf(data, tipo);
        const signed = signXml(unsigned, key);
        const vr = validateXml(signed, schemaPathForEcf(tipo), c.encf);
        const codigoSeguridad = extractSecurityCode(signed);
        const fechaFirma = extractFechaFirma(signed);
        const qrUrl = buildEcfQrUrl({
          environment: 'certecf',
          rncEmisor: String(data.RNCEmisor ?? rnc),
          rncComprador: data.RNCComprador || undefined,
          encf: c.encf,
          fechaEmision: xmlTag(signed, 'FechaEmision'),
          montoTotal: xmlTag(signed, 'MontoTotal'),
          fechaFirma,
          codigoSeguridad,
        });
        if (!vr.valid) {
          c.status = 'error';
          await updateCase(runId, pos, {
            status: 'error', error: vr.errors.join('; '),
            signed_xml: signed, codigo_seguridad: codigoSeguridad,
            fecha_firma: fechaFirma, qr_url: qrUrl,
          });
        } else {
          c.status = dryRun ? 'skipped' : 'pending';
          await updateCase(runId, pos, {
            status: dryRun ? 'skipped' : 'pending',
            signed_xml: signed, codigo_seguridad: codigoSeguridad,
            fecha_firma: fechaFirma, qr_url: qrUrl,
            mensajes: dryRun ? { dryRun: true, xsd: 'valid' } : null,
          });
          cases[i] = { ...c, status: c.status };
        }

      } else if (c.kind === 'rfce') {
        // Two-step: sign full tipo-32, derive code, build+sign RFCE
        const data = normalize(c.caseData as any);
        const fullSigned = signXml(buildEcf(data, '32'), key);
        const codigoSeguridad = extractSecurityCode(fullSigned);
        const rfceUnsigned = buildRfce(data, codigoSeguridad);
        const rfceSigned = signXml(rfceUnsigned, key);
        const vrFull = validateXml(fullSigned, schemaPathForEcf('32'), c.encf);
        const vrRfce = validateXml(rfceSigned, schemaPathForRfce(), c.encf);
        const qrUrl = buildFcQrUrl({
          environment: 'certecf',
          rncEmisor: String(data.RNCEmisor ?? rnc),
          encf: c.encf,
          montoTotal: xmlTag(fullSigned, 'MontoTotal'),
          codigoSeguridad,
        });
        const errors = [...vrFull.errors, ...vrRfce.errors];
        if (errors.length > 0) {
          c.status = 'error';
          await updateCase(runId, pos, {
            status: 'error', error: errors.join('; '),
            full_invoice_xml: fullSigned, signed_xml: rfceSigned,
            codigo_seguridad: codigoSeguridad, qr_url: qrUrl,
          });
        } else {
          c.status = dryRun ? 'skipped' : 'pending';
          await updateCase(runId, pos, {
            status: dryRun ? 'skipped' : 'pending',
            full_invoice_xml: fullSigned, signed_xml: rfceSigned,
            codigo_seguridad: codigoSeguridad, qr_url: qrUrl,
            mensajes: dryRun ? { dryRun: true, xsd: 'valid' } : null,
          });
          cases[i] = { ...c, status: c.status };
        }

      } else if (c.kind === 'acecf') {
        const acecfCase = c.caseData as unknown as AcecfCase;
        const signed = signXml(buildAcecf(acecfCase), key);
        const vr = validateXml(signed, schemaPathForAcecf(), c.encf);
        if (!vr.valid) {
          c.status = 'error';
          await updateCase(runId, pos, {
            status: 'error', error: vr.errors.join('; '), signed_xml: signed,
          });
        } else {
          c.status = dryRun ? 'skipped' : 'pending';
          await updateCase(runId, pos, {
            status: dryRun ? 'skipped' : 'pending',
            signed_xml: signed,
            mensajes: dryRun ? { dryRun: true, xsd: 'valid' } : null,
          });
          cases[i] = { ...c, status: c.status };
        }
      }
    } catch (e: any) {
      c.status = 'error';
      await updateCase(runId, pos, { status: 'error', error: String(e?.message ?? e) });
      cases[i] = { ...c };
    }
  }

  // Dry run ends here
  if (dryRun) {
    const hasErrors = cases.some(c => c.status === 'error');
    const totals = tallyCases(cases);
    await db.query(
      `UPDATE test_runs SET status=$1, finished_at=now(), totals=$2 WHERE id=$3`,
      [hasErrors ? 'completed_with_errors' : 'completed', JSON.stringify(totals), runId]
    );
    return;
  }

  // Abort if any XSD failure before first send
  if (cases.some(c => c.status === 'error')) {
    const totals = tallyCases(cases);
    await db.query(
      `UPDATE test_runs SET status='failed', finished_at=now(), totals=$1 WHERE id=$2`,
      [JSON.stringify({ ...totals, abortReason: 'xsd_failure_before_send' }), runId]
    );
    return;
  }

  // ── SEND PHASE ──
  const token = await authenticate(key, 'certecf');
  const acceptedEncfs = new Set<string>();

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const pos = i + 1;

    // Check for cancellation
    const { rows: cancelRows } = await db.query<{ cancel_requested: boolean }>(
      'SELECT cancel_requested FROM test_runs WHERE id = $1', [runId]
    );
    if (cancelRows[0]?.cancel_requested) {
      // Mark remaining pending/preparing as cancelled
      for (let j = i; j < cases.length; j++) {
        if (cases[j].status === 'pending' || cases[j].status === 'preparing') {
          cases[j].status = 'cancelled';
          await updateCase(runId, j + 1, { status: 'cancelled' });
        }
      }
      break;
    }

    if (c.status !== 'pending') continue;

    try {
      if (c.kind === 'ecf') {
        // 614 guard: nota referencing unaccepted ECF
        const ncfMod = String((c.caseData as any).NCFModificado ?? '');
        if ((c.tipo === '33' || c.tipo === '34') && ncfMod && !acceptedEncfs.has(ncfMod)) {
          c.status = 'skipped';
          await updateCase(runId, pos, {
            status: 'skipped',
            error: `skipped: NCFModificado ${ncfMod} not yet accepted (614 guard)`,
          });
          cases[i] = { ...c };
          continue;
        }

        const { rows: caseDbRow } = await db.query<{ signed_xml: string }>(
          'SELECT signed_xml FROM test_run_cases WHERE run_id=$1 AND position=$2',
          [runId, pos]
        );
        const signedXml = caseDbRow[0]?.signed_xml ?? '';
        await updateCase(runId, pos, { status: 'sent' });

        const result = await sendEcf(signedXml, c.encf, key, 'certecf');
        let mensajes: unknown = null;
        try { mensajes = JSON.parse(result.body); } catch { mensajes = result.body; }

        if (has1209(mensajes)) {
          c.status = 'already_accepted';
          acceptedEncfs.add(c.encf);
          await updateCase(runId, pos, { status: 'already_accepted', mensajes });
        } else {
          const parsedBody: any = typeof mensajes === 'object' ? mensajes : {};
          const trackId = parsedBody?.trackId ?? parsedBody?.TrackId ?? parsedBody?.id ?? '';
          if (trackId) {
            await updateCase(runId, pos, { track_id: String(trackId) });
            const verdict = await pollVerdict(String(trackId), token, 'certecf');
            c.status = verdict.status as any;
            if (verdict.status === 'aceptado') acceptedEncfs.add(c.encf);
            await updateCase(runId, pos, { status: verdict.status, mensajes: verdict.mensajes });
          } else {
            const estado = String(parsedBody?.estado ?? parsedBody?.Estado ?? '').trim().toLowerCase();
            if (estado.startsWith('aceptado')) {
              c.status = 'aceptado';
              acceptedEncfs.add(c.encf);
              await updateCase(runId, pos, { status: 'aceptado', mensajes });
            } else if (estado === 'rechazado') {
              c.status = 'rechazado';
              await updateCase(runId, pos, { status: 'rechazado', mensajes });
            } else {
              c.status = 'error';
              await updateCase(runId, pos, { status: 'error', mensajes });
            }
          }
        }
        cases[i] = { ...c };

      } else if (c.kind === 'rfce') {
        const { rows: caseDbRow } = await db.query<{ signed_xml: string }>(
          'SELECT signed_xml FROM test_run_cases WHERE run_id=$1 AND position=$2',
          [runId, pos]
        );
        const signedXml = caseDbRow[0]?.signed_xml ?? '';
        await updateCase(runId, pos, { status: 'sent' });

        const result = await sendRfce(signedXml, c.encf, key, 'certecf');
        let mensajes: unknown = null;
        try { mensajes = JSON.parse(result.body); } catch { mensajes = result.body; }

        if (has1209(mensajes)) {
          c.status = 'already_accepted';
          acceptedEncfs.add(c.encf);
        } else {
          const parsedRfce: any = typeof mensajes === 'object' ? mensajes : {};
          const estadoRfce = String(parsedRfce?.estado ?? parsedRfce?.Estado ?? '').trim().toLowerCase();
          if (estadoRfce.startsWith('aceptado')) {
            c.status = 'aceptado';
            acceptedEncfs.add(c.encf);
          } else if (estadoRfce === 'rechazado') {
            c.status = 'rechazado';
          } else {
            c.status = 'error';
          }
        }
        await updateCase(runId, pos, { status: c.status, mensajes });
        cases[i] = { ...c };

      } else if (c.kind === 'acecf') {
        const { rows: caseDbRow } = await db.query<{ signed_xml: string }>(
          'SELECT signed_xml FROM test_run_cases WHERE run_id=$1 AND position=$2',
          [runId, pos]
        );
        const signedXml = caseDbRow[0]?.signed_xml ?? '';
        await updateCase(runId, pos, { status: 'sent' });

        const result = await sendAprobacion(signedXml, c.encf, key, 'certecf');
        let mensajes: unknown = null;
        try { mensajes = JSON.parse(result.body); } catch { mensajes = result.body; }

        const parsedAcecf: any = typeof mensajes === 'object' ? mensajes : {};
        const estadoAcecf = String(parsedAcecf?.estado ?? parsedAcecf?.Estado ?? '').trim().toLowerCase();
        if (estadoAcecf.startsWith('aceptado')) {
          c.status = 'aceptado';
        } else if (estadoAcecf === 'rechazado') {
          c.status = 'rechazado';
        } else {
          c.status = 'error';
        }
        await updateCase(runId, pos, { status: c.status, mensajes });
        cases[i] = { ...c };
      }
    } catch (e: any) {
      c.status = 'error';
      await updateCase(runId, pos, { status: 'error', error: String(e?.message ?? e) });
      cases[i] = { ...c };
    }
  }

  // Finalize run
  const totals = tallyCases(cases);
  const hasBad = (totals.rechazado ?? 0) + (totals.error ?? 0) > 0;
  const wasCancelled = cases.some(c => c.status === 'cancelled');
  const finalStatus = wasCancelled ? 'cancelled' : hasBad ? 'completed_with_errors' : 'completed';
  await db.query(
    `UPDATE test_runs SET status=$1, finished_at=now(), totals=$2 WHERE id=$3`,
    [finalStatus, JSON.stringify(totals), runId]
  );
}

async function pollVerdict(
  trackId: string, token: string, environment: string
): Promise<{ status: string; mensajes: unknown }> {
  for (let attempt = 0; attempt < 14; attempt++) {
    await sleep(2500);
    const result = await consultaResultado(trackId, token, environment);
    let body: any;
    try { body = JSON.parse(result.body); } catch { body = result.body; }
    const estado = String(body?.estado ?? body?.Estado ?? '').toLowerCase();
    if (!estado || estado === 'en proceso' || estado === 'en_proceso') continue;
    if (estado.startsWith('aceptado')) return { status: 'aceptado', mensajes: body };
    if (estado === 'rechazado') return { status: 'rechazado', mensajes: body };
    if (has1209(body)) return { status: 'already_accepted', mensajes: body };
    return { status: 'error', mensajes: body };
  }
  return { status: 'error', mensajes: { error: 'no verdict after 14 polls' } };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function tallyCases(cases: ExecCase[]): Record<string, number> {
  const t: Record<string, number> = {
    aceptado: 0, alreadyAccepted: 0, rechazado: 0, skipped: 0, error: 0, cancelled: 0,
  };
  for (const c of cases) {
    if (c.status === 'aceptado') t.aceptado++;
    else if (c.status === 'already_accepted') t.alreadyAccepted++;
    else if (c.status === 'rechazado') t.rechazado++;
    else if (c.status === 'skipped') t.skipped++;
    else if (c.status === 'error') t.error++;
    else if (c.status === 'cancelled') t.cancelled++;
  }
  return t;
}

/** Sort cases so notas (tipo 33/34) whose NCFModificado references another case come after it. */
function dependencyOrder(cases: any[]): any[] {
  const encfSet = new Set<string>(cases.map((c: any) => String(c.ENCF)));
  const notas: any[] = [];
  const others: any[] = [];
  for (const c of cases) {
    const tipo = String(c.TipoeCF ?? c.Tipo ?? '');
    const ncfMod = String(c.NCFModificado ?? '');
    if ((tipo === '33' || tipo === '34') && ncfMod && encfSet.has(ncfMod)) {
      notas.push(c);
    } else {
      others.push(c);
    }
  }
  return [...others, ...notas];
}

// ── GET /test-runs/:id ────────────────────────────────────────────────────────

async function handleGetRun(req: Request, res: Response): Promise<void> {
  try {
    const db = getPool();
    const { rows: runRows } = await db.query(
      `SELECT id, rnc, scope, environment, dry_run AS "dryRun", actor, status,
              cancel_requested AS "cancelRequested", params, totals,
              created_at AS "createdAt", started_at AS "startedAt", finished_at AS "finishedAt"
       FROM test_runs WHERE id = $1`,
      [req.params.id]
    );
    if (!runRows.length) { res.status(404).json({ error: 'run not found' }); return; }

    const { rows: caseRows } = await db.query(
      `SELECT run_id AS "runId", position, encf, tipo, kind, status,
              track_id AS "trackId", mensajes, codigo_seguridad AS "codigoSeguridad",
              fecha_firma AS "fechaFirma", qr_url AS "qrUrl", error,
              updated_at AS "updatedAt"
       FROM test_run_cases WHERE run_id = $1 ORDER BY position`,
      [req.params.id]
    );
    res.json({ run: runRows[0], cases: caseRows });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}

// ── GET /test-runs ────────────────────────────────────────────────────────────

async function handleListRuns(req: Request, res: Response): Promise<void> {
  try {
    const rnc = req.query.rnc ? String(req.query.rnc) : null;
    const limit = Math.min(parseInt(String(req.query.limit ?? '10'), 10) || 10, 50);
    const db = getPool();
    const { rows } = await db.query(
      `SELECT id, rnc, scope, environment, dry_run AS "dryRun", actor, status,
              totals, created_at AS "createdAt", finished_at AS "finishedAt"
       FROM test_runs
       WHERE ($1::text IS NULL OR rnc = $1)
       ORDER BY created_at DESC LIMIT $2`,
      [rnc, limit]
    );
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}

// ── POST /test-runs/:id/cancel ────────────────────────────────────────────────

async function handleCancelRun(req: Request, res: Response): Promise<void> {
  try {
    const db = getPool();
    const { rows } = await db.query<{ status: string }>(
      'SELECT status FROM test_runs WHERE id = $1', [req.params.id]
    );
    if (!rows.length) { res.status(404).json({ error: 'run not found' }); return; }
    if (rows[0].status !== 'running') {
      res.status(409).json({ error: 'run is not running', currentStatus: rows[0].status });
      return;
    }
    await db.query(
      'UPDATE test_runs SET cancel_requested = TRUE WHERE id = $1', [req.params.id]
    );
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}

// ── GET /test-runs/:id/cases/:position/xml ────────────────────────────────────

async function handleGetCaseXml(req: Request, res: Response): Promise<void> {
  try {
    const { which } = req.query;
    if (which !== 'signed' && which !== 'full') {
      res.status(400).json({ error: 'which must be "signed" or "full"' });
      return;
    }
    const col = which === 'full' ? 'full_invoice_xml' : 'signed_xml';
    const db = getPool();
    const { rows } = await db.query<{ xml: string | null }>(
      `SELECT ${col} AS xml FROM test_run_cases WHERE run_id = $1 AND position = $2`,
      [req.params.id, req.params.position]
    );
    if (!rows.length || rows[0].xml == null) {
      res.status(404).json({ error: 'xml not found for this case/position' });
      return;
    }
    res.type('application/xml; charset=utf-8').send(rows[0].xml);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}

// ── Router export ─────────────────────────────────────────────────────────────

export function buildOrchestratorRouter(): Router {
  const r = Router();
  r.post('/test-sets', handleUploadTestSet);
  r.get('/test-sets/:rnc', handleGetTestSets);
  r.post('/test-runs', handleStartRun);
  r.get('/test-runs', handleListRuns);
  r.get('/test-runs/:id', handleGetRun);
  r.post('/test-runs/:id/cancel', handleCancelRun);
  r.get('/test-runs/:id/cases/:position/xml', handleGetCaseXml);
  return r;
}
