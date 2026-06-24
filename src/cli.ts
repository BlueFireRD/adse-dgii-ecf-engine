import * as fs from 'fs';
import * as path from 'path';
import { getEcfCases, getRfceCases, getAcecfCases, getAcecfCase, getPaso4Cases } from './dataset';
import { buildEcf } from './xmlBuilder';
import { buildRfce } from './rfceBuilder';
import { buildAcecf, AcecfCase } from './acecfBuilder';
import { schemaPathForEcf, schemaPathForRfce, schemaPathForAcecf, validateFile } from './validator';
import { generateEphemeralKey, keyFromEnv, signXml, verifyXml, KeyMaterial } from './signer';
import { sendAprobacion } from './dgiiClient';
import { checkCase, CheckIssue } from './checks';
import { ValidationResult } from './types';

const OUT_DIR = path.resolve(__dirname, '..', 'out');

interface Row extends ValidationResult {
  kind: 'ECF' | 'RFCE' | 'ACECF';
  verified: boolean;
}

/** Resolve the real P12 key or an ephemeral fallback for offline pipelines. */
function resolveKey(): { key: KeyMaterial; source: string } {
  const envKey = keyFromEnv();
  if (envKey) return { key: envKey, source: `P12 (${process.env.P12_PATH})` };
  return { key: generateEphemeralKey(), source: 'ephemeral self-signed (no P12_PATH set)' };
}

function ensureOutDir(): void {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
}

function validateAll(): void {
  ensureOutDir();

  let key: KeyMaterial;
  let keySource: string;
  try {
    ({ key, source: keySource } = resolveKey());
  } catch (e: any) {
    console.error('Key load failed:', e.message);
    process.exit(1);
    return;
  }

  const rows: Row[] = [];
  const checkIssues: CheckIssue[] = [];

  for (const c of getEcfCases()) {
    const encf = c.ENCF;
    const type = c.TipoeCF;
    checkIssues.push(...checkCase(c));
    const signed = signXml(buildEcf(c, type), key);
    const file = path.join(OUT_DIR, `${encf}.xml`);
    fs.writeFileSync(file, signed, 'utf8');
    const res = validateFile(file, schemaPathForEcf(type), encf);
    rows.push({ ...res, kind: 'ECF', verified: safeVerify(signed) });
  }

  for (const c of getRfceCases()) {
    const encf = c.ENCF;
    const signed = signXml(buildRfce(c), key);
    const file = path.join(OUT_DIR, `${encf}_rfce.xml`);
    fs.writeFileSync(file, signed, 'utf8');
    const res = validateFile(file, schemaPathForRfce(), encf);
    rows.push({ ...res, kind: 'RFCE', verified: safeVerify(signed) });
  }

  for (const c of getAcecfCases()) {
    const encf = c.eNCF;
    const signed = signXml(buildAcecf(c), key);
    const file = path.join(OUT_DIR, `${encf}_acecf.xml`);
    fs.writeFileSync(file, signed, 'utf8');
    const res = validateFile(file, schemaPathForAcecf(), encf);
    rows.push({ ...res, kind: 'ACECF', verified: safeVerify(signed) });
  }

  rows.push(...paso4Rows(key));

  printTable(rows, keySource);

  console.log(`\nArithmetic checks: ${checkIssues.length === 0 ? 'PASS (all reconciled)' : checkIssues.length + ' ISSUE(S)'}`);
  for (const it of checkIssues) {
    console.log(`   [${it.encf}] ${it.rule}: ${it.detail}`);
  }

  const failed = rows.filter((r) => !r.valid);
  if (failed.length) {
    console.log('\nFAILURE DETAILS:');
    for (const r of failed) {
      console.log(`\n[${r.encf}] ${r.schema}`);
      for (const e of r.errors) console.log('   ' + e);
    }
  }
  process.exit(failed.length === 0 && checkIssues.length === 0 ? 0 : 1);
}

/**
 * Build + sign + XSD-validate the 25 Paso-4 simulation documents. Consumo rows
 * (<250k) contribute two XSD checks each: the FULL invoice (e-CF-32) and its
 * RFCE summary. Re-uses the existing builders/signer; no network.
 */
function paso4Rows(key: KeyMaterial): Row[] {
  const out: Row[] = [];
  for (const c of getPaso4Cases()) {
    if (c.isConsumo) {
      const full = signXml(buildEcf(c.ecf, '32'), key);
      out.push({
        ...validateFile(writePaso4Tmp(full, `${c.plan.nuevo_encf}_full`), schemaPathForEcf('32'), c.plan.nuevo_encf),
        kind: 'ECF',
        verified: safeVerify(full),
      });
      const rfce = signXml(buildRfce(c.rfce!, 'ABC123'), key);
      out.push({
        ...validateFile(writePaso4Tmp(rfce, `${c.plan.nuevo_encf}_rfce`), schemaPathForRfce(), c.plan.nuevo_encf),
        kind: 'RFCE',
        verified: safeVerify(rfce),
      });
    } else {
      const signed = signXml(buildEcf(c.ecf, c.plan.tipo), key);
      out.push({
        ...validateFile(writePaso4Tmp(signed, c.plan.nuevo_encf), schemaPathForEcf(c.plan.tipo), c.plan.nuevo_encf),
        kind: 'ECF',
        verified: safeVerify(signed),
      });
    }
  }
  return out;
}

function writePaso4Tmp(xml: string, name: string): string {
  ensureOutDir();
  const file = path.join(OUT_DIR, `paso4_${name}.xml`);
  fs.writeFileSync(file, xml, 'utf8');
  return file;
}

/** validate-paso4 — XSD-validate the 25 Paso-4 documents (offline). */
function validatePaso4(): void {
  const { key, source } = resolveKey();
  const rows = paso4Rows(key);
  printTable(rows, source);
  const failed = rows.filter((r) => !r.valid);
  if (failed.length) {
    console.log('\nFAILURE DETAILS:');
    for (const r of failed) {
      console.log(`\n[${r.encf}] ${r.schema}`);
      for (const e of r.errors) console.log('   ' + e);
    }
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

/** Resolve ACECF cases for a CLI subcommand: one eNCF if given, else all. */
function acecfCasesForArg(encf?: string): AcecfCase[] {
  if (encf) {
    const c = getAcecfCase(encf);
    if (!c) {
      console.error(`No ACECF case derivable for eNCF ${encf}`);
      process.exit(1);
    }
    return [c];
  }
  return getAcecfCases();
}

/** gen-aprobacion [encf] — build + sign ACECF, write to out/, print first one. */
function genAprobacion(encf?: string): void {
  ensureOutDir();
  const { key, source } = resolveKey();
  console.log(`Signing key: ${source}`);
  const cases = acecfCasesForArg(encf);
  for (const c of cases) {
    const signed = signXml(buildAcecf(c), key);
    const file = path.join(OUT_DIR, `${c.eNCF}_acecf.xml`);
    fs.writeFileSync(file, signed, 'utf8');
    console.log(`  ACECF ${c.eNCF}  Estado=${c.Estado}  -> ${file}`);
  }
  if (cases.length === 1) {
    console.log('\n' + signXml(buildAcecf(cases[0]), key));
  }
}

/** validate-aprobacion [encf] — build + sign + XSD-validate ACECF. */
function validateAprobacion(encf?: string): void {
  const { key, source } = resolveKey();
  console.log(`Signing key: ${source}`);
  const cases = acecfCasesForArg(encf);
  const rows: Row[] = [];
  for (const c of cases) {
    const signed = signXml(buildAcecf(c), key);
    const res = validateFile(writeTmp(signed, c.eNCF), schemaPathForAcecf(), c.eNCF);
    rows.push({ ...res, kind: 'ACECF', verified: safeVerify(signed) });
  }
  printTable(rows, source);
  const failed = rows.filter((r) => !r.valid);
  if (failed.length) {
    console.log('\nFAILURE DETAILS:');
    for (const r of failed) {
      console.log(`\n[${r.encf}] ${r.schema}`);
      for (const e of r.errors) console.log('   ' + e);
    }
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

/** send-aprobacion <encf> — build + sign + submit one ACECF to DGII. */
async function sendAprobacionCmd(encf?: string): Promise<void> {
  if (!encf) {
    console.error('Usage: send-aprobacion <encf>');
    process.exit(1);
  }
  const envKey = keyFromEnv();
  if (!envKey) {
    console.error('No P12 configured; set P12_PATH and P12_PASSWORD to submit to DGII.');
    process.exit(1);
    return;
  }
  const c = acecfCasesForArg(encf)[0];
  const signed = signXml(buildAcecf(c), envKey);
  const res = await sendAprobacion(signed, c.eNCF, envKey);
  console.log(`ACECF ${c.eNCF}  HTTP=${res.status}`);
  console.log(res.body);
  process.exit(res.status >= 200 && res.status < 300 ? 0 : 1);
}

function writeTmp(xml: string, encf: string): string {
  ensureOutDir();
  const file = path.join(OUT_DIR, `${encf}_acecf.xml`);
  fs.writeFileSync(file, xml, 'utf8');
  return file;
}

function safeVerify(signed: string): boolean {
  try {
    return verifyXml(signed);
  } catch {
    return false;
  }
}

function printTable(rows: Row[], keySource: string) {
  const pass = rows.filter((r) => r.valid).length;
  console.log('\nDGII e-CF / RFCE / ACECF — validation');
  console.log(`Signing key: ${keySource}`);
  console.log('='.repeat(60));
  console.log('KIND  ENCF                SCHEMA              XSD     SIG');
  console.log('-'.repeat(60));
  for (const r of rows) {
    const v = r.valid ? 'PASS' : 'FAIL';
    const sg = r.verified ? 'ok' : 'x';
    console.log(
      `${r.kind.padEnd(5)} ${r.encf.padEnd(19)} ${r.schema.padEnd(19)} ${v.padEnd(7)} ${sg}`
    );
  }
  console.log('='.repeat(60));
  console.log(`RESULT: ${pass}/${rows.length} PASS`);
}

function dispatch(): void {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case undefined:
    case 'validate-all':
      validateAll();
      break;
    case 'validate-paso4':
      validatePaso4();
      break;
    case 'gen-aprobacion':
      genAprobacion(arg);
      break;
    case 'validate-aprobacion':
      validateAprobacion(arg);
      break;
    case 'send-aprobacion':
      sendAprobacionCmd(arg).catch((e) => {
        console.error('FATAL', e.message || e);
        process.exit(99);
      });
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      console.error('Commands: validate-all | validate-paso4 | gen-aprobacion [encf] | validate-aprobacion [encf] | send-aprobacion <encf>');
      process.exit(1);
  }
}

dispatch();
