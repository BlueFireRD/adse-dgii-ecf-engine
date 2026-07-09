/**
 * signDeclaracion.ts — firma la Declaración Jurada (Paso 13 de la certificación
 * DGII) con el certificado de ADSE, incrustando la firma dentro del XML.
 *
 * Uso (PowerShell):
 *   $env:P12_PATH="C:\ruta\a\22818615_identity.p12"
 *   $env:P12_PASSWORD = ...   (nunca se escribe en claro; ver instrucciones)
 *   npx ts-node src/signDeclaracion.ts <entrada.xml> <salida.xml>
 *
 * La contraseña se lee SOLO del entorno; este script nunca la imprime ni la guarda.
 */
import * as fs from 'fs';
import { keyFromEnv, signXml, verifyXml } from './signer';

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) {
  console.error('Uso: npx ts-node src/signDeclaracion.ts <entrada.xml> <salida.xml>');
  process.exit(1);
}

const key = keyFromEnv();
if (!key) {
  console.error(
    'ERROR: no hay certificado configurado. Define P12_PATH (o P12_BASE64) y P12_PASSWORD en el entorno.'
  );
  process.exit(1);
}

const xml = fs.readFileSync(inPath, 'utf8');
const signed = signXml(xml, key);
fs.writeFileSync(outPath, signed, 'utf8');

// Verificación local de sanidad: la firma recién puesta debe validar.
let ok = false;
try {
  ok = verifyXml(signed);
} catch {
  ok = false;
}

console.log(`Firmado -> ${outPath} (${signed.length} bytes)`);
console.log(`Verificacion local de la firma: ${ok ? 'OK ✓' : 'FALLO ✗'}`);
if (!ok) {
  console.error('ADVERTENCIA: la firma no verifico localmente. No subas este archivo; avisame.');
  process.exit(2);
}
