import * as fs from 'fs';
import * as path from 'path';
import { getAcecfCases } from './dataset';
import { buildAcecf } from './acecfBuilder';
import { signXml, keyFromEnv } from './signer';
import { authenticate, sendAprobacion } from './dgiiClient';

const OUT = path.resolve(__dirname, '..', 'out');

function parseBody(b: any): any {
  if (b == null) return {};
  if (typeof b !== 'string') return b;
  try { return JSON.parse(b); } catch { return {}; }
}

function msgString(m: any): string {
  return Array.isArray(m) && m.length
    ? m.map((x: any) => `[${x.codigo}] ${x.valor}`).join('; ')
    : '';
}

/**
 * Paso 3 live send: build -> sign -> submit each Aprobación Comercial and log
 * the synchronous verdict. Env: P12_PATH, P12_PASSWORD, DGII_ENV=certecf.
 * The password is read only from the environment and never logged.
 */
async function main() {
  const key = keyFromEnv();
  if (!key) { console.log('No P12 in env (set P12_PATH + P12_PASSWORD)'); process.exit(1); }

  console.log('=== DGII APROBACIÓN COMERCIAL (Paso 3) ===');
  console.log('Auth...');
  try { await authenticate(key); }
  catch (e: any) { console.log('AUTH FAILED:', e.message || e); process.exit(2); }
  console.log('AUTH OK\n');

  const cases = getAcecfCases();
  const results: any[] = [];
  let accepted = 0;

  console.log(`--- ACECF (${cases.length}) -> AprobacionComercial (synchronous verdict) ---`);
  for (const c of cases) {
    const encf = c.eNCF;
    try {
      const signed = signXml(buildAcecf(c), key);
      const res: any = await sendAprobacion(signed, encf, key);
      const body = parseBody(res.body);
      const estado = body.estado || body.Estado || '';
      if (String(estado).toLowerCase() === 'aceptado') accepted++;
      console.log(`  ACECF ${encf}  Estado=${c.Estado}  HTTP=${res.status} ${estado || '(no verdict)'}${msgString(body.mensajes) ? '  ' + msgString(body.mensajes) : ''}`);
      results.push({ encf, estadoEnvio: c.Estado, status: res.status, estado, mensajes: body.mensajes || null, body });
    } catch (e: any) {
      console.log(`  ACECF ${encf}  ERROR ${e.message || e}`);
      results.push({ encf, estadoEnvio: c.Estado, error: String(e.message || e) });
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Aprobaciones accepted: ${accepted}/${cases.length}`);

  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, '_aprobacion_results.json'), JSON.stringify(results, null, 2));
}

main().catch((e) => { console.log('FATAL', e); process.exit(99); });
