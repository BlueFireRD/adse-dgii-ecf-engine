import { escapeXml } from './buildShared';

const ACECF_XSD = 'ACECF-v.1.0.xsd';

/**
 * A single Aprobación Comercial (Paso 3). Mirrors the flat
 * <DetalleAprobacionComercial> structure of ACECF-v.1.0.xsd.
 *   - Estado 1 = the underlying e-CF was Aceptado (no rejection reason)
 *   - Estado 2 = the underlying e-CF was Rechazado (DetalleMotivoRechazo required)
 */
export interface AcecfCase {
  /** RNC of the e-CF EMITTER (the other party). */
  RNCEmisor: string;
  /** The e-CF being approved, e.g. E310000000001. */
  eNCF: string;
  /** dd-MM-yyyy — MUST match the original e-CF FechaEmision. */
  FechaEmision: string;
  /** Decimal with 2 fraction digits — MUST match the original e-CF MontoTotal. */
  MontoTotal: string;
  /** RNC of the BUYER/receptor giving the commercial approval. */
  RNCComprador: string;
  /** 1 = Aceptado, 2 = Rechazado. */
  Estado: string;
  /** Required only when Estado=2; omitted entirely when Estado=1. */
  DetalleMotivoRechazo?: string;
  /** dd-MM-yyyy HH:mm:ss; synthesized as "now" when absent. */
  FechaHoraAprobacionComercial?: string;
}

/** Current local time formatted as DGII's dd-MM-yyyy HH:mm:ss. */
function nowDgiiTimestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Build an unsigned ACECF document. Fields are emitted in exact schema order;
 * DetalleMotivoRechazo is included only for Estado=2. Output is declaration-
 * prefixed and single-line (the signer strips the declaration and re-compacts).
 */
export function buildAcecf(c: AcecfCase): string {
  const estado = String(c.Estado).trim();
  const fechaHora = c.FechaHoraAprobacionComercial || nowDgiiTimestamp();

  const parts: string[] = [];
  parts.push(`<Version>1.0</Version>`);
  parts.push(`<RNCEmisor>${escapeXml(c.RNCEmisor)}</RNCEmisor>`);
  parts.push(`<eNCF>${escapeXml(c.eNCF)}</eNCF>`);
  parts.push(`<FechaEmision>${escapeXml(c.FechaEmision)}</FechaEmision>`);
  parts.push(`<MontoTotal>${escapeXml(c.MontoTotal)}</MontoTotal>`);
  parts.push(`<RNCComprador>${escapeXml(c.RNCComprador)}</RNCComprador>`);
  parts.push(`<Estado>${escapeXml(estado)}</Estado>`);
  if (estado === '2' && c.DetalleMotivoRechazo) {
    parts.push(`<DetalleMotivoRechazo>${escapeXml(c.DetalleMotivoRechazo)}</DetalleMotivoRechazo>`);
  }
  parts.push(`<FechaHoraAprobacionComercial>${escapeXml(fechaHora)}</FechaHoraAprobacionComercial>`);

  const attrs = `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="${ACECF_XSD}"`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<ACECF ${attrs}>` +
    `<DetalleAprobacionComercial>${parts.join('')}</DetalleAprobacionComercial>` +
    `</ACECF>`
  );
}
