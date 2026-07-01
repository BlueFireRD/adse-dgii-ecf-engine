import * as fs from 'fs';
import PDFDocument from 'pdfkit';
import * as QRCode from 'qrcode';
import { CaseData } from './types';
import { sanitizeAndWarn } from './textSanitizer';

/** One row of out/paso4_qr.json (the Timbre data for a document). */
export interface QrRow {
  orden?: number;
  tipo: string;
  eNCF: string;
  montoTotal: string;
  totalITBIS: string;
  fechaEmision: string;
  fechaFirma: string;
  codigoSeguridad: string;
  qrURL: string;
}

/**
 * DATOS DEL EMISOR — ADSE (RNC 133470616).
 *
 * VERIFICADO contra la Oficina Virtual de la DGII el 26/06/2026:
 *   - Razón Social / Nombre: ADVANCE DATA SECURITY EXPERTS ADSE SRL (idéntico al padrón).
 *   - Domicilio fiscal: Calle 1, No. 4, Reparto Montero, Santiago de los Caballeros, Santiago.
 *
 * NO se toma de `ecf.RazonSocialEmisor` porque el dataset del Paso 4 trae el
 * placeholder de ejemplo "DOCUMENTOS ELECTRONICOS DE 02", que la DGII rechazó.
 */
const EMISOR = {
  razonSocial: 'ADVANCE DATA SECURITY EXPERTS ADSE SRL',
  nombreComercial: 'ADSE',
  rnc: '133470616',
  direccion: 'Calle 1, No. 4, Reparto Montero',
  ciudad: 'Santiago de los Caballeros, Santiago, República Dominicana',
  telefono: '829-730-7941',
  correo: 'info@adse-rd.com',
};

/** Tipo e-CF -> nombre en palabras (Ley 32-23 / Norma 06-2018). Columna I = "P". */
export const TIPO_NOMBRE: Record<string, string> = {
  '31': 'FACTURA DE CRÉDITO FISCAL ELECTRÓNICA',
  '32': 'FACTURA DE CONSUMO ELECTRÓNICA',
  '33': 'NOTA DE DÉBITO ELECTRÓNICA',
  '34': 'NOTA DE CRÉDITO ELECTRÓNICA',
  '41': 'COMPROBANTE DE COMPRAS ELECTRÓNICO',
  '43': 'COMPROBANTE PARA GASTOS MENORES ELECTRÓNICO',
  '44': 'COMPROBANTE DE REGÍMENES ESPECIALES ELECTRÓNICO',
  '45': 'COMPROBANTE GUBERNAMENTAL ELECTRÓNICO',
  '46': 'COMPROBANTE PARA EXPORTACIONES ELECTRÓNICO',
  '47': 'COMPROBANTE DE PAGOS AL EXTERIOR ELECTRÓNICO',
};

const LEYENDA = 'Representación Impresa de un Comprobante Fiscal Electrónico';

const PAGE = { margin: 40, width: 595.28, height: 841.89 };
const LEFT = PAGE.margin;
const RIGHT = PAGE.width - PAGE.margin; // 555.28
const CONTENT_W = RIGHT - LEFT;
const NAVY = '#1a3c6e';

/** Dominican money format: 1,234,567.89 (thousands separator + 2 decimals). */
function money(v: string | undefined): string {
  if (v === undefined || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Count item rows: NombreItem[n] present. */
function itemCount(ecf: CaseData): number {
  let n = 0;
  while (ecf[`NombreItem[${n + 1}]`] !== undefined) n++;
  return n;
}

/**
 * Build one Representación Impresa PDF for an e-CF, conforme a la Norma 06-2018:
 *   - Datos del emisor (razón social registrada + nombre comercial + RNC +
 *     domicilio fiscal) en la parte superior izquierda del encabezado.
 *   - Datos tributarios (tipo en palabras + e-NCF + fechas) en recuadro a la
 *     derecha del encabezado.
 *   - Datos del comprador en la parte inferior izquierda del encabezado.
 *   - Detalle de bienes/servicios al centro.
 *   - Totales al pie derecho.
 *   - Timbre (QR escaneable) + Código de Seguridad + Fecha de Firma + leyenda
 *     obligatoria al pie izquierdo.
 *
 * El bloque comprador se omite para tipo-32 consumo <250k (Timbre por
 * ConsultaTimbreFC), por la Norma.
 */
export async function buildRI(ecf: CaseData, qr: QrRow, outPath: string): Promise<void> {
  // Defensa de codificación: repara mojibake común y avisa sobre corrupción
  // irreparable. No altera texto válido ni datos ya enviados a la DGII.
  ecf = sanitizeAndWarn(ecf as any, `RI ${(ecf as any).ENCF || qr.eNCF}`) as CaseData;
  const tipo = ecf.TipoeCF || qr.tipo;
  const omitBuyer = qr.qrURL.includes('ConsultaTimbreFC');
  const qrPng = await QRCode.toBuffer(qr.qrURL, {
    type: 'png',
    width: 260,
    margin: 1,
    errorCorrectionLevel: 'M',
  });

  const doc = new PDFDocument({ size: 'A4', margin: PAGE.margin });
  const stream = fs.createWriteStream(outPath);
  doc.pipe(stream);

  // ===== ENCABEZADO: Emisor (izquierda) =====
  let y = PAGE.margin;
  const EM_W = 290;
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#000');
  doc.text(EMISOR.razonSocial, LEFT, y, { width: EM_W });
  y = doc.y + 1;
  if (EMISOR.nombreComercial) {
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(NAVY);
    doc.text(`Nombre Comercial: ${EMISOR.nombreComercial}`, LEFT, y, { width: EM_W });
    y = doc.y + 1;
  }
  doc.font('Helvetica').fontSize(9).fillColor('#000');
  const emLines = [
    `RNC: ${EMISOR.rnc}`,
    EMISOR.direccion,
    EMISOR.ciudad,
    [EMISOR.telefono ? `Tel.: ${EMISOR.telefono}` : '', EMISOR.correo].filter(Boolean).join('   '),
  ].filter((l) => l && l.trim() !== '');
  for (const line of emLines) doc.text(line, LEFT, doc.y, { width: EM_W });
  const emitterBottom = doc.y;

  // ===== ENCABEZADO: Datos tributarios (recuadro derecha) =====
  const boxX = 340;
  const boxW = RIGHT - boxX; // ~215
  const boxY = PAGE.margin;
  const boxH = 108;
  doc.lineWidth(1).rect(boxX, boxY, boxW, boxH).stroke(NAVY);
  let by = boxY + 8;
  // Tipo en palabras (columna I = "P": debe ir impreso en palabras)
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor(NAVY);
  doc.text(TIPO_NOMBRE[tipo] || `TIPO ${tipo}`, boxX + 8, by, { width: boxW - 16, align: 'center' });
  by = doc.y + 5;
  doc.moveTo(boxX + 8, by).lineTo(boxX + boxW - 8, by).lineWidth(0.5).stroke(NAVY);
  by += 6;
  const boxLine = (label: string, value: string, bold = false) => {
    doc.font('Helvetica').fontSize(7.5).fillColor('#555').text(label, boxX + 8, by, { width: boxW - 16 });
    by = doc.y;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 10.5 : 9).fillColor('#000')
      .text(value, boxX + 8, by, { width: boxW - 16 });
    by = doc.y + 3;
  };
  boxLine('e-NCF', qr.eNCF, true);
  boxLine('Fecha de Emisión', ecf.FechaEmision || qr.fechaEmision);
  if (ecf.FechaVencimientoSecuencia) boxLine('Válido hasta (venc. secuencia)', ecf.FechaVencimientoSecuencia);

  // Notas (33/34): la Norma 06-2018 exige indicar el e-NCF del comprobante modificado.
  if ((tipo === '33' || tipo === '34') && ecf.NCFModificado) {
    let my = boxY + boxH + 6;
    doc.font('Helvetica-Bold').fontSize(8).fillColor(NAVY)
      .text('Modifica al comprobante:', boxX, my, { width: boxW });
    my = doc.y + 1;
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#000')
      .text(ecf.NCFModificado, boxX, my, { width: boxW });
    if (ecf.FechaNCFModificado) {
      doc.font('Helvetica').fontSize(7.5).fillColor('#555')
        .text(`Fecha: ${ecf.FechaNCFModificado}`, boxX, doc.y + 1, { width: boxW });
    }
  }

  // ===== ENCABEZADO: Comprador (inferior izquierda) =====
  y = Math.max(emitterBottom, boxY + boxH) + 14;
  if (!omitBuyer) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor(NAVY).text('DATOS DEL COMPRADOR', LEFT, y);
    y = doc.y + 2;
    doc.font('Helvetica').fontSize(9).fillColor('#000');
    const buyerLines = [
      ecf.RNCComprador ? `RNC/Cédula: ${ecf.RNCComprador}` : '',
      ecf.RazonSocialComprador ? `Razón Social: ${ecf.RazonSocialComprador}` : '',
      ecf.DireccionComprador ? `Dirección: ${ecf.DireccionComprador}` : '',
    ].filter((l) => l);
    for (const line of buyerLines) doc.text(line, LEFT, doc.y, { width: 330 });
    y = doc.y + 12;
  } else {
    doc.font('Helvetica-Oblique').fontSize(8.5).fillColor('#555')
      .text('Factura de Consumo Electrónica — Consumidor Final', LEFT, y);
    y = doc.y + 12;
  }

  // ===== DETALLE DE BIENES O SERVICIOS (centro) =====
  const cols = {
    num: { x: LEFT, w: 26 },
    nombre: { x: LEFT + 28, w: 190 },
    umed: { x: LEFT + 220, w: 46 },
    cant: { x: 311, w: 58 },
    precio: { x: 371, w: 88 },
    monto: { x: 461, w: RIGHT - 461 },
  };
  const headerH = 16;
  doc.rect(LEFT, y, CONTENT_W, headerH).fill(NAVY);
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#fff');
  const cellY = y + 4.5;
  doc.text('#', cols.num.x + 3, cellY, { width: cols.num.w - 4, lineBreak: false });
  doc.text('DESCRIPCIÓN', cols.nombre.x, cellY, { width: cols.nombre.w, lineBreak: false });
  doc.text('U.M.', cols.umed.x, cellY, { width: cols.umed.w - 2, align: 'center', lineBreak: false });
  doc.text('CANT.', cols.cant.x, cellY, { width: cols.cant.w - 4, align: 'right', lineBreak: false });
  doc.text('PRECIO UNIT.', cols.precio.x, cellY, { width: cols.precio.w - 4, align: 'right', lineBreak: false });
  doc.text('MONTO', cols.monto.x, cellY, { width: cols.monto.w - 4, align: 'right', lineBreak: false });
  y += headerH;

  const rowH = 15;
  const n = itemCount(ecf);
  for (let i = 1; i <= n; i++) {
    if (i % 2 === 0) doc.rect(LEFT, y, CONTENT_W, rowH).fill('#f2f5fa');
    doc.fillColor('#000').font('Helvetica').fontSize(8.5);
    const ry = y + 4;
    const nombre = ecf[`NombreItem[${i}]`] || '';
    const desc = ecf[`DescripcionItem[${i}]`];
    const label = desc ? `${nombre} — ${desc}` : nombre;
    doc.text(String(i), cols.num.x + 3, ry, { width: cols.num.w - 4, lineBreak: false });
    doc.text(label, cols.nombre.x, ry, { width: cols.nombre.w, lineBreak: false, ellipsis: true });
    doc.text(ecf[`UnidadMedida[${i}]`] || '', cols.umed.x, ry, { width: cols.umed.w - 2, align: 'center', lineBreak: false });
    doc.text(money(ecf[`CantidadItem[${i}]`]), cols.cant.x, ry, { width: cols.cant.w - 4, align: 'right', lineBreak: false });
    doc.text(money(ecf[`PrecioUnitarioItem[${i}]`]), cols.precio.x, ry, { width: cols.precio.w - 4, align: 'right', lineBreak: false });
    doc.text(money(ecf[`MontoItem[${i}]`]), cols.monto.x, ry, { width: cols.monto.w - 4, align: 'right', lineBreak: false });
    y += rowH;
  }
  doc.moveTo(LEFT, y).lineTo(RIGHT, y).lineWidth(0.5).stroke('#cccccc');
  y += 12;

  // ===== TOTALES (pie derecho) =====
  const labelX = 320;
  const labelW = 150;
  const valX = 471;
  const valW = RIGHT - valX;
  const totalLine = (label: string, value: string) => {
    doc.font('Helvetica').fontSize(9).fillColor('#000');
    doc.text(label, labelX, y, { width: labelW, align: 'right', lineBreak: false });
    doc.text(value, valX, y, { width: valW, align: 'right', lineBreak: false });
    y += 14;
  };
  if (ecf.MontoGravadoTotal) totalLine('Monto Gravado:', money(ecf.MontoGravadoTotal));
  if (ecf.MontoExento) totalLine('Monto Exento:', money(ecf.MontoExento));
  if (qr.totalITBIS && qr.totalITBIS !== '') totalLine('Total ITBIS:', money(qr.totalITBIS));
  doc.rect(labelX, y - 2, RIGHT - labelX, 20).fill(NAVY);
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#fff');
  doc.text('MONTO TOTAL:', labelX + 4, y + 3, { width: labelW - 8, align: 'right', lineBreak: false });
  doc.text(`RD$ ${money(ecf.MontoTotal || qr.montoTotal)}`, valX - 6, y + 3, { width: valW + 2, align: 'right', lineBreak: false });
  y += 24;

  // ===== TIMBRE: QR (pie izquierdo) + Código de Seguridad + Fecha de Firma + leyenda =====
  const footerH = 140;
  const footerY = Math.max(y + 14, PAGE.height - PAGE.margin - footerH);
  doc.moveTo(LEFT, footerY).lineTo(RIGHT, footerY).lineWidth(0.5).stroke('#cccccc');
  const qrSize = 120;
  const qrY = footerY + 12;
  doc.image(qrPng, LEFT, qrY, { width: qrSize, height: qrSize });

  const infoX = LEFT + qrSize + 18;
  const infoW = RIGHT - infoX;
  let iy = qrY + 2;
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#000').text('Código de Seguridad:', infoX, iy, { width: infoW });
  iy = doc.y;
  doc.font('Helvetica').fontSize(11).text(qr.codigoSeguridad, infoX, iy, { width: infoW });
  iy = doc.y + 6;
  doc.font('Helvetica-Bold').fontSize(9).text('Fecha de Firma:', infoX, iy, { width: infoW });
  iy = doc.y;
  doc.font('Helvetica').fontSize(10).text(qr.fechaFirma, infoX, iy, { width: infoW });
  iy = doc.y + 12;
  doc.font('Helvetica-Oblique').fontSize(9).fillColor('#333').text(LEYENDA, infoX, iy, { width: infoW });

  doc.end();
  await new Promise<void>((resolve, reject) => {
    stream.on('finish', () => resolve());
    stream.on('error', reject);
  });
}
