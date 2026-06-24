import * as fs from 'fs';
import * as path from 'path';
import { RawCase, CaseData } from './types';
import { AcecfCase } from './acecfBuilder';

const DATASET_PATH = path.resolve(__dirname, '..', 'dataset.json');

interface Dataset {
  ECF: RawCase[];
  RFCE: RawCase[];
}

let loaded: Dataset | null = null;

function load(): Dataset {
  if (!loaded) {
    loaded = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf8')) as Dataset;
  }
  return loaded;
}

/** Strip "#e" (empty) fields and trim values. */
export function normalize(raw: RawCase): CaseData {
  const out: CaseData = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v == null) continue;
    const val = String(v);
    if (val === '#e') continue;
    out[k] = val;
  }
  return out;
}

export function getEcfCases(): CaseData[] {
  return load().ECF.map(normalize);
}

export function getRfceCases(): CaseData[] {
  return load().RFCE.map(normalize);
}

export function getEcfCase(encf: string): CaseData | undefined {
  const c = load().ECF.find((x) => x.ENCF === encf);
  return c ? normalize(c) : undefined;
}

export function getRfceCase(encf: string): CaseData | undefined {
  const c = load().RFCE.find((x) => x.ENCF === encf);
  return c ? normalize(c) : undefined;
}

/**
 * Fallback RNC for the approving buyer when an e-CF case carries no
 * RNCComprador (e.g. tipo 43/47). Used ONLY for offline smoke-testing so the
 * derived ACECF still satisfies the XSD RNCValidation pattern.
 */
const SMOKE_RNC_COMPRADOR = '131880681';

/**
 * Path to the parsed Paso-3 "DESCARGAR APROBACIONES COMERCIALES" sheet, as a
 * JSON array of AcecfCase objects. When present it is the authoritative source.
 */
const ACECF_DATASET_PATH = path.resolve(__dirname, '..', 'acecf_dataset.json');

/**
 * Return the Aprobación Comercial cases (Paso 3).
 *
 * 1. If `acecf_dataset.json` exists, use it — this is the real Paso-3 sheet.
 *    To wire a freshly downloaded Excel: convert it to that JSON array of
 *    AcecfCase objects (RNCEmisor, eNCF, FechaEmision, MontoTotal,
 *    RNCComprador, Estado, optional DetalleMotivoRechazo,
 *    optional FechaHoraAprobacionComercial). No code changes needed.
 * 2. Otherwise derive one Estado=1 candidate per e-CF case so generation +
 *    signing + XSD can be smoke-tested offline before the real set arrives.
 */
export function getAcecfCases(): AcecfCase[] {
  if (fs.existsSync(ACECF_DATASET_PATH)) {
    const raw = JSON.parse(fs.readFileSync(ACECF_DATASET_PATH, 'utf8')) as AcecfCase[];
    return raw.map((c) => ({
      RNCEmisor: String(c.RNCEmisor),
      eNCF: String(c.eNCF),
      FechaEmision: String(c.FechaEmision),
      MontoTotal: String(c.MontoTotal),
      RNCComprador: String(c.RNCComprador),
      Estado: String(c.Estado),
      DetalleMotivoRechazo: c.DetalleMotivoRechazo,
      FechaHoraAprobacionComercial: c.FechaHoraAprobacionComercial,
    }));
  }
  return getEcfCases().map((c) => ({
    RNCEmisor: c.RNCEmisor,
    eNCF: c.ENCF,
    FechaEmision: c.FechaEmision,
    MontoTotal: c.MontoTotal,
    RNCComprador: c.RNCComprador || SMOKE_RNC_COMPRADOR,
    Estado: '1',
  }));
}

/** Look up the derived ACECF candidate for a single eNCF. */
export function getAcecfCase(encf: string): AcecfCase | undefined {
  return getAcecfCases().find((c) => c.eNCF === encf);
}

/** Path to the Paso-4 simulation plan (25 rows). FUENTE DE VERDAD. */
const PASO4_PLAN_PATH = path.resolve(__dirname, '..', '..', 'paso4_plan.json');

/** One row of paso4_plan.json. */
export interface Paso4Plan {
  orden: number;
  tipo: string;
  nuevo_encf: string;
  origen_paso2: string;
  fecha: string;
  rnc_comprador: string;
  monto_total: string;
  itbis: string;
  doc_class: string;
  qr: string;
  /**
   * Optional Paso-4 remap of the modified e-CF reference. In the live
   * simulation a note (33/34) MUST reference an e-CF that is ACCEPTED within
   * the SAME Paso-4 batch — DGII rejects NCFModificado pointing at a Paso-2
   * document not present/accepted in the simulation. When set, this overrides
   * the NCFModificado inherited from the origen record.
   */
  ncf_modificado_override?: string;
  /** When remapping the reference, the FechaNCFModificado of the new target. */
  fecha_ncf_modificado_override?: string;
  /** Override the note's own FechaEmision (must be >= the modified doc date). */
  fecha_override?: string;
  /** Override IndicadorNotaCredito: 0 if note <=30 days of modified doc, else 1. */
  indicador_nota_credito_override?: string;
}

/**
 * A fully-resolved Paso-4 document: the plan row plus the operational data
 * (cloned from the `origen_paso2` record in dataset.json) re-keyed to emit with
 * the NEW sequence `nuevo_encf`. For consumo (<250k) rows, `rfce` carries the
 * RFCE summary case and `ecf` carries the FULL invoice (for the manual upload).
 */
export interface Paso4Case {
  plan: Paso4Plan;
  /** True for tipo-32 consumo <250k rows emitted as an RFCE summary. */
  isConsumo: boolean;
  /** The e-CF case (full invoice for consumo rows), keyed to nuevo_encf. */
  ecf: CaseData;
  /** The RFCE summary case (consumo rows only), keyed to nuevo_encf. */
  rfce?: CaseData;
}

/** Clone an origen record, re-keying ENCF and FechaEmision for Paso 4. */
function reKey(origen: CaseData, plan: Paso4Plan): CaseData {
  const fecha = plan.fecha_override || plan.fecha;
  const out: CaseData = { ...origen, ENCF: plan.nuevo_encf, FechaEmision: fecha };
  if (plan.ncf_modificado_override) {
    out.NCFModificado = plan.ncf_modificado_override;
  }
  if (plan.fecha_ncf_modificado_override) {
    out.FechaNCFModificado = plan.fecha_ncf_modificado_override;
  }
  if (plan.indicador_nota_credito_override !== undefined) {
    out.IndicadorNotaCredito = plan.indicador_nota_credito_override;
  }
  return out;
}

/**
 * Resolve the 25 Paso-4 documents (Pruebas de Simulación e-CF).
 *
 * Each plan row names an `origen_paso2` document whose complete operational
 * data (ítems, impuestos, etc.) lives in dataset.json. We clone that record and
 * re-key it to the NEW sequence (`nuevo_encf`) and the plan's FechaEmision so
 * the emitted document — and its Timbre QR — are mutually consistent. Amounts
 * are taken verbatim from the origen (they already passed Paso 2 arithmetic).
 */
export function getPaso4Cases(): Paso4Case[] {
  const ds = load();
  const ecfByEncf = new Map(ds.ECF.map((c) => [c.ENCF, c]));
  const rfceByEncf = new Map(ds.RFCE.map((c) => [c.ENCF, c]));
  const plan = JSON.parse(fs.readFileSync(PASO4_PLAN_PATH, 'utf8')) as Paso4Plan[];

  return plan.map((p) => {
    const origenEcf = ecfByEncf.get(p.origen_paso2);
    if (!origenEcf) {
      throw new Error(`Paso4: origen_paso2 ${p.origen_paso2} not found in dataset.json ECF`);
    }
    const isConsumo = /RFCE/i.test(p.doc_class);
    const ecf = reKey(normalize(origenEcf), p);

    let rfce: CaseData | undefined;
    if (isConsumo) {
      const origenRfce = rfceByEncf.get(p.origen_paso2);
      if (!origenRfce) {
        throw new Error(`Paso4: consumo origen ${p.origen_paso2} not found in dataset.json RFCE`);
      }
      rfce = reKey(normalize(origenRfce), p);
    }
    return { plan: p, isConsumo, ecf, rfce };
  });
}
