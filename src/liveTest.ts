import * as fs from 'fs';
import { getEcfCase, getRfceCase } from './dataset';
import { buildEcf } from './xmlBuilder';
import { buildRfce } from './rfceBuilder';
import { signXml, keyFromEnv, verifyXml } from './signer';
import { authenticate, sendEcf, sendRfce, consultaResultado, ENDPOINTS } from './dgiiClient';

function log(...a: any[]) { console.log(...a); }

async function main() {
  const key = keyFromEnv();
  if (!key) { log('No P12 in env — aborting'); process.exit(1); }

  log('=== DGII LIVE TEST (certecf) ===');
  log('Endpoints:');
  log('  semilla        ', ENDPOINTS.semilla);
  log('  validarSemilla ', ENDPOINTS.validarSemilla);
  log('  recepcionEcf   ', ENDPOINTS.recepcionEcf);
  log('  recepcionRfce  ', ENDPOINTS.recepcionRfce);
  log('');

  // --- Step 1: AUTH ---
  log('--- STEP 1: Authentication handshake ---');
  let token = '';
  try {
    token = await authenticate(key);
    log('AUTH OK. Token length:', token ? token.length : 0, '| preview:', token ? token.slice(0, 24) + '...' : '(empty)');
  } catch (e: any) {
    log('AUTH FAILED:', e.message || e);
    if (e.body) log('  body:', String(e.body).slice(0, 800));
    process.exit(2);
  }
  log('');

  // --- Step 2: priority submissions ---
  const rfceTargets = ['E320000000011', 'E320000000013', 'E320000000015'];
  const ecfTargets = ['E450000000001'];

  log('--- STEP 2: Submit RFCE priority cases (fc. host) ---');
  for (const encf of rfceTargets) {
    const c = getRfceCase(encf);
    if (!c) { log(`  ${encf}: NOT in RFCE dataset`); continue; }
    try {
      const xml = buildRfce(c);
      const signed = signXml(xml, key);
      const ok = verifyXml(signed);
      const res: any = await sendRfce(signed, encf, key);
      log(`  ${encf}: sigVerify=${ok} HTTP=${res.status}`);
      log(`    body: ${typeof res.body === 'string' ? res.body.slice(0, 1200) : JSON.stringify(res.body).slice(0, 1200)}`);
    } catch (e: any) {
      log(`  ${encf}: ERROR ${e.message || e}`);
      if (e.body) log('    body:', String(e.body).slice(0, 800));
    }
  }
  log('');

  log('--- STEP 3: Submit e-CF priority cases (ecf. host) ---');
  for (const encf of ecfTargets) {
    const c = getEcfCase(encf);
    if (!c) { log(`  ${encf}: NOT in ECF dataset`); continue; }
    const type = String(c.TipoeCF);
    try {
      const xml = buildEcf(c, type);
      const signed = signXml(xml, key);
      const ok = verifyXml(signed);
      const res: any = await sendEcf(signed, encf, key);
      log(`  ${encf} (tipo ${type}): sigVerify=${ok} HTTP=${res.status}`);
      log(`    reception body: ${typeof res.body === 'string' ? res.body.slice(0, 1200) : JSON.stringify(res.body).slice(0, 1200)}`);
      // e-CF reception is async: poll the verdict by trackId.
      let trackId = '';
      try { trackId = JSON.parse(res.body).trackId; } catch {}
      if (trackId) {
        const token = await authenticate(key);
        for (let i = 0; i < 5; i++) {
          await new Promise(r => setTimeout(r, 3000));
          const r = await consultaResultado(trackId, token);
          let estado = '';
          try { estado = JSON.parse(r.body).estado; } catch {}
          if (estado && estado !== 'En Proceso') {
            log(`    result body: ${r.body.slice(0, 1200)}`);
            break;
          }
          if (i === 4) log(`    result body (last poll): ${r.body.slice(0, 1200)}`);
        }
      }
    } catch (e: any) {
      log(`  ${encf}: ERROR ${e.message || e}`);
      if (e.body) log('    body:', String(e.body).slice(0, 800));
    }
  }
  log('');
  log('=== LIVE TEST DONE ===');
}

main().catch(e => { console.log('FATAL', e); process.exit(99); });
