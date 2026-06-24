import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ValidationResult } from './types';

const XMLLINT = '/usr/bin/xmllint';
const SCHEMA_DIR = path.resolve(__dirname, '..', 'schemas');

export function schemaPathForEcf(type: string): string {
  return path.join(SCHEMA_DIR, `e-CF-${type}-v.1.0.xsd`);
}

export function schemaPathForRfce(): string {
  return path.join(SCHEMA_DIR, 'RFCE-32-v.1.0.xsd');
}

export function schemaPathForAcecf(): string {
  return path.join(SCHEMA_DIR, 'ACECF-v.1.0.xsd');
}

export function schemaPathForArecf(): string {
  return path.join(SCHEMA_DIR, 'ARECF-v.1.0.xsd');
}

/** Validate an XML file against an XSD using xmllint. */
export function validateFile(xmlPath: string, schemaPath: string, encf = ''): ValidationResult {
  try {
    execFileSync(XMLLINT, ['--noout', '--schema', schemaPath, xmlPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    return { encf, schema: path.basename(schemaPath), valid: true, errors: [] };
  } catch (e: any) {
    const stderr: string = (e.stderr ? e.stderr.toString() : '') || String(e.message || e);
    const errors = stderr
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.endsWith('fails to validate') && !l.endsWith('validates'));
    return { encf, schema: path.basename(schemaPath), valid: false, errors };
  }
}

/** Validate an XML string by writing it to a temp file first. */
export function validateXml(xml: string, schemaPath: string, encf = ''): ValidationResult {
  const tmp = path.join(os.tmpdir(), `dgii-validate-${process.pid}-${Date.now()}.xml`);
  fs.writeFileSync(tmp, xml, 'utf8');
  try {
    return validateFile(tmp, schemaPath, encf);
  } finally {
    fs.unlinkSync(tmp);
  }
}
