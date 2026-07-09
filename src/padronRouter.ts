import { Router, Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import cron from 'node-cron';
import {
  PadronTarget,
  BATCH_SIZE,
  buildTargets,
  downloadZip,
  extractTxt,
  decodeTxt,
  parseRows,
  ingestBegin,
  ingestBatch,
  ingestFinish,
  ingestFail,
} from './padronSync';

export const padronRouter = Router();

// ---------------------------------------------------------------------------
// Auth — separate key from emisorAuth; rotate independently.
// Used in BOTH directions: inbound guard on /padron/sync AND outbound
// x-padron-key header on every ingest call (read by ingestHeaders() in padronSync).
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
// Types
// ---------------------------------------------------------------------------

interface ActiveRun {
  target: PadronTarget;
  runId: string;
  runStartedAt: string;
}

interface RunsEntry {
  target: string;
  run_id?: string;
  skipped?: string;
}

// ---------------------------------------------------------------------------
// beginAll: call ingest begin for every target and separate active from skipped.
// ---------------------------------------------------------------------------
async function beginAll(
  targets: PadronTarget[],
  triggeredBy: 'manual' | 'cron' | 'internal'
): Promise<{ runs: RunsEntry[]; activeRuns: ActiveRun[] }> {
  const runs: RunsEntry[] = [];
  const activeRuns: ActiveRun[] = [];

  for (const target of targets) {
    try {
      const result = await ingestBegin(target.ingestUrl, triggeredBy);
      if ('skipped' in result) {
        runs.push({ target: target.name, skipped: result.skipped });
        console.log(`[padron:${target.name}] begin: ${result.skipped}`);
      } else {
        runs.push({ target: target.name, run_id: result.run_id });
        activeRuns.push({ target, runId: result.run_id, runStartedAt: result.run_started_at });
        console.log(`[padron:${target.name}] begin: run_id=${result.run_id}`);
      }
    } catch (e: any) {
      console.error(`[padron:${target.name}] begin failed:`, e.message);
      runs.push({ target: target.name, skipped: `begin_failed: ${e.message}` });
    }
  }

  return { runs, activeRuns };
}

// ---------------------------------------------------------------------------
// Main job: download once, fan-out batches to each active run.
// ---------------------------------------------------------------------------
async function runJob(activeRuns: ActiveRun[]): Promise<void> {
  console.log('[padron] job started');

  let parsedRows: string[][];
  try {
    const zipBuffer = await downloadZip();
    const txtBuffer = extractTxt(zipBuffer);
    const text = decodeTxt(txtBuffer);
    parsedRows = parseRows(text);
    console.log(`[padron] parsed ${parsedRows.length.toLocaleString()} valid rows`);
  } catch (e: any) {
    console.error('[padron] download/parse failed:', e.message);
    for (const { target, runId } of activeRuns) {
      await ingestFail(target.ingestUrl, runId, `download/parse failed: ${e.message}`);
    }
    return;
  }

  for (const { target, runId, runStartedAt } of activeRuns) {
    let rowsUpserted = 0;
    let aborted = false;

    try {
      for (let i = 0; i < parsedRows.length; i += BATCH_SIZE) {
        const batchRows = parsedRows.slice(i, i + BATCH_SIZE).map(parts => target.mapRow(parts));

        let result: { upserted: number; dropped: number };
        try {
          result = await ingestBatch(target.ingestUrl, runId, runStartedAt, batchRows);
        } catch (e: any) {
          if ((e as any).code === 'run_not_running') {
            console.error(`[padron:${target.name}] batch 409 run_not_running — aborting`);
            aborted = true;
            break;
          }
          throw e;
        }

        rowsUpserted += result.upserted;

        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        if (batchNum % 10 === 0) {
          console.log(
            `[padron:${target.name}] batch ${batchNum}: ${rowsUpserted.toLocaleString()} rows upserted`
          );
        }
      }

      if (!aborted) {
        const { rows_deleted } = await ingestFinish(
          target.ingestUrl, runId, runStartedAt, parsedRows.length, rowsUpserted
        );
        console.log(
          `[padron:${target.name}] done — ` +
          `${rowsUpserted.toLocaleString()} upserted, ${rows_deleted} deleted`
        );
      }
    } catch (e: any) {
      console.error(`[padron:${target.name}] sync error:`, e.message);
      await ingestFail(target.ingestUrl, runId, String(e.message).slice(0, 500));
    }
  }

  console.log('[padron] job complete');
}

// ---------------------------------------------------------------------------
// POST /padron/sync — calls begin for all targets (fast), returns 202 with run
// state, then processes active runs fire-and-forget.
// ---------------------------------------------------------------------------
padronRouter.post('/padron/sync', padronAuth, async (req: Request, res: Response) => {
  const targets = buildTargets();
  if (targets.length === 0) {
    return res.status(503).json({ error: 'no targets configured (POS_INGEST_URL)' });
  }

  const { runs, activeRuns } = await beginAll(targets, 'manual');
  res.status(202).json({ ok: true, runs });

  if (activeRuns.length > 0) {
    runJob(activeRuns).catch(e => console.error('[padron] runJob uncaught:', e.message));
  }
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
    (async () => {
      const { activeRuns } = await beginAll(targets, 'cron');
      if (activeRuns.length > 0) await runJob(activeRuns);
    })().catch(e => console.error('[padron] cron job uncaught:', e.message));
  });
  console.log(`[padron] weekly cron registered: ${expr}`);
}
