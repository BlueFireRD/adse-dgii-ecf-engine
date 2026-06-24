import * as fs from 'fs';
import { signXml, keyFromEnv, verifyXml } from './signer';
import { ENDPOINTS } from './dgiiClient';

async function main() {
  const key = keyFromEnv();
  if (!key) { console.log('no key'); process.exit(1); }

  const seedRes = await fetch(ENDPOINTS.semilla, { method: 'GET' });
  const seedXml = await seedRes.text();
  console.log('=== RAW SEED (HTTP', seedRes.status, ') ===');
  console.log(seedXml);
  fs.writeFileSync('/home/user/workspace/dgii-engine/out/_seed_raw.xml', seedXml);

  const signed = signXml(seedXml, key);
  console.log('\n=== SIGNED SEED ===');
  console.log(signed);
  fs.writeFileSync('/home/user/workspace/dgii-engine/out/_seed_signed.xml', signed);

  console.log('\n=== local verifyXml:', verifyXml(signed), '===');
}
main().catch(e => console.log('ERR', e));
