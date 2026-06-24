import { Paso4Plan } from './dataset';

/**
 * Build the DGII Timbre Electrónico (QR) URL for a Paso-4 document.
 *
 * The per-type URL structure (standard e-CF, tipo-43 without RncComprador, and
 * consumo <250k via fc.dgii.gov.do/ConsultaTimbreFC without RncComprador or
 * FechaFirma) is already encoded in the plan's `qr` field — it is the FUENTE DE
 * VERDAD. This function only substitutes the two runtime placeholders:
 *
 *   {COD_SEG}     -> codigoSeguridad (first 6 chars of the SignatureValue)
 *   {FECHA_FIRMA} -> fechaFirma (dd-MM-yyyy HH:mm:ss), with the space encoded
 *                    as %20 so the URL stays well-formed.
 *
 * Consumo templates carry no {FECHA_FIRMA}, so the fechaFirma argument is
 * simply unused for them.
 */
export function buildQrUrl(
  template: string,
  codigoSeguridad: string,
  fechaFirma?: string
): string {
  let url = template.replace('{COD_SEG}', codigoSeguridad);
  if (url.includes('{FECHA_FIRMA}')) {
    const encoded = (fechaFirma || '').replace(/ /g, '%20');
    url = url.replace('{FECHA_FIRMA}', encoded);
  }
  return url;
}

/** Convenience wrapper: build the QR URL straight from a plan row. */
export function qrForPlan(
  plan: Paso4Plan,
  codigoSeguridad: string,
  fechaFirma?: string
): string {
  return buildQrUrl(plan.qr, codigoSeguridad, fechaFirma);
}

/**
 * Extract the real signing timestamp (FechaHoraFirma) from a built/signed e-CF
 * so the QR's FechaFirma matches the value actually inside the document. DGII's
 * Timbre validation (Paso 6) compares them. Returns '' if absent (consumo
 * summaries don't expose it and don't need it).
 */
export function extractFechaFirma(xml: string): string {
  const m = xml.match(/<FechaHoraFirma>([^<]*)<\/FechaHoraFirma>/);
  return m ? m[1].trim() : '';
}
