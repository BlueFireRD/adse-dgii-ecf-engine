import * as fs from 'fs';
import { getEcfCases, getRfceCases } from './dataset';
import { buildEcf } from './xmlBuilder';
import { buildRfce } from './rfceBuilder';
import { signXml, keyFromEnv } from './signer';
import { authenticate, sendEcf, sendRfce, consultaResultado } from './dgiiClient';

const RFCE_ENCFS = new Set(['E320000000011','E320000000012','E320000000013','E320000000015']);
function pb(b:any){ return typeof b==='string' ? (()=>{try{return JSON.parse(b);}catch{return {};}})() : (b||{}); }
function msgString(m:any){ return Array.isArray(m)&&m.length ? m.map((x:any)=>`[${x.codigo}] ${x.valor}`).join('; ') : ''; }

async function sendEcfAndPoll(signed:string, encf:string, key:any, token:string){
  const rec = await sendEcf(signed, encf, key);
  const rb = pb(rec.body); const trackId = rb.trackId||rb.TrackId;
  if(!trackId) return { estado:'', status:rec.status, trackId:'', mensajes: rb.mensajes||null };
  let estado='', mensajes:any=null;
  for(let i=0;i<12;i++){
    await new Promise(r=>setTimeout(r,2500));
    const res = await consultaResultado(trackId, token); const j = pb(res.body);
    estado = j.estado||j.Estado||''; mensajes = j.mensajes||j.Mensajes||null;
    if(estado && estado.toLowerCase()!=='en proceso') break;
  }
  return { estado, status:rec.status, trackId, mensajes };
}
function dependencyOrder(cases:any[]){
  const byEncf=new Map<string,any>(); for(const c of cases) byEncf.set(c.ENCF,c);
  const emitted=new Set<string>(); const ordered:any[]=[];
  const visit=(c:any,chain:Set<string>)=>{ if(emitted.has(c.ENCF)||chain.has(c.ENCF))return; chain.add(c.ENCF);
    const ref=c.NCFModificado; if(ref&&byEncf.has(ref)&&!emitted.has(ref)) visit(byEncf.get(ref),chain);
    if(!emitted.has(c.ENCF)){emitted.add(c.ENCF);ordered.push(c);} };
  for(const c of cases) visit(c,new Set()); return ordered;
}
async function main(){
  const key=keyFromEnv(); if(!key){console.log('no key');process.exit(1);}
  console.log('=== DGII FINAL CLEAN PASS (RFCE first, then e-CF) ===');
  const token=await authenticate(key); console.log('AUTH OK. token length',token.length,'\n');
  const results=[];
  console.log('--- STEP 1: RFCE (4) -> fc. host ---');
  for(const c of getRfceCases()){ const encf=c.ENCF;
    try{ const res=await sendRfce(signXml(buildRfce(c),key),encf,key); const b=pb(res.body); const estado=b.estado||b.Estado||'';
      console.log(`  RFCE ${encf}  HTTP=${res.status} ${estado}${msgString(b.mensajes)?'  '+msgString(b.mensajes):''}`);
      results.push({kind:'RFCE',encf,status:res.status,estado,mensajes:b.mensajes});
    }catch(e:any){console.log(`  RFCE ${encf} ERROR ${e.message}`);results.push({kind:'RFCE',encf,error:String(e.message)});}
  }
  console.log('');
  const ecfCases=dependencyOrder(getEcfCases().filter((c:any)=>!RFCE_ENCFS.has(c.ENCF)));
  const acceptedEcf=new Set<string>();
  console.log(`--- STEP 2: e-CF (${ecfCases.length}) -> ecf. host (dependency-ordered) ---`);
  for(const c of ecfCases){ const encf=c.ENCF,type=String(c.TipoeCF),ref=c.NCFModificado;
    if(ref&&ecfCases.some((x:any)=>x.ENCF===ref)&&!acceptedEcf.has(ref)){
      console.log(`  ECF ${encf} t${type} SKIPPED: ref ${ref} not accepted`); results.push({kind:'ECF',encf,type,estado:'Skipped'}); continue; }
    try{ const r=await sendEcfAndPoll(signXml(buildEcf(c,type),key),encf,key,token);
      const is1209=Array.isArray(r.mensajes)&&r.mensajes.some((m:any)=>String(m.codigo)==='1209');
      const accepted=String(r.estado).toLowerCase()==='aceptado';
      console.log(`  ECF ${encf} t${type} ${accepted?'Aceptado':(is1209?'AlreadyAccepted(1209)':(r.estado||'(no verdict)'))}${msgString(r.mensajes)?'  '+msgString(r.mensajes):''}`);
      if(accepted||is1209) acceptedEcf.add(encf);
      results.push({kind:'ECF',encf,type,status:r.status,estado:accepted?'Aceptado':(is1209?'AlreadyAccepted':r.estado),held1209:is1209,mensajes:r.mensajes});
    }catch(e:any){console.log(`  ECF ${encf} ERROR ${e.message}`);results.push({kind:'ECF',encf,type,error:String(e.message)});}
  }
  console.log('\n=== SUMMARY ===');
  const ecf=results.filter(r=>r.kind==='ECF'); const rfce=results.filter(r=>r.kind==='RFCE');
  const ecfAcc=ecf.filter(r=>['aceptado','alreadyaccepted'].includes(String(r.estado).toLowerCase()));
  const rfceAcc=rfce.filter(r=>String(r.estado).toLowerCase()==='aceptado');
  const ecfRej=ecf.filter(r=>String(r.estado).toLowerCase()==='rechazado');
  console.log(`e-CF accepted: ${ecfAcc.length}/${ecf.length}  |  RFCE accepted: ${rfceAcc.length}/${rfce.length}`);
  for(const r of ecfRej) console.log(`  REJECTED ECF ${r.encf}: ${msgString(r.mensajes)}`);
  fs.writeFileSync('/home/user/workspace/dgii-engine/out/_final_results.json', JSON.stringify(results,null,2));
}
main().catch(e=>{console.log('FATAL',e);process.exit(99);});
