import { CaseData, XsdNode } from './types';

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Resolve an XSD leaf element name to the dataset field base-name.
 * The dataset mostly matches XSD leaf names; these are the exceptions,
 * some of which depend on the container path (context-sensitive).
 */
export function aliasName(leaf: string, pathStack: string[]): string {
  if (leaf === 'eNCF') return 'ENCF';
  // The XSD reuses "NumeroLinea" both inside Item and inside DescuentoORecargo;
  // the dataset disambiguates the latter as "NumeroLineaDoR".
  if (leaf === 'NumeroLinea' && pathStack.includes('DescuentoORecargo')) {
    return 'NumeroLineaDoR';
  }
  // Dataset uses a lowercase 's' for this one field.
  if (leaf === 'MontoSubRecargo') return 'MontosubRecargo';
  return leaf;
}

/**
 * Collect aliased dataset base-names of the DIRECT leaf children of a
 * container (depth 1). Nested sub-table leaves are excluded so that, e.g.,
 * the Item instance count is driven by per-item fields (NumeroLinea, MontoItem)
 * and not by an item's repeating sub-tables (ImpuestoAdicional, SubDescuento).
 */
function collectDirectLeafBases(node: XsdNode, pathStack: string[]): string[] {
  const out: string[] = [];
  const s = [...pathStack, node.name];
  for (const c of node.children || []) {
    if (!c.children) out.push(aliasName(c.name, s));
  }
  return out;
}

/** Render an index path as the dataset key suffix, e.g. [1] or [1][2]. */
function suffix(idxPath: number[]): string {
  return idxPath.map((i) => `[${i}]`).join('');
}

/**
 * Indices present in the data for the given base-names at the depth one level
 * below `parentPath`. For a top-level container parentPath is empty and we read
 * the single-index keys (`NumeroLinea[1]`); for a sub-table nested under item i
 * parentPath is [i] and we read the double-index keys (`MontoSubDescuento[1][2]`).
 */
function indicesForBases(bases: string[], data: CaseData, parentPath: number[]): number[] {
  const found = new Set<number>();
  const parent = suffix(parentPath);
  for (const b of bases) {
    const prefix = b + parent + '[';
    for (const key of Object.keys(data)) {
      if (!key.startsWith(prefix)) continue;
      // Take the first bracketed integer immediately following the prefix.
      const rest = key.slice(prefix.length);
      const close = rest.indexOf(']');
      if (close < 0) continue;
      const n = parseInt(rest.slice(0, close), 10);
      if (!Number.isNaN(n)) found.add(n);
    }
  }
  return [...found].sort((a, b) => a - b);
}

export interface BuildContext {
  data: CaseData;
  /** Synthesized leaf values keyed by XSD leaf name (e.g. FechaHoraFirma). */
  synth: Record<string, string>;
}

export function buildChildrenPublic(
  node: XsdNode,
  idxPath: number[],
  stack: string[],
  ctx: BuildContext
): string {
  return (node.children || []).map((c) => buildNode(c, idxPath, stack, ctx)).join('');
}

function buildChildren(
  node: XsdNode,
  idxPath: number[],
  stack: string[],
  ctx: BuildContext
): string {
  return (node.children || []).map((c) => buildNode(c, idxPath, stack, ctx)).join('');
}

/**
 * Look up a leaf value, trying the most specific indexed key first and falling
 * back to progressively shallower keys (then the plain base, then a synthesized
 * value). This lets an item-level field referenced from inside an indexed
 * context, or a plain constant, still resolve.
 */
function leafValue(base: string, leaf: string, idxPath: number[], ctx: BuildContext): string | undefined {
  for (let depth = idxPath.length; depth >= 1; depth--) {
    const v = ctx.data[base + suffix(idxPath.slice(0, depth))];
    if (v !== undefined) return v;
  }
  if (ctx.data[base] !== undefined) return ctx.data[base];
  if (ctx.synth[leaf] !== undefined) return ctx.synth[leaf];
  return undefined;
}

function buildNode(
  node: XsdNode,
  idxPath: number[],
  stack: string[],
  ctx: BuildContext
): string {
  // Leaf
  if (!node.children) {
    const base = aliasName(node.name, stack);
    const val = leafValue(base, node.name, idxPath, ctx);
    if (val === undefined || val === '') return '';
    return `<${node.name}>${escapeXml(val)}</${node.name}>`;
  }

  const childStack = [...stack, node.name];

  // Repeating container: descend one index level deeper.
  if (node.maxOccurs > 1) {
    const bases = collectDirectLeafBases(node, stack);
    const indices = indicesForBases(bases, ctx.data, idxPath);
    const parts: string[] = [];
    for (const i of indices) {
      const inner = buildChildren(node, [...idxPath, i], childStack, ctx);
      if (inner !== '') parts.push(`<${node.name}>${inner}</${node.name}>`);
    }
    return parts.join('');
  }

  // Single-occurrence container: carry the current index path into children.
  const inner = buildChildren(node, idxPath, childStack, ctx);
  if (inner === '' && node.minOccurs === 0) return '';
  return `<${node.name}>${inner}</${node.name}>`;
}
