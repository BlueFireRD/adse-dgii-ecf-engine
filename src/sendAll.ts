import * as fs from 'fs';
import { getEcfCases, getRfceCases } from './dataset';
import { buildEcf } from './xmlBuilder';
import { buildRfce } from './rfceBuilder';
import { signXml, keyFromEnv, verifyXml } from './signer';
import { authenticate, sendEcf, sendRfce, consultaResultado } from './dgiiClient';

const RFCE_ENCFS = new Set(['E320000000011', 'E320000000012', 'E320000000013', 'E320000000015']);

function parseBody(b: any): any {
  if (b == null) return {};
  if (typeof b !== 'string') return b;
  try { return JSON.parse(b); } catch { return {}; }
}

/**
 * Send a signed e-CF, then poll its trackId until DGII returns a terminal
 * verdict. e-CF reception is asynchronous: FacturasElectronicas returns a
 * trackId and the Aceptado/Rechazado verdict is fetched from Consultas/Estado.
 */
async function sendEcfAndPoll(signed: string, encf: string, key: any, token: string) {
  const rec: any = await sendEcf(signed, encf, key);
  const recBody = parseBody(rec.body);
  const trackId = recBody.trackId || recBody.TrackId;
  if (!trackId) {
    return { estado: '', status: rec.status, trackId: '', mensajes: recBody.mensajes || null, recBody };
  }
  let estado = '', mensajes: any = null, raw = '';
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise((r) => setTimeout(r, 2500));
    const res = await consultaResultado(trackId, token);
    raw = res.body;
    const j = parseBody(raw);
    estado = j.estado || j.Estado || '';
    mensajes = j.mensajes || j.Mensajes || null;
    if (estado && estado.toLowerCase() !== 'en proceso') break;
  }
  return { estado, status: rec.status, trackId, mensajes, raw };
}

function msgString(mensajes: any): string {
  return Array.isArray(mensajes) && mensajes.length
    ? mensajes.map((x: any) => `[${x.codigo}] ${x.valor}`).join('; ')
    : '';
}

/**
 * Order e-CF cases so that any note (t33/t34) referencing a prior e-CF via
 * NCFModificado is sent AFTER the referenced document — DGII rejects a note
 * (code 614 "El eNCF modificado no ha sido emitido") if the referenced e-CF
 * has not yet been accepted. Documents not referenced stay in dataset order.
 */
function dependencyOrder(cases: any[]): any[] {
  const byEncf = new Map<string, any>();
  for (const c of cases) byEncf.set(c.ENCF, c);
  const emitted = new Set<string>();
  const ordered: any[] = [];

  const visit = (c: any, chain: Set<string>) => {
    if (emitted.has(c.ENCF)) return;
    if (chain.has(c.ENCF)) return; // guard against cycles
    chain.add(c.ENCF);
    const ref = c.NCFModificado;
    if (ref && byEncf.has(ref) && !emitted.has(ref)) {
      visit(byEncf.get(ref), chain);
    }
    if (!emitted.has(c.ENCF)) {
      emitted.add(c.ENCF);
      ordered.push(c);
    }
  };

  for (const c of cases) visit(c, new Set());
  return ordered;
}

async function main() {
  const key = keyFromEnv();
  if (!key) { console.log('No P12 in env'); process.exit(1); }

  console.log('=== DGII FULL BATCH (certecf) ===');
  console.log('Auth...');
  let token = '';
  try { token = await authenticate(key); }
  catch (e: any) { console.log('AUTH FAILED:', e.message || e); process.exit(2); }
  console.log('AUTH OK. token length', token.length);
  console.log('');

  const SKIP = new Set((process.env.SKIP_ENCFS || '').split(',').map(s => s.trim()).filter(Boolean));
  const ecfCases = dependencyOrder(getEcfCases().filter((c: any) => !RFCE_ENCFS.has(c.ENCF) && !SKIP.has(c.ENCF)));
  const rfceCases = getRfceCases();
  const results: any[] = [];
  const acceptedEcf = new Set<string>();

  console.log(`--- e-CF (${ecfCases.length}) -> ecf. host (dependency-ordered, send+poll) ---`);
  for (const c of ecfCases) {
    const encf = c.ENCF; const type = String(c.TipoeCF);
    const ref = c.NCFModificado;
    // If this note references an e-CF in the batch that was NOT accepted, sending
    // it would trigger code 614 AND reset the counter. Skip and flag instead.
    if (ref && ecfCases.some((x: any) => x.ENCF === ref) && !acceptedEcf.has(ref)) {
      console.log(`  ECF  ${encf}  t${type}  SKIPPED: referenced ${ref} not yet Aceptado`);
      results.push({ kind: 'ECF', encf, type, estado: 'Skipped', reason: `ref ${ref} not accepted` });
      continue;
    }
    try {
      const xml = buildEcf(c, type);
      const signed = signXml(xml, key);
      const ok = verifyXml(signed);
      const r = await sendEcfAndPoll(signed, encf, key, token);
      const msg = msgString(r.mensajes);
      // Code 1209 = sequence already used => this e-NCF is ALREADY accepted on DGII
      // (held from a prior run). Treat as accepted/held, not a rejection.
      const is1209 = Array.isArray(r.mensajes) && r.mensajes.some((m: any) => String(m.codigo) === '1209');
      const accepted = String(r.estado).toLowerCase() === 'aceptado';
      const effective = accepted ? 'Aceptado' : (is1209 ? 'AlreadyAccepted(1209/held)' : (r.estado || '(no verdict)'));
      console.log(`  ECF  ${encf}  t${type}  sig=${ok}  ${effective}${msg ? '  ' + msg : ''}`);
      if (accepted || is1209) acceptedEcf.add(encf);
      results.push({ kind: 'ECF', encf, type, status: r.status, estado: accepted ? 'Aceptado' : (is1209 ? 'AlreadyAccepted' : r.estado), held1209: is1209, trackId: r.trackId, mensajes: r.mensajes });
    } catch (e: any) {
      console.log(`  ECF  ${encf}  ERROR ${e.message || e}`);
      results.push({ kind: 'ECF', encf, type, error: String(e.message || e) });
    }
  }
  console.log('');

  console.log(`--- RFCE (${rfceCases.length}) -> fc. host (synchronous verdict) ---`);
  for (const c of (process.env.SKIP_RFCE ? [] : rfceCases)) {
    const encf = c.ENCF;
    try {
      const xml = buildRfce(c);
      const signed = signXml(xml, key);
      const ok = verifyXml(signed);
      const res: any = await sendRfce(signed, encf, key);
      const body = parseBody(res.body);
      const estado = body.estado || body.Estado || '';
      console.log(`  RFCE ${encf}  sig=${ok}  HTTP=${res.status} ${estado}${msgString(body.mensajes) ? '  ' + msgString(body.mensajes) : ''}`);
      results.push({ kind: 'RFCE', encf, status: res.status, estado, body });
    } catch (e: any) {
      console.log(`  RFCE ${encf}  ERROR ${e.message || e}`);
      results.push({ kind: 'RFCE', encf, error: String(e.message || e) });
    }
  }

  console.log('');
  console.log('=== SUMMARY ===');
  const acc = results.filter(r => String(r.estado).toLowerCase() === 'aceptado');
  const held = results.filter(r => r.held1209);
  const rej = results.filter(r => String(r.estado).toLowerCase() === 'rechazado');
  const other = results.filter(r => !['aceptado', 'rechazado', 'alreadyaccepted'].includes(String(r.estado).toLowerCase()) && !r.held1209);
  console.log(`Aceptado(new): ${acc.length}  | AlreadyAccepted/held(1209): ${held.length}  | Rechazado: ${rej.length}  | Other/skip/error: ${other.length}`);
  if (held.length) console.log('  HELD (already accepted, skip next run):', held.map(r => r.encf).join(', '));
  for (const r of rej) console.log(`  REJECTED ${r.kind} ${r.encf}: ${msgString(r.mensajes)}`);
  for (const r of other) console.log(`  OTHER ${r.kind} ${r.encf}: estado=${r.estado || ''} ${r.reason || r.error || ''}`);
  fs.writeFileSync('/home/user/workspace/dgii-engine/out/_batch_results.json', JSON.stringify(results, null, 2));
}
main().catch(e => { console.log('FATAL', e); process.exit(99); });
