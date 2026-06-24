import * as fs from 'fs';
import PDFDocument from 'pdfkit';
import * as QRCode from 'qrcode';
import { CaseData } from './types';

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

/** Tipo e-CF -> nombre en palabras (Ley 32-23 / Norma 06-2018). */
export const TIPO_NOMBRE: Record<string, string> = {
  '31': 'CRÉDITO FISCAL',
  '32': 'FACTURA DE CONSUMO ELECTRÓNICA',
  '33': 'NOTA DE DÉBITO ELECTRÓNICA',
  '34': 'NOTA DE CRÉDITO ELECTRÓNICA',
  '41': 'COMPRAS',
  '43': 'GASTOS MENORES',
  '44': 'REGÍMENES ESPECIALES',
  '45': 'GUBERNAMENTAL',
  '46': 'EXPORTACIONES',
  '47': 'PAGOS AL EXTERIOR',
};

const LEYENDA = 'Representación Impresa de un Comprobante Fiscal Electrónico';

const PAGE = { margin: 40, width: 595.28, height: 841.89 };
const LEFT = PAGE.margin;
const RIGHT = PAGE.width - PAGE.margin; // 555.28
const CONTENT_W = RIGHT - LEFT;

/** Dominican money format: 1,234,567.89 (thousands separator + 2 decimals). */
function money(v: string | undefined): string {
  if (v === undefined || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Count item rows: NumeroLinea[n] present and NombreItem[n] present. */
function itemCount(ecf: CaseData): number {
  let n = 0;
  while (ecf[`NombreItem[${n + 1}]`] !== undefined) n++;
  return n;
}

/**
 * Build one Representación Impresa PDF for an e-CF.
 *
 * Pure builder: reads only the passed `ecf` (CaseData) and `qr` (Timbre row),
 * embeds the exact `qr.qrURL` as a scannable QR, and writes a single A4 page to
 * `outPath`. No global state, no side effects beyond writing that file —
 * integrable as-is into the CRM.
 *
 * The buyer block is omitted for a tipo-32 consumo <250k (its Timbre uses the
 * ConsultaTimbreFC endpoint), per the Norma.
 */
export async function buildRI(ecf: CaseData, qr: QrRow, outPath: string): Promise<void> {
  const tipo = ecf.TipoeCF || qr.tipo;
  const omitBuyer = qr.qrURL.includes('ConsultaTimbreFC');
  const qrPng = await QRCode.toBuffer(qr.qrURL, {
    type: 'png',
    width: 130,
    margin: 1,
    errorCorrectionLevel: 'M',
  });

  const doc = new PDFDocument({ size: 'A4', margin: PAGE.margin });
  const stream = fs.createWriteStream(outPath);
  doc.pipe(stream);

  // ---- Emitter block (left) ----
  let y = PAGE.margin;
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#000');
  doc.text(ecf.RazonSocialEmisor || '', LEFT, y, { width: 300 });
  y = doc.y + 1;
  doc.font('Helvetica').fontSize(9);
  const phones = [ecf['TelefonoEmisor[1]'], ecf['TelefonoEmisor[2]']].filter(Boolean).join(' / ');
  const emLines = [
    `RNC: ${ecf.RNCEmisor || ''}`,
    ecf.DireccionEmisor || '',
    [ecf.Municipio, ecf.Provincia].filter(Boolean).join(', '),
  ];
  if (phones) emLines.push(`Tel.: ${phones}`);
  if (ecf.CorreoEmisor) emLines.push(ecf.CorreoEmisor);
  for (const line of emLines.filter((l) => l && l.trim() !== '')) {
    doc.text(line, LEFT, doc.y, { width: 300 });
  }
  const emitterBottom = doc.y;

  // ---- Identification box (right) ----
  const boxX = 360;
  const boxW = RIGHT - boxX; // ~195
  const boxY = PAGE.margin;
  const boxH = 96;
  doc.lineWidth(1).rect(boxX, boxY, boxW, boxH).stroke('#444');
  let by = boxY + 7;
  const boxLine = (label: string, value: string, bold = false) => {
    doc.font('Helvetica').fontSize(7.5).fillColor('#555').text(label, boxX + 8, by, { width: boxW - 16 });
    by = doc.y;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 10 : 9).fillColor('#000')
      .text(value, boxX + 8, by, { width: boxW - 16 });
    by = doc.y + 3;
  };
  boxLine('e-NCF', qr.eNCF, true);
  boxLine('FECHA EMISIÓN', ecf.FechaEmision || qr.fechaEmision);
  if (ecf.FechaVencimientoSecuencia) boxLine('VENC. SECUENCIA', ecf.FechaVencimientoSecuencia);

  // ---- Big title (centered, full width, no wrap) ----
  y = Math.max(emitterBottom, boxY + boxH) + 14;
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#1a3c6e');
  doc.text(TIPO_NOMBRE[tipo] || `TIPO ${tipo}`, LEFT, y, { width: CONTENT_W, align: 'center' });
  y = doc.y + 6;
  doc.moveTo(LEFT, y).lineTo(RIGHT, y).lineWidth(1).stroke('#1a3c6e');
  y += 10;

  // ---- Buyer block (omitted for tipo-32 consumo <250k) ----
  if (!omitBuyer) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#000').text('COMPRADOR', LEFT, y);
    y = doc.y + 1;
    doc.font('Helvetica').fontSize(9);
    const buyerLines = [
      ecf.RNCComprador ? `RNC/Cédula: ${ecf.RNCComprador}` : '',
      ecf.RazonSocialComprador ? `Razón Social: ${ecf.RazonSocialComprador}` : '',
      ecf.DireccionComprador ? `Dirección: ${ecf.DireccionComprador}` : '',
    ].filter((l) => l);
    for (const line of buyerLines) {
      doc.text(line, LEFT, doc.y, { width: CONTENT_W });
    }
    y = doc.y + 10;
  }

  // ---- Item detail table ----
  const cols = {
    num: { x: LEFT, w: 26 },
    nombre: { x: LEFT + 28, w: 247 },
    cant: { x: 311, w: 58 },
    precio: { x: 371, w: 88 },
    monto: { x: 461, w: RIGHT - 461 },
  };
  const headerH = 16;
  doc.rect(LEFT, y, CONTENT_W, headerH).fill('#1a3c6e');
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#fff');
  const cellY = y + 4.5;
  doc.text('#', cols.num.x + 3, cellY, { width: cols.num.w - 4, lineBreak: false });
  doc.text('DESCRIPCIÓN', cols.nombre.x, cellY, { width: cols.nombre.w, lineBreak: false });
  doc.text('CANT.', cols.cant.x, cellY, { width: cols.cant.w - 4, align: 'right', lineBreak: false });
  doc.text('PRECIO UNIT.', cols.precio.x, cellY, { width: cols.precio.w - 4, align: 'right', lineBreak: false });
  doc.text('MONTO', cols.monto.x, cellY, { width: cols.monto.w - 4, align: 'right', lineBreak: false });
  y += headerH;

  const rowH = 15;
  doc.fillColor('#000');
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
    doc.text(money(ecf[`CantidadItem[${i}]`]), cols.cant.x, ry, { width: cols.cant.w - 4, align: 'right', lineBreak: false });
    doc.text(money(ecf[`PrecioUnitarioItem[${i}]`]), cols.precio.x, ry, { width: cols.precio.w - 4, align: 'right', lineBreak: false });
    doc.text(money(ecf[`MontoItem[${i}]`]), cols.monto.x, ry, { width: cols.monto.w - 4, align: 'right', lineBreak: false });
    y += rowH;
  }
  doc.moveTo(LEFT, y).lineTo(RIGHT, y).lineWidth(0.5).stroke('#cccccc');
  y += 12;

  // ---- Totals (right-aligned block) ----
  const labelX = 320;
  const labelW = 150;
  const valX = 471;
  const valW = RIGHT - valX;
  const totalLine = (label: string, value: string, big = false) => {
    doc.font(big ? 'Helvetica-Bold' : 'Helvetica').fontSize(big ? 11 : 9).fillColor('#000');
    doc.text(label, labelX, y, { width: labelW, align: 'right', lineBreak: false });
    doc.text(value, valX, y, { width: valW, align: 'right', lineBreak: false });
    y += big ? 18 : 14;
  };
  if (ecf.MontoGravadoTotal) totalLine('Monto Gravado:', money(ecf.MontoGravadoTotal));
  if (ecf.MontoExento) totalLine('Monto Exento:', money(ecf.MontoExento));
  if (qr.totalITBIS && qr.totalITBIS !== '') totalLine('Total ITBIS:', money(qr.totalITBIS));
  // Highlighted Monto Total.
  doc.rect(labelX, y - 2, RIGHT - labelX, 20).fill('#1a3c6e');
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#fff');
  doc.text('MONTO TOTAL:', labelX + 4, y + 3, { width: labelW - 8, align: 'right', lineBreak: false });
  doc.text(`RD$ ${money(ecf.MontoTotal || qr.montoTotal)}`, valX - 6, y + 3, { width: valW + 2, align: 'right', lineBreak: false });
  y += 24;

  // ---- Footer: QR (bottom-left) + security + legend ----
  const footerH = 140;
  const footerY = Math.max(y + 14, PAGE.height - PAGE.margin - footerH);
  doc.moveTo(LEFT, footerY).lineTo(RIGHT, footerY).lineWidth(0.5).stroke('#cccccc');
  const qrSize = 120;
  const qrY = footerY + 12;
  doc.image(qrPng, LEFT, qrY, { width: qrSize, height: qrSize });

  const infoX = LEFT + qrSize + 18;
  const infoW = RIGHT - infoX;
  let iy = qrY + 4;
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#000').text('Código de Seguridad:', infoX, iy, { width: infoW });
  iy = doc.y;
  doc.font('Helvetica').fontSize(11).text(qr.codigoSeguridad, infoX, iy, { width: infoW });
  iy = doc.y + 6;
  doc.font('Helvetica-Bold').fontSize(9).text('Fecha de Firma:', infoX, iy, { width: infoW });
  iy = doc.y;
  doc.font('Helvetica').fontSize(10).text(qr.fechaFirma, infoX, iy, { width: infoW });
  iy = doc.y + 10;
  doc.font('Helvetica-Oblique').fontSize(8.5).fillColor('#333')
    .text(LEYENDA, infoX, iy, { width: infoW });

  doc.end();
  await new Promise<void>((resolve, reject) => {
    stream.on('finish', () => resolve());
    stream.on('error', reject);
  });
}
