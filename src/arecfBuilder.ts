import { escapeXml } from './buildShared';

const ARECF_XSD = 'ARECF-v.1.0.xsd';

/**
 * Inputs for an Acuse de Recibo (ARECF). Mirrors the flat
 * <DetalleAcusedeRecibo> structure of ARECF-v.1.0.xsd.
 *   - estado 0 = e-CF Recibido (motivo omitted)
 *   - estado 1 = e-CF No Recibido (motivo 1..4 required)
 *       1 Error de especificación | 2 Error de Firma Digital |
 *       3 Envío duplicado        | 4 RNC Comprador no corresponde
 */
export interface ArecfInput {
  /** RNC of the e-CF EMITTER (the party that sent us the e-CF). */
  rncEmisor: string;
  /** RNC of the BUYER/receptor (ADSE, 133470616). */
  rncComprador: string;
  /** The e-CF being acknowledged, e.g. E310000000001. */
  encf: string;
  /** 0 = Recibido, 1 = No Recibido. */
  estado: 0 | 1;
  /** Required only when estado=1; omitted entirely when estado=0. */
  motivo?: 1 | 2 | 3 | 4;
}

/** Current local time formatted as DGII's dd-MM-yyyy HH:mm:ss. */
function nowDgiiTimestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Build an unsigned ARECF document. Fields are emitted in exact schema order;
 * CodigoMotivoNoRecibido is included only for estado=1. Output is declaration-
 * prefixed and single-line (the signer strips the declaration and re-compacts).
 */
export function buildArecf(input: ArecfInput): string {
  const parts: string[] = [];
  parts.push(`<Version>1.0</Version>`);
  parts.push(`<RNCEmisor>${escapeXml(String(input.rncEmisor))}</RNCEmisor>`);
  parts.push(`<RNCComprador>${escapeXml(String(input.rncComprador))}</RNCComprador>`);
  parts.push(`<eNCF>${escapeXml(String(input.encf))}</eNCF>`);
  parts.push(`<Estado>${input.estado}</Estado>`);
  if (input.estado === 1 && input.motivo) {
    parts.push(`<CodigoMotivoNoRecibido>${input.motivo}</CodigoMotivoNoRecibido>`);
  }
  parts.push(`<FechaHoraAcuseRecibo>${nowDgiiTimestamp()}</FechaHoraAcuseRecibo>`);

  const attrs = `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="${ARECF_XSD}"`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<ARECF ${attrs}>` +
    `<DetalleAcusedeRecibo>${parts.join('')}</DetalleAcusedeRecibo>` +
    `</ARECF>`
  );
}
