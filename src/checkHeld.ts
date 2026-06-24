import { keyFromEnv } from './signer';
import { authenticate } from './dgiiClient';
import { getEcfCases } from './dataset';

const RFCE = new Set(['E320000000011','E320000000012','E320000000013','E320000000015']);
const RNC = '133470616';
const TRACKIDS_URL = 'https://ecf.dgii.gov.do/certecf/consultatrackids/api/TrackIds/Consulta';
const ESTADO_URL = 'https://ecf.dgii.gov.do/certecf/consultaresultado/api/Consultas/Estado';

async function main() {
  const key = keyFromEnv();
  if (!key) { console.log('no key'); process.exit(1); }
  const token = await authenticate(key);
  const encfs = getEcfCases().filter((c: any) => !RFCE.has(c.ENCF)).map((c: any) => c.ENCF);

  console.log('=== Current DGII status per e-NCF (RNC', RNC, ') ===');
  const held: string[] = [];
  for (const encf of encfs) {
    const url = `${TRACKIDS_URL}?RNC=${RNC}&ENCF=${encf}`;
    let statusLine = '';
    try {
      const res = await fetch(url, { headers: { Authorization: `bearer ${token}` } });
      const txt = await res.text();
      let arr: any = [];
      try { arr = JSON.parse(txt); } catch { statusLine = `HTTP ${res.status} ${txt.slice(0,120)}`; }
      if (Array.isArray(arr) && arr.length) {
        // newest first; get latest estado via its trackId
        const latest = arr[0];
        const tid = latest.trackId || latest.TrackId;
        let estado = latest.estado || latest.Estado || '';
        if (!estado && tid) {
          const er = await fetch(`${ESTADO_URL}?trackId=${encodeURIComponent(tid)}`, { headers: { Authorization: `bearer ${token}` } });
          try { const ej = JSON.parse(await er.text()); estado = ej.estado || ej.Estado || ''; } catch {}
        }
        statusLine = `${arr.length} trackId(s), latest=${estado || '(unknown)'}`;
        if (String(estado).toLowerCase() === 'aceptado') held.push(encf);
      } else if (!statusLine) {
        statusLine = 'no submissions (free)';
      }
    } catch (e: any) { statusLine = 'ERR ' + (e.message || e); }
    console.log(`  ${encf}: ${statusLine}`);
  }
  console.log('');
  console.log('HELD (currently Aceptado on DGII, do NOT resend):', held.length ? held.join(', ') : 'none');
  require('fs').writeFileSync('/home/user/workspace/dgii-engine/out/_held.json', JSON.stringify(held));
}
main().catch(e => console.log('FATAL', e));
