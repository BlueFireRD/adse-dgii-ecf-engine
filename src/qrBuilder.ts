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

/** Extract the text content of a single XML element by tag name. Returns '' if absent. */
export function xmlTag(xml: string, name: string): string {
  const m = xml.match(new RegExp('<' + name + '>([^<]*)</' + name + '>'));
  return m ? m[1] : '';
}

const QR_AMB = (environment?: string): string => {
  const e = (environment || process.env.DGII_ENV || '').toLowerCase();
  return (e === 'ecf' || e === 'prod' || e === 'produccion' || e === 'production') ? 'ecf' : 'certecf';
};

/**
 * Build the ConsultaTimbre QR URL for a standard e-CF (tipos 31, 33, 34, 41, 43, 44, 45, 46, 47).
 * RncComprador is omitted for tipo-43 (consumo factura) — pass undefined to skip it.
 */
export function buildEcfQrUrl(opts: {
  environment?: string;
  rncEmisor: string;
  rncComprador?: string;
  encf: string;
  fechaEmision: string;
  montoTotal: string;
  fechaFirma: string;
  codigoSeguridad: string;
}): string {
  const amb = QR_AMB(opts.environment);
  const p = new URLSearchParams();
  p.set('RncEmisor', opts.rncEmisor);
  if (opts.rncComprador) p.set('RncComprador', opts.rncComprador);
  p.set('ENCF', opts.encf);
  p.set('FechaEmision', opts.fechaEmision);
  p.set('MontoTotal', opts.montoTotal);
  p.set('FechaFirma', opts.fechaFirma);
  p.set('CodigoSeguridad', opts.codigoSeguridad);
  return `https://ecf.dgii.gov.do/${amb}/ConsultaTimbre?` + p.toString().replace(/\+/g, '%20');
}

/**
 * Build the ConsultaTimbreFC QR URL for consumo <250k (tipo-32 RFCE).
 * This endpoint lives on fc.dgii.gov.do and does not include FechaFirma or RncComprador.
 */
export function buildFcQrUrl(opts: {
  environment?: string;
  rncEmisor: string;
  encf: string;
  montoTotal: string;
  codigoSeguridad: string;
}): string {
  const amb = QR_AMB(opts.environment);
  const p = new URLSearchParams();
  p.set('RncEmisor', opts.rncEmisor);
  p.set('ENCF', opts.encf);
  p.set('MontoTotal', opts.montoTotal);
  p.set('CodigoSeguridad', opts.codigoSeguridad);
  return `https://fc.dgii.gov.do/${amb}/ConsultaTimbreFC?` + p.toString();
}
