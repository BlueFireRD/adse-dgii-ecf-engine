import { unzipSync } from 'fflate';
import * as iconv from 'iconv-lite';

export interface PadronTarget {
  name: 'pos' | 'crm' | 'factura';
  ingestUrl: string;
  mapRow: (parts: string[]) => Record<string, unknown>;
}

const DGII_ZIP_URL = 'https://www.dgii.gov.do/app/WebApps/Consultas/RNC/DGII_RNC.zip';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const CHUNK_SIZE = 2 * 1024 * 1024; // 2 MB
export const BATCH_SIZE = 5_000;

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

// ---------------------------------------------------------------------------
// Ingest HTTP protocol
// ---------------------------------------------------------------------------

function ingestHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-padron-key': process.env.PADRON_API_KEY || '',
  };
}

export interface BeginResult {
  ok: true;
  run_id: string;
  run_started_at: string;
}
export interface BeginSkipped {
  ok: true;
  skipped: 'already_running';
}
export type BeginResponse = BeginResult | BeginSkipped;

export async function ingestBegin(
  ingestUrl: string,
  triggeredBy: 'manual' | 'cron' | 'internal'
): Promise<BeginResponse> {
  const res = await fetch(ingestUrl, {
    method: 'POST',
    headers: ingestHeaders(),
    body: JSON.stringify({ action: 'begin', triggered_by: triggeredBy }),
  });
  if (!res.ok) throw new Error(`ingest begin HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as BeginResponse;
}

/**
 * POST a batch of rows to the ingest endpoint.
 * Retries up to 3 times on network errors / 5xx.
 * A 409 (run not running) is not retryable — throws with code 'run_not_running'.
 */
export async function ingestBatch(
  ingestUrl: string,
  runId: string,
  syncedAt: string,
  rows: Record<string, unknown>[]
): Promise<{ upserted: number; dropped: number }> {
  const body = JSON.stringify({ action: 'batch', run_id: runId, synced_at: syncedAt, rows });

  for (let attempt = 0; attempt < 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(ingestUrl, { method: 'POST', headers: ingestHeaders(), body });
    } catch (e: any) {
      if (attempt === 2) throw new Error(`batch network error: ${e.message}`);
      await sleep(1000 * 2 ** attempt);
      continue;
    }

    if (res.status === 409) {
      const err = new Error('run_not_running') as Error & { code: string };
      err.code = 'run_not_running';
      throw err;
    }
    if (res.ok) return (await res.json()) as { upserted: number; dropped: number };
    if (res.status >= 500 && attempt < 2) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    throw new Error(`batch HTTP ${res.status}: ${await res.text()}`);
  }

  throw new Error('unreachable');
}

export async function ingestFinish(
  ingestUrl: string,
  runId: string,
  runStartedAt: string,
  totalLines: number,
  rowsUpserted: number
): Promise<{ rows_deleted: number }> {
  const res = await fetch(ingestUrl, {
    method: 'POST',
    headers: ingestHeaders(),
    body: JSON.stringify({
      action: 'finish',
      run_id: runId,
      run_started_at: runStartedAt,
      total_lines: totalLines,
      rows_upserted: rowsUpserted,
    }),
  });
  if (!res.ok) throw new Error(`ingest finish HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as { rows_deleted: number };
}

/** Signal a failed run to the ingest endpoint. Best-effort — never throws. */
export async function ingestFail(
  ingestUrl: string,
  runId: string,
  error: string
): Promise<void> {
  try {
    const res = await fetch(ingestUrl, {
      method: 'POST',
      headers: ingestHeaders(),
      body: JSON.stringify({ action: 'fail', run_id: runId, error }),
    });
    if (!res.ok) {
      console.error(`[padron] ingest fail HTTP ${res.status}:`, await res.text().catch(() => ''));
    }
  } catch (e: any) {
    console.error('[padron] ingest fail delivery error:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Target definitions
// ---------------------------------------------------------------------------

function posMapRow(parts: string[]): Record<string, unknown> {
  return {
    rnc:                 parts[0],
    razon_social:        parts[1],
    nombre_comercial:    parts[2] || null,
    actividad_economica: parts[3] || null,
    estado:              parts[9] || null,
  };
}

function crmMapRow(parts: string[]): Record<string, unknown> {
  return {
    rnc:              parts[0],
    razon_social:     parts[1],
    nombre_comercial: parts[2] || null,
    actividad:        parts[3] || null,
    estado:           parts[9] || null,
    regimen:          parts[10] || null,
  };
}

function facturaMapRow(parts: string[]): Record<string, unknown> {
  return {
    rnc:              parts[0],
    razon_social:     parts[1],
    nombre_comercial: parts[2] || null,
    actividad:        parts[3] || null,
    estado:           parts[9] || null,
    regimen:          parts[10] || null,
  };
}

/** Returns all enabled targets based on configured env vars. */
export function buildTargets(): PadronTarget[] {
  const targets: PadronTarget[] = [];

  if (process.env.POS_INGEST_URL) {
    targets.push({
      name:      'pos',
      ingestUrl: process.env.POS_INGEST_URL,
      mapRow:    posMapRow,
    });
  }

  if (process.env.CRM_INGEST_URL) {
    targets.push({
      name:      'crm',
      ingestUrl: process.env.CRM_INGEST_URL,
      mapRow:    crmMapRow,
    });
  }

  if (process.env.FACTURA_INGEST_URL) {
    targets.push({
      name:      'factura',
      ingestUrl: process.env.FACTURA_INGEST_URL,
      mapRow:    facturaMapRow,
    });
  }

  return targets;
}
