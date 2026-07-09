import { Router, Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import cron from 'node-cron';
import {
  PadronTarget,
  buildTargets,
  getTargetPool,
  downloadZip,
  extractTxt,
  decodeTxt,
  parseRows,
  verifyTargetSchema,
  syncTarget,
} from './padronSync';
import { Pool } from 'pg';

export const padronRouter = Router();

// ---------------------------------------------------------------------------
// Auth — separate key from emisorAuth; rotate independently.
// ---------------------------------------------------------------------------
const PADRON_API_KEY = process.env.PADRON_API_KEY || '';

function padronAuth(req: Request, res: Response, next: NextFunction) {
  if (!PADRON_API_KEY) return next();
  const header = String(req.headers['authorization'] || '');
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  const provided = String(req.headers['x-padron-key'] || '') || bearer;
  if (provided && timingSafeEqualStr(provided, PADRON_API_KEY)) return next();
  return res.status(401).json({ error: 'unauthorized: missing or invalid padrón key' });
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// Pre-flight: insert run row + schema check for a single target.
// Returns { pool, runId } on success, or writes an error response and returns null.
// ---------------------------------------------------------------------------
async function prepareTarget(
  target: PadronTarget,
  res: Response
): Promise<{ pool: Pool; runId: string } | null> {
  const pool = getTargetPool(target.dbUrl);

  const schemaErr = await verifyTargetSchema(pool, target);
  if (schemaErr) {
    await pool
      .query(
        `INSERT INTO ${target.runsTable} (status, error, started_at)
         VALUES ('error', $1, now())`,
        [`schema verification failed: ${schemaErr}`]
      )
      .catch(() => {});
    return null;
  }

  // Stale-hygiene: mark any run that has been "running" for > 30 min as error.
  await pool
    .query(
      `UPDATE ${target.runsTable}
       SET status = 'error', error = 'run abandoned (> 30 min)', finished_at = now()
       WHERE status = 'running' AND started_at < now() - interval '30 minutes'`
    )
    .catch(() => {});

  // Concurrency guard: refuse if another run is active.
  const { rows: active } = await pool.query(
    `SELECT 1 FROM ${target.runsTable} WHERE status = 'running' LIMIT 1`
  );
  if (active.length > 0) return null; // caller skips this target silently

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO ${target.runsTable} (status, started_at) VALUES ('running', now()) RETURNING id`
  );
  return { pool, runId: rows[0].id };
}

// ---------------------------------------------------------------------------
// Main job — download once, fan out to each target.
// ---------------------------------------------------------------------------
async function runJob(targets: PadronTarget[]): Promise<void> {
  console.log('[padron] job started');

  let zipBuffer: Buffer;
  let rows: string[][];
  try {
    zipBuffer = await downloadZip();
    const txtBuffer = extractTxt(zipBuffer);
    const text = decodeTxt(txtBuffer);
    rows = parseRows(text);
    console.log(`[padron] parsed ${rows.length.toLocaleString()} valid rows`);
  } catch (e: any) {
    console.error('[padron] download/parse failed:', e.message);
    return;
  }

  for (const target of targets) {
    const prep = await prepareTarget(target, null as any).catch(e => {
      console.error(`[padron:${target.name}] prepareTarget error:`, e.message);
      return null;
    });
    if (!prep) {
      console.log(`[padron:${target.name}] skipped (schema error, conflict, or prep failure)`);
      continue;
    }
    const { pool, runId } = prep;
    try {
      await syncTarget(target, rows, runId, pool);
    } catch (e: any) {
      console.error(`[padron:${target.name}] sync error:`, e.message);
      await pool
        .query(
          `UPDATE ${target.runsTable}
           SET finished_at = now(), status = 'error', error = $1
           WHERE id = $2`,
          [String(e.message).slice(0, 500), runId]
        )
        .catch(() => {});
    }
  }

  console.log('[padron] job complete');
}

// ---------------------------------------------------------------------------
// POST /padron/sync — fire-and-forget; returns 202 immediately.
// ---------------------------------------------------------------------------
padronRouter.post('/padron/sync', padronAuth, async (req: Request, res: Response) => {
  const targets = buildTargets();
  if (targets.length === 0) {
    return res.status(503).json({ error: 'no targets configured (POS_DB_URL / CRM_DB_URL)' });
  }
  res.status(202).json({ ok: true, targets: targets.map(t => t.name) });
  runJob(targets).catch(e => console.error('[padron] runJob uncaught:', e.message));
});

// ---------------------------------------------------------------------------
// Weekly cron — registers once at startup.
// ---------------------------------------------------------------------------
export function schedulePadronCron(): void {
  const expr = process.env.PADRON_CRON || '0 8 * * 1';
  if (!cron.validate(expr)) {
    console.warn(`[padron] invalid PADRON_CRON expression "${expr}", cron not registered`);
    return;
  }
  cron.schedule(expr, () => {
    const targets = buildTargets();
    if (targets.length === 0) return;
    runJob(targets).catch(e => console.error('[padron] cron job uncaught:', e.message));
  });
  console.log(`[padron] weekly cron registered: ${expr}`);
}
