import * as fs from 'fs';
import * as path from 'path';
import { getEcfCases, getRfceCases } from './dataset';
import { buildEcf } from './xmlBuilder';
import { buildRfce } from './rfceBuilder';
import { signXml, keyFromEnv, extractSecurityCode } from './signer';
import { authenticate, sendEcf, sendRfce, consultaResultado } from './dgiiClient';

const RFCE_ENCFS = ['E320000000011','E320000000012','E320000000013','E320000000015'];
const RFCE_SET = new Set(RFCE_ENCFS);
const RNC = '133470616';
const PHASE = process.env.PHASE || 'A';
const UPLOAD_DIR = '/home/user/workspace/dgii-engine/consumo_xml';
function pb(b:any){ return typeof b==='string' ? (()=>{try{return JSON.parse(b);}catch{return {};}})() : (b||{}); }
function msg(m:any){ return Array.isArray(m)&&m.length ? m.map((x:any)=>`[${x.codigo}] ${x.valor}`).join('; ') : ''; }

async function sendAndPoll(signed:string, encf:string, key:any, token:string){
  const rec = await sendEcf(signed, encf, key);
  const rb = pb(rec.body); const trackId = rb.trackId||rb.TrackId;
  if(!trackId) return { estado:'', status:rec.status, trackId:'', mensajes: rb.mensajes||null };
  let estado='', mensajes:any=null;
  for(let i=0;i<14;i++){
    await new Promise(r=>setTimeout(r,2500));
    const res = await consultaResultado(trackId, token); const j = pb(res.body);
    estado = j.estado||j.Estado||''; mensajes = j.mensajes||j.Mensajes||null;
    if(estado && estado.toLowerCase()!=='en proceso') break;
  }
  return { estado, status:rec.status, trackId, mensajes };
}

async function main(){
  const key=keyFromEnv(); if(!key){console.log('no key');process.exit(1);}
  const token=await authenticate(key); console.log('AUTH OK\n');
  const results:any[]=[];
  const all=getEcfCases().filter((c:any)=>!RFCE_SET.has(c.ENCF));
  const phase1=all.filter((c:any)=>!['33','34'].includes(String(c.TipoeCF)));
  const notes=all.filter((c:any)=>['33','34'].includes(String(c.TipoeCF)));

  if(PHASE==='A'){
    fs.mkdirSync(UPLOAD_DIR,{recursive:true});
    console.log('=== PHASE A: Primero (18 e-CF), then Segundo (4 RFCE bound to signed invoices) ===');
    console.log(`-- Primero: ${phase1.length} e-CF --`);
    for(const c of phase1){ const encf=c.ENCF,t=String(c.TipoeCF);
      const r=await sendAndPoll(signXml(buildEcf(c,t),key),encf,key,token);
      const ok=String(r.estado).toLowerCase()==='aceptado';
      console.log(`  ${encf} t${t} ${ok?'Aceptado':(r.estado||'(no verdict)')}${msg(r.mensajes)?'  '+msg(r.mensajes):''}`);
      results.push({phase:'A',encf,t,estado:r.estado,trackId:r.trackId,mensajes:r.mensajes});
    }
    console.log(`\n-- Segundo: ${getRfceCases().length} RFCE (security code = first 6 of the FULL invoice SignatureValue) --`);
    const ecfByEncf=new Map<string,any>(); for(const c of getEcfCases()) ecfByEncf.set(c.ENCF,c);
    for(const c of getRfceCases()){ const encf=c.ENCF;
      // 1. Sign the FULL e-CF invoice for this eNCF (the very bytes the user will upload).
      const fullCase=ecfByEncf.get(encf)||c;
      const signedFull=signXml(buildEcf(fullCase,'32'),key);
      // 2. Derive the binding code from that signed invoice.
      const code=extractSecurityCode(signedFull);
      // 3. Save the SAME signed invoice for the manual portal upload.
      fs.writeFileSync(path.join(UPLOAD_DIR,`${RNC}${encf}.xml`),signedFull,'utf8');
      // 4. Build + sign the RFCE carrying that exact code, and send it.
      const res=await sendRfce(signXml(buildRfce(c,code),key),encf,key); const b=pb(res.body); const estado=b.estado||b.Estado||'';
      console.log(`  RFCE ${encf} code=${code} HTTP=${res.status} ${estado}${msg(b.mensajes)?'  '+msg(b.mensajes):''}`);
      results.push({phase:'A',kind:'RFCE',encf,code,estado,mensajes:b.mensajes});
    }
    console.log(`\n>>> PHASE A DONE. Upload the 4 XML in ${UPLOAD_DIR} via the portal (Tercero). Then run PHASE B. <<<`);
  } else {
    console.log('=== PHASE B: Cuarto (Notas 33/34) ===');
    for(const c of notes){ const encf=c.ENCF,t=String(c.TipoeCF);
      const r=await sendAndPoll(signXml(buildEcf(c,t),key),encf,key,token);
      const ok=String(r.estado).toLowerCase()==='aceptado';
      console.log(`  ${encf} t${t} -> mod ${c.NCFModificado} ${ok?'Aceptado':(r.estado||'(no verdict)')}${msg(r.mensajes)?'  '+msg(r.mensajes):''}`);
      results.push({phase:'B',encf,t,estado:r.estado,trackId:r.trackId,mensajes:r.mensajes});
    }
  }
  fs.writeFileSync(`/home/user/workspace/dgii-engine/out/_ordered_${PHASE}.json`, JSON.stringify(results,null,2));
}
main().catch(e=>{console.log('FATAL',e);process.exit(99);});
