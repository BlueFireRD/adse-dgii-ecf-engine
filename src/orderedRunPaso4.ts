import * as fs from 'fs';
import * as path from 'path';
import { getPaso4Cases, Paso4Case } from './dataset';
import { buildEcf } from './xmlBuilder';
import { buildRfce } from './rfceBuilder';
import {
  signXml,
  keyFromEnv,
  generateEphemeralKey,
  extractSecurityCode,
  KeyMaterial,
} from './signer';
import { qrForPlan, extractFechaFirma } from './qrBuilder';
import { schemaPathForEcf, schemaPathForRfce, validateXml } from './validator';
import { authenticate, sendEcf, sendRfce, consultaResultado } from './dgiiClient';

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'out');
const UPLOAD_DIR = path.join(ROOT, 'consumo_xml_paso4');

/** A single Timbre row for Pasos 5-6. */
interface QrRow {
  orden: number;
  tipo: string;
  eNCF: string;
  montoTotal: string;
  totalITBIS: string;
  fechaEmision: string;
  fechaFirma: string;
  codigoSeguridad: string;
  qrURL: string;
}

function pb(b: any) {
  return typeof b === 'string'
    ? (() => {
        try {
          return JSON.parse(b);
        } catch {
          return {};
        }
      })()
    : b || {};
}
function msg(m: any) {
  return Array.isArray(m) && m.length ? m.map((x: any) => `[${x.codigo}] ${x.valor}`).join('; ') : '';
}

async function sendAndPoll(signed: string, encf: string, key: KeyMaterial, token: string) {
  const rec = await sendEcf(signed, encf, key);
  const rb = pb(rec.body);
  const trackId = rb.trackId || rb.TrackId;
  if (!trackId) return { estado: '', status: rec.status, trackId: '', mensajes: rb.mensajes || null };
  let estado = '',
    mensajes: any = null;
  for (let i = 0; i < 14; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const res = await consultaResultado(trackId, token);
    const j = pb(res.body);
    estado = j.estado || j.Estado || '';
    mensajes = j.mensajes || j.Mensajes || null;
    if (estado && estado.toLowerCase() !== 'en proceso') break;
  }
  return { estado, status: rec.status, trackId, mensajes };
}

/** Build + sign one normal e-CF (and validate). Returns the QR row + signed XML. */
function prepareEcf(c: Paso4Case, key: KeyMaterial): { row: QrRow; signed: string } {
  const tipo = c.plan.tipo;
  const xml = buildEcf(c.ecf, tipo);
  const fechaFirma = extractFechaFirma(xml);
  const signed = signXml(xml, key);
  const code = extractSecurityCode(signed);
  const res = validateXml(signed, schemaPathForEcf(tipo), c.plan.nuevo_encf);
  if (!res.valid) {
    throw new Error(`XSD FAIL ${c.plan.nuevo_encf}: ${res.errors.join(' | ')}`);
  }
  const row: QrRow = {
    orden: c.plan.orden,
    tipo,
    eNCF: c.plan.nuevo_encf,
    montoTotal: c.plan.monto_total,
    totalITBIS: c.plan.itbis,
    fechaEmision: c.plan.fecha,
    fechaFirma,
    codigoSeguridad: code,
    qrURL: qrForPlan(c.plan, code, fechaFirma),
  };
  return { row, signed };
}

/**
 * Build + sign one consumo (<250k) row: sign the FULL invoice (save it for the
 * manual portal upload), derive the binding code from its SignatureValue, and
 * build + sign the RFCE summary carrying that exact code.
 */
function prepareConsumo(
  c: Paso4Case,
  key: KeyMaterial
): { row: QrRow; signedFull: string; signedRfce: string } {
  const encf = c.plan.nuevo_encf;
  // 1. Full invoice (the very bytes uploaded manually).
  const fullXml = buildEcf(c.ecf, '32');
  const fechaFirma = extractFechaFirma(fullXml);
  const signedFull = signXml(fullXml, key);
  // 2. Binding code = first 6 of the full invoice SignatureValue.
  const code = extractSecurityCode(signedFull);
  const fullRes = validateXml(signedFull, schemaPathForEcf('32'), encf);
  if (!fullRes.valid) {
    throw new Error(`XSD FAIL (full invoice) ${encf}: ${fullRes.errors.join(' | ')}`);
  }
  // 3. RFCE summary carrying that code.
  const signedRfce = signXml(buildRfce(c.rfce!, code), key);
  const rfceRes = validateXml(signedRfce, schemaPathForRfce(), encf);
  if (!rfceRes.valid) {
    throw new Error(`XSD FAIL (RFCE) ${encf}: ${rfceRes.errors.join(' | ')}`);
  }
  const row: QrRow = {
    orden: c.plan.orden,
    tipo: c.plan.tipo,
    eNCF: encf,
    montoTotal: c.plan.monto_total,
    totalITBIS: c.plan.itbis,
    fechaEmision: c.plan.fecha,
    fechaFirma,
    codigoSeguridad: code,
    qrURL: qrForPlan(c.plan, code, fechaFirma),
  };
  return { row, signedFull, signedRfce };
}

function writeQrOutputs(rows: QrRow[]) {
  rows.sort((a, b) => a.orden - b.orden);
  fs.writeFileSync(path.join(OUT_DIR, 'paso4_qr.json'), JSON.stringify(rows, null, 2), 'utf8');
  const cols = [
    'orden',
    'tipo',
    'eNCF',
    'montoTotal',
    'totalITBIS',
    'fechaEmision',
    'fechaFirma',
    'codigoSeguridad',
    'qrURL',
  ];
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [cols.join(',')];
  for (const r of rows) {
    lines.push(cols.map((k) => esc(String((r as any)[k] ?? ''))).join(','));
  }
  fs.writeFileSync(path.join(OUT_DIR, 'paso4_qr.csv'), lines.join('\n') + '\n', 'utf8');
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  const envKey = keyFromEnv();
  const LIVE = process.env.SEND === '1';
  if (LIVE && !envKey) {
    console.error('SEND=1 requires a real P12 (set P12_PATH and P12_PASSWORD).');
    process.exit(1);
  }
  const key = envKey || generateEphemeralKey();
  const keySource = envKey ? `P12 (${process.env.P12_PATH})` : 'ephemeral self-signed (dry run)';
  console.log(`Signing key: ${keySource}`);
  console.log(`Mode: ${LIVE ? 'LIVE SEND' : 'DRY RUN (no network)'}\n`);

  const cases = getPaso4Cases();
  // Official DGII order.
  const primero = cases.filter((c) => !c.isConsumo && !['33', '34'].includes(c.plan.tipo));
  const segundo = cases.filter((c) => c.isConsumo);
  const cuarto = cases.filter((c) => ['33', '34'].includes(c.plan.tipo));

  const rows: QrRow[] = [];
  const signedEcf = new Map<string, string>();
  const signedRfceMap = new Map<string, string>();
  const results: any[] = [];

  // Prepare everything first (build + sign + XSD) so a failure aborts before any send.
  console.log(`-- Primero: ${primero.length} e-CF (build+sign+XSD) --`);
  for (const c of primero) {
    const { row, signed } = prepareEcf(c, key);
    rows.push(row);
    signedEcf.set(row.eNCF, signed);
    console.log(`  ${row.eNCF} t${row.tipo} XSD ok  cod=${row.codigoSeguridad}`);
  }

  console.log(`\n-- Segundo: ${segundo.length} RFCE + full consumo invoices (binding) --`);
  for (const c of segundo) {
    const { row, signedFull, signedRfce } = prepareConsumo(c, key);
    rows.push(row);
    signedRfceMap.set(row.eNCF, signedRfce);
    fs.writeFileSync(path.join(UPLOAD_DIR, `133470616${row.eNCF}.xml`), signedFull, 'utf8');
    console.log(`  ${row.eNCF} RFCE+invoice XSD ok  cod=${row.codigoSeguridad}  (invoice saved for Tercero)`);
  }

  console.log(`\n-- Cuarto: ${cuarto.length} notas 33/34 (build+sign+XSD, sent LAST) --`);
  for (const c of cuarto) {
    const { row, signed } = prepareEcf(c, key);
    rows.push(row);
    signedEcf.set(row.eNCF, signed);
    console.log(`  ${row.eNCF} t${row.tipo} XSD ok  cod=${row.codigoSeguridad}`);
  }

  writeQrOutputs(rows);
  console.log(`\nWrote out/paso4_qr.json and out/paso4_qr.csv (${rows.length} rows).`);
  console.log(`Full consumo invoices for manual upload: ${UPLOAD_DIR}`);

  if (!LIVE) {
    console.log('\nDRY RUN complete — nothing sent to DGII. Re-run with SEND=1 + a real P12 to submit.');
    return;
  }

  // ---- LIVE SEND in official order ----
  const token = await authenticate(key);
  console.log('\nAUTH OK — sending in official order.\n');

  console.log('=== Primero: e-CF (async trackId) ===');
  for (const c of primero) {
    const encf = c.plan.nuevo_encf;
    const r = await sendAndPoll(signedEcf.get(encf)!, encf, key, token);
    const ok = String(r.estado).toLowerCase() === 'aceptado';
    console.log(`  ${encf} t${c.plan.tipo} ${ok ? 'Aceptado' : r.estado || '(no verdict)'}${msg(r.mensajes) ? '  ' + msg(r.mensajes) : ''}`);
    results.push({ fase: 'primero', encf, tipo: c.plan.tipo, ...r });
  }

  console.log('\n=== Segundo: RFCE consumo (recepcionFC, sync) ===');
  for (const c of segundo) {
    const encf = c.plan.nuevo_encf;
    const res = await sendRfce(signedRfceMap.get(encf)!, encf, key);
    const b = pb(res.body);
    const estado = b.estado || b.Estado || '';
    console.log(`  RFCE ${encf} HTTP=${res.status} ${estado}${msg(b.mensajes) ? '  ' + msg(b.mensajes) : ''}`);
    results.push({ fase: 'segundo', kind: 'RFCE', encf, status: res.status, estado, mensajes: b.mensajes });
  }

  console.log(`\n=== Tercero: upload the ${segundo.length} XML in ${UPLOAD_DIR} via the portal (MANUAL) ===`);

  console.log('\n=== Cuarto: notas 33/34 (async trackId) — LAST ===');
  for (const c of cuarto) {
    const encf = c.plan.nuevo_encf;
    const r = await sendAndPoll(signedEcf.get(encf)!, encf, key, token);
    const ok = String(r.estado).toLowerCase() === 'aceptado';
    console.log(`  ${encf} t${c.plan.tipo} ${ok ? 'Aceptado' : r.estado || '(no verdict)'}${msg(r.mensajes) ? '  ' + msg(r.mensajes) : ''}`);
    results.push({ fase: 'cuarto', encf, tipo: c.plan.tipo, ...r });
  }

  fs.writeFileSync(path.join(OUT_DIR, '_paso4_results.json'), JSON.stringify(results, null, 2), 'utf8');
  console.log('\nLive send complete. Verdicts in out/_paso4_results.json.');
}

main().catch((e) => {
  console.error('FATAL', e.message || e);
  process.exit(99);
});
