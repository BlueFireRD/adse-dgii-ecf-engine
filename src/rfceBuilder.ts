import * as path from 'path';
import * as crypto from 'crypto';
import { parseXsd } from './xsd';
import { CaseData } from './types';
import { BuildContext, buildChildrenPublic } from './buildShared';

const SCHEMA_DIR = path.resolve(__dirname, '..', 'schemas');
const RFCE_XSD = 'RFCE-32-v.1.0.xsd';

/**
 * The CodigoSeguridadeCF is the 6-char security code DGII derives from the
 * signature value. Pre-submission we synthesize a deterministic 6-char code
 * (DGII assigns the authoritative one on acceptance). It only needs to match
 * the `.{6}` pattern for local XSD validation.
 */
export function securityCode(data: CaseData): string {
  const seed = (data.CasoPrueba || data.ENCF || '') + (data.RNCEmisor || '');
  const hash = crypto.createHash('sha256').update(seed).digest('base64');
  return hash.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).padEnd(6, '0');
}

/** Build an unsigned RFCE summary XML document for a tipo-32 (<250k) case. */
export function buildRfce(data: CaseData, code?: string): string {
  const root = parseXsd(path.join(SCHEMA_DIR, RFCE_XSD));
  const ctx: BuildContext = {
    data,
    // When a code is supplied it MUST be the first 6 chars of the SignatureValue
    // of the signed full e-CF invoice for this same eNCF (DGII binds them).
    // Otherwise fall back to the deterministic synthetic code (local-XSD only).
    synth: { CodigoSeguridadeCF: code || securityCode(data) },
  };
  const inner = buildChildrenPublic(root, [], [], ctx);
  const attrs = `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="${RFCE_XSD}"`;
  return `<?xml version="1.0" encoding="UTF-8"?><${root.name} ${attrs}>${inner}</${root.name}>`;
}
