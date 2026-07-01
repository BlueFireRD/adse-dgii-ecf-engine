import * as path from 'path';
import { parseXsd } from './xsd';
import { CaseData } from './types';
import { BuildContext, buildChildrenPublic } from './buildShared';
import { sanitizeAndWarn } from './textSanitizer';

const SCHEMA_DIR = path.resolve(__dirname, '..', 'schemas');

function nowDgiiTimestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Build an unsigned e-CF XML document for the given case + type. */
export function buildEcf(data: CaseData, type: string): string {
  const xsdFile = `e-CF-${type}-v.1.0.xsd`;
  const root = parseXsd(path.join(SCHEMA_DIR, xsdFile));
  // Defensa de codificación: repara mojibake común y avisa sobre corrupción
  // irreparable antes de construir y firmar el XML. No altera texto válido.
  const cleanData = sanitizeAndWarn(data as any, `e-CF ${(data as any).ENCF || type}`) as CaseData;
  const ctx: BuildContext = {
    data: cleanData,
    synth: { FechaHoraFirma: nowDgiiTimestamp() },
  };
  const inner = buildChildrenPublic(root, [], [], ctx);
  const attrs = `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="${xsdFile}"`;
  return `<?xml version="1.0" encoding="UTF-8"?><${root.name} ${attrs}>${inner}</${root.name}>`;
}
