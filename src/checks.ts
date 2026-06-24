import { CaseData } from './types';

/**
 * Business-rule arithmetic checks that the XSD cannot express but DGII enforces.
 * These guard the three reconciliations that caused live rejections:
 *   - item DescuentoMonto[i] == Σ_j MontoSubDescuento[i][j]   (codes 2020)
 *   - item RecargoMonto[i]   == Σ_j MontosubRecargo[i][j]     (codes 2030)
 *   - Totales OtrosImpuestosAdicionales[k] == Σ_i MontoItem[i]·rate_k
 *       over items carrying tax type k                         (code 0 / Totales)
 */

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v: string | undefined) => (v === undefined || v === '' ? NaN : parseFloat(v));

/** Indices i present for keys shaped `base[i]` (single bracket level). */
function topIndices(data: CaseData, base: string): number[] {
  const found = new Set<number>();
  const re = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\[(\\d+)\\]$');
  for (const k of Object.keys(data)) {
    const m = k.match(re);
    if (m) found.add(parseInt(m[1], 10));
  }
  return [...found].sort((a, b) => a - b);
}

/** Indices j present for keys shaped `base[i][j]` under a fixed i. */
function subIndices(data: CaseData, base: string, i: number): number[] {
  const found = new Set<number>();
  const re = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\[' + i + '\\]\\[(\\d+)\\]$');
  for (const k of Object.keys(data)) {
    const m = k.match(re);
    if (m) found.add(parseInt(m[1], 10));
  }
  return [...found].sort((a, b) => a - b);
}

export interface CheckIssue {
  encf: string;
  rule: string;
  detail: string;
}

/** Item-level discount monto must equal the sum of its sub-discount rows. */
function checkItemSubSums(data: CaseData, encf: string, montoBase: string, subBase: string, issues: CheckIssue[]) {
  for (const i of topIndices(data, montoBase)) {
    const declared = num(data[`${montoBase}[${i}]`]);
    if (Number.isNaN(declared)) continue;
    const js = subIndices(data, subBase, i);
    if (js.length === 0) continue;
    let sum = 0;
    for (const j of js) {
      const v = num(data[`${subBase}[${i}][${j}]`]);
      if (!Number.isNaN(v)) sum += v;
    }
    if (round2(sum) !== round2(declared)) {
      issues.push({
        encf,
        rule: `${montoBase} == Σ ${subBase}`,
        detail: `line ${i}: declared ${declared.toFixed(2)} != sum ${round2(sum).toFixed(2)}`,
      });
    }
  }
}

/**
 * Each Totales OtrosImpuestosAdicionales[k] (for tax type TipoImpuesto[k] at
 * rate TasaImpuestoAdicional[k]) must equal the sum over items carrying that
 * tax type of MontoItem[i]·rate/100.
 */
function checkTotalsAdditionalTaxes(data: CaseData, encf: string, issues: CheckIssue[]) {
  const taxIdx = topIndices(data, 'TipoImpuesto').filter((k) => data[`OtrosImpuestosAdicionales[${k}]`] !== undefined);
  if (taxIdx.length === 0) return;

  const itemIdx = topIndices(data, 'MontoItem');
  for (const k of taxIdx) {
    const type = data[`TipoImpuesto[${k}]`];
    const rate = num(data[`TasaImpuestoAdicional[${k}]`]);
    const declared = num(data[`OtrosImpuestosAdicionales[${k}]`]);
    if (Number.isNaN(rate) || Number.isNaN(declared)) continue;

    let sum = 0;
    for (const i of itemIdx) {
      const monto = num(data[`MontoItem[${i}]`]);
      if (Number.isNaN(monto)) continue;
      // Item carries this tax type if any of its TipoImpuesto[i][j] equals `type`.
      const js = subIndices(data, 'TipoImpuesto', i);
      const carries = js.some((j) => data[`TipoImpuesto[${i}][${j}]`] === type);
      if (carries) sum += monto * (rate / 100);
    }
    if (round2(sum) !== round2(declared)) {
      issues.push({
        encf,
        rule: `OtrosImpuestosAdicionales[${k}] (tipo ${type} @ ${rate}%)`,
        detail: `declared ${declared.toFixed(2)} != Σ item·rate ${round2(sum).toFixed(2)}`,
      });
    }
  }
}

/** Run all arithmetic checks for one case. Returns the list of violations. */
export function checkCase(data: CaseData): CheckIssue[] {
  const encf = data.ENCF || '(unknown)';
  const issues: CheckIssue[] = [];
  checkItemSubSums(data, encf, 'DescuentoMonto', 'MontoSubDescuento', issues);
  checkItemSubSums(data, encf, 'RecargoMonto', 'MontosubRecargo', issues);
  checkTotalsAdditionalTaxes(data, encf, issues);
  return issues;
}
