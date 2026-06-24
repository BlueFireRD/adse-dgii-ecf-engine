import * as fs from 'fs';
import * as path from 'path';
import { getPaso4Cases } from './dataset';
import { buildRI, QrRow } from './riBuilder';

const ROOT = path.resolve(__dirname, '..');
const QR_PATH = path.join(ROOT, 'out', 'paso4_qr.json');
const RI_DIR = path.join(ROOT, 'out', 'ri');

/** The 11 RIs the Paso-5 portal asks for: eNCF -> output filename suffix. */
const TARGETS: { encf: string; file: string }[] = [
  { encf: 'E310000000014', file: 'RI_31_E310000000014.pdf' },
  { encf: 'E320000000022', file: 'RI_32grande_E320000000022.pdf' },
  { encf: 'E330000000003', file: 'RI_33_E330000000003.pdf' },
  { encf: 'E340000000021', file: 'RI_34_E340000000021.pdf' },
  { encf: 'E410000000010', file: 'RI_41_E410000000010.pdf' },
  { encf: 'E430000000015', file: 'RI_43_E430000000015.pdf' },
  { encf: 'E440000000016', file: 'RI_44_E440000000016.pdf' },
  { encf: 'E450000000013', file: 'RI_45_E450000000013.pdf' },
  { encf: 'E460000000013', file: 'RI_46_E460000000013.pdf' },
  { encf: 'E470000000012', file: 'RI_47_E470000000012.pdf' },
  { encf: 'E320000000024', file: 'RI_32consumo_E320000000024.pdf' },
];

async function main() {
  fs.mkdirSync(RI_DIR, { recursive: true });

  const cases = getPaso4Cases();
  const ecfByEncf = new Map(cases.map((c) => [c.ecf.ENCF, c.ecf]));
  const qrRows = JSON.parse(fs.readFileSync(QR_PATH, 'utf8')) as QrRow[];
  const qrByEncf = new Map(qrRows.map((r) => [r.eNCF, r]));

  console.log(`Generando ${TARGETS.length} Representaciones Impresas en ${RI_DIR}\n`);
  let total = 0;
  for (const t of TARGETS) {
    const ecf = ecfByEncf.get(t.encf);
    const qr = qrByEncf.get(t.encf);
    if (!ecf) throw new Error(`No e-CF case for ${t.encf} (getPaso4Cases)`);
    if (!qr) throw new Error(`No QR row for ${t.encf} (out/paso4_qr.json)`);

    const outPath = path.join(RI_DIR, t.file);
    await buildRI(ecf, qr, outPath);
    const size = fs.statSync(outPath).size;
    total += size;
    const buyer = qr.qrURL.includes('ConsultaTimbreFC') ? 'comprador OMITIDO' : 'comprador incluido';
    console.log(`  ${t.file.padEnd(34)} ${(size / 1024).toFixed(1).padStart(7)} KB  t${ecf.TipoeCF}  ${buyer}`);
  }
  console.log(`\nTotal: ${(total / 1024 / 1024).toFixed(2)} MB en ${TARGETS.length} PDFs.`);
}

main().catch((e) => {
  console.error('FATAL', e.message || e);
  process.exit(1);
});
