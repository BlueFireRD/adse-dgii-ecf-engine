import { Pool } from 'pg';
import { unzipSync } from 'fflate';
import * as iconv from 'iconv-lite';

export interface PadronTarget {
  name: 'pos' | 'crm';
  dbUrl: string;
  padronTable: string;
  runsTable: string;
  mapRow: (parts: string[], syncedAt: string) => Record<string, unknown>;
}

const DGII_ZIP_URL = 'https://www.dgii.gov.do/app/WebApps/Consultas/RNC/DGII_RNC.zip';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const CHUNK_SIZE = 2 * 1024 * 1024; // 2 MB
const BATCH_SIZE = 5_000;
const SWEEP_THRESHOLD = 500_000;

// Per-target connection pools, live for the process lifetime.
const pools = new Map<string, Pool>();

export function getTargetPool(dbUrl: string): Pool {
  if (!pools.has(dbUrl)) {
    pools.set(dbUrl, new Pool({
      connectionString: dbUrl,
      ssl: { rejectUnauthorized: false },
      max: 5,
    }));
  }
  return pools.get(dbUrl)!;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Download the DGII zip in 2 MB HTTP Range chunks with up to 3 retries per chunk.
 * The Range approach is proven against the CDN's truncating behavior on plain
 * full-file downloads — keep it even though Node could buffer freely.
 */
export async function downloadZip(): Promise<Buffer> {
  const headRes = await fetch(DGII_ZIP_URL, {
    method: 'HEAD',
    headers: { 'User-Agent': USER_AGENT },
  });
  const totalBytes = parseInt(headRes.headers.get('content-length') || '0', 10);
  if (!totalBytes) throw new Error('HEAD did not return content-length');
  console.log(`[padron] zip: ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);

  const chunks: Buffer[] = [];
  let offset = 0;

  while (offset < totalBytes) {
    const end = Math.min(offset + CHUNK_SIZE - 1, totalBytes - 1);

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(DGII_ZIP_URL, {
          headers: {
            'User-Agent': USER_AGENT,
            'Range': `bytes=${offset}-${end}`,
            'Accept-Encoding': 'identity',
          },
        });
        if (!res.ok) throw new Error(`chunk HTTP ${res.status} bytes=${offset}-${end}`);
        chunks.push(Buffer.from(await res.arrayBuffer()));
        break;
      } catch (e) {
        if (attempt === 2) throw e;
        await sleep(1000 * 2 ** attempt);
      }
    }

    offset = end + 1;
  }

  const result = Buffer.concat(chunks);
  console.log(`[padron] download complete: ${(result.length / 1024 / 1024).toFixed(1)} MB`);
  return result;
}

/** Extract DGII_RNC.TXT from the zip archive. */
export function extractTxt(zipBuffer: Buffer): Buffer {
  const files = unzipSync(new Uint8Array(zipBuffer));
  const key = Object.keys(files).find(k => k.toUpperCase().endsWith('DGII_RNC.TXT'));
  if (!key) throw new Error('DGII_RNC.TXT not found in zip archive');
  const data = files[key];
  console.log(`[padron] member ${key}: ${(data.length / 1024 / 1024).toFixed(1)} MB`);
  return Buffer.from(data);
}

/** Decode Windows-1252 bytes; iconv-lite as fallback if TextDecoder lacks the encoding. */
export function decodeTxt(buf: Buffer): string {
  try {
    return new TextDecoder('windows-1252').decode(buf);
  } catch {
    return iconv.decode(buf, 'windows-1252');
  }
}

/**
 * Parse the pipe-delimited text into trimmed part arrays.
 * Skips lines with fewer than 2 fields, blank rnc or razon_social,
 * or an rnc that does not match 9–11 digits.
 */
export function parseRows(text: string): string[][] {
  const result: string[][] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const parts = line.split('|');
    if (parts.length < 2) continue;
    const rnc = (parts[0] || '').trim();
    const razon = (parts[1] || '').trim();
    if (!rnc || !razon || !/^\d{9,11}$/.test(rnc)) continue;
    result.push(parts.map(p => p.trim()));
  }
  return result;
}

/**
 * Cheap pre-flight: verify the runs table and the padron table's synced_at
 * column exist in the target DB. Returns an error string, or null if OK.
 */
export async function verifyTargetSchema(
  pool: Pool,
  target: PadronTarget
): Promise<string | null> {
  const { rows: r1 } = await pool.query(
    `SELECT to_regclass($1) AS t`,
    [`public.${target.runsTable}`]
  );
  if (!r1[0].t) return `runs table "${target.runsTable}" not found`;

  const { rows: r2 } = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'synced_at'`,
    [target.padronTable]
  );
  if (!r2.length) return `column synced_at not found in "${target.padronTable}"`;

  return null;
}

/**
 * Batch-upsert all rows into the target padron table, sweep stale rows,
 * and close the run row to success (or note a skipped sweep).
 * Any thrown exception must be caught by the caller, which closes the run to error.
 */
export async function syncTarget(
  target: PadronTarget,
  rows: string[][],
  runId: string,
  pool: Pool
): Promise<void> {
  const syncedAt = new Date().toISOString();

  // Derive columns once from a sample row so the upsert SQL is target-agnostic.
  const sample = target.mapRow(rows[0], syncedAt);
  const cols = Object.keys(sample);
  const updateCols = cols.filter(c => c !== 'rnc');
  const setClauses = updateCols.map(c => `${c} = EXCLUDED.${c}`).join(', ');

  let rowsUpserted = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const params: unknown[] = [];
    const valueSets: string[] = [];

    for (const parts of batch) {
      const mapped = target.mapRow(parts, syncedAt);
      const placeholders = cols.map(col => {
        params.push(mapped[col] ?? null);
        return `$${params.length}`;
      });
      valueSets.push(`(${placeholders.join(', ')})`);
    }

    const sql =
      `INSERT INTO ${target.padronTable} (${cols.join(', ')}) ` +
      `VALUES ${valueSets.join(', ')} ` +
      `ON CONFLICT (rnc) DO UPDATE SET ${setClauses}`;

    await pool.query(sql, params);
    rowsUpserted += batch.length;

    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    if (batchNum % 10 === 0) {
      console.log(
        `[padron:${target.name}] batch ${batchNum}: ${rowsUpserted.toLocaleString()} rows upserted`
      );
    }
  }

  // Sweep rows absent from this run only when the file looks complete.
  // Below the threshold, a truncated DGII file could otherwise wipe the mirror.
  let rowsDeleted = 0;
  let sweepNote: string | null = null;

  if (rowsUpserted >= SWEEP_THRESHOLD) {
    const del = await pool.query(
      `DELETE FROM ${target.padronTable} WHERE synced_at IS NULL OR synced_at < $1`,
      [syncedAt]
    );
    rowsDeleted = del.rowCount ?? 0;
  } else {
    sweepNote = `sweep skipped: below threshold (${rowsUpserted})`;
    console.log(`[padron:${target.name}] ${sweepNote}`);
  }

  await pool.query(
    `UPDATE ${target.runsTable}
     SET finished_at = now(), status = 'success',
         total_lines = $1, rows_upserted = $2, rows_deleted = $3, error = $4
     WHERE id = $5`,
    [rows.length, rowsUpserted, rowsDeleted, sweepNote, runId]
  );

  console.log(
    `[padron:${target.name}] done — ` +
    `${rowsUpserted.toLocaleString()} upserted, ${rowsDeleted} deleted`
  );
}

// ---------------------------------------------------------------------------
// Target definitions
// ---------------------------------------------------------------------------

function posMapRow(parts: string[], syncedAt: string): Record<string, unknown> {
  return {
    rnc:                 parts[0],
    razon_social:        parts[1],
    nombre_comercial:    parts[2] || null,
    actividad_economica: parts[3] || null,
    estado:              parts[9] || null,
    synced_at:           syncedAt,
  };
}

function crmMapRow(parts: string[], syncedAt: string): Record<string, unknown> {
  return {
    rnc:              parts[0],
    razon_social:     parts[1],
    nombre_comercial: parts[2] || null,
    actividad:        parts[3] || null,
    estado:           parts[9] || null,
    regimen:          parts[10] || null,
    last_checked:     syncedAt,
    source:           'DGII_RNC.zip',
    synced_at:        syncedAt,
  };
}

/** Returns all enabled targets based on configured env vars. */
export function buildTargets(): PadronTarget[] {
  const targets: PadronTarget[] = [];

  if (process.env.POS_DB_URL) {
    targets.push({
      name:         'pos',
      dbUrl:        process.env.POS_DB_URL,
      padronTable:  'dgii_padron',
      runsTable:    'padron_sync_runs',
      mapRow:       posMapRow,
    });
  }

  if (process.env.CRM_DB_URL) {
    targets.push({
      name:         'crm',
      dbUrl:        process.env.CRM_DB_URL,
      padronTable:  'dgii_padron_cache',
      runsTable:    'padron_sync_runs',
      mapRow:       crmMapRow,
    });
  }

  return targets;
}
