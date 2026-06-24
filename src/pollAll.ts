import * as fs from 'fs';
import { keyFromEnv } from './signer';
import { authenticate, ENDPOINTS } from './dgiiClient';

async function main() {
  const key = keyFromEnv();
  if (!key) { console.log('no key'); process.exit(1); }
  const token = await authenticate(key);

  const results = JSON.parse(fs.readFileSync('/home/user/workspace/dgii-engine/out/_batch_results.json', 'utf8'));
  const norm = (b: any) => (typeof b === 'string' ? (() => { try { return JSON.parse(b); } catch { return {}; } })() : (b || {}));
  const ecf = results.filter((r: any) => r.kind === 'ECF').map((r: any) => ({ ...r, body: norm(r.body) })).filter((r: any) => r.body.trackId);

  console.log('=== Polling', ecf.length, 'e-CF trackIds ===');
  const base = ENDPOINTS.consultaResultado;
  const final: any[] = [];

  for (const r of ecf) {
    const trackId = r.body.trackId;
    let estado = '', mensajes: any = null, raw = '';
    for (let attempt = 0; attempt < 8; attempt++) {
      const url = `${base}?trackId=${encodeURIComponent(trackId)}`;
      const res = await fetch(url, { headers: { Authorization: `bearer ${token}` } });
      raw = await res.text();
      try {
        const j = JSON.parse(raw);
        estado = j.estado || j.Estado || '';
        mensajes = j.mensajes || j.Mensajes || null;
      } catch { estado = ''; }
      if (estado && estado.toLowerCase() !== 'en proceso') break;
      await new Promise(res => setTimeout(res, 2500));
    }
    const msg = Array.isArray(mensajes) && mensajes.length
      ? mensajes.map((x: any) => `[${x.codigo}] ${x.valor}`).join('; ') : '';
    console.log(`  ${r.encf} t${r.type}: ${estado || '(no estado)'}${msg ? '  '+msg : ''}`);
    final.push({ encf: r.encf, type: r.type, estado, msg, raw: raw.slice(0, 600) });
  }

  console.log('');
  console.log('=== FINAL e-CF SUMMARY ===');
  const acc = final.filter(r => r.estado.toLowerCase() === 'aceptado');
  const rej = final.filter(r => r.estado.toLowerCase() === 'rechazado');
  const oth = final.filter(r => !['aceptado','rechazado'].includes(r.estado.toLowerCase()));
  console.log(`Aceptado: ${acc.length} | Rechazado: ${rej.length} | Other: ${oth.length}`);
  for (const r of rej) console.log(`  REJECTED ${r.encf}: ${r.msg}`);
  for (const r of oth) console.log(`  OTHER ${r.encf}: estado='${r.estado}' raw=${r.raw}`);
  fs.writeFileSync('/home/user/workspace/dgii-engine/out/_poll_results.json', JSON.stringify(final, null, 2));
}
main().catch(e => console.log('FATAL', e));
