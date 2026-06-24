import * as fs from 'fs';
import { DOMParser } from '@xmldom/xmldom';
import { XsdNode } from './types';

const XS = 'http://www.w3.org/2001/XMLSchema';

function parseOccurs(v: string | null, def: number): number {
  if (v == null) return def;
  if (v === 'unbounded') return Number.POSITIVE_INFINITY;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? def : n;
}

function childElements(node: Element, localName: string): Element[] {
  const out: Element[] = [];
  for (let i = 0; i < node.childNodes.length; i++) {
    const c = node.childNodes[i] as any;
    if (c.nodeType === 1 && c.namespaceURI === XS && c.localName === localName) {
      out.push(c as Element);
    }
  }
  return out;
}

/** Recursively turn an <xs:element> DOM node into an XsdNode (ordered). */
function elementToNode(el: Element): XsdNode {
  const node: XsdNode = {
    name: el.getAttribute('name') || '',
    minOccurs: parseOccurs(el.getAttribute('minOccurs'), 1),
    maxOccurs: parseOccurs(el.getAttribute('maxOccurs'), 1),
  };
  const ct = childElements(el, 'complexType')[0];
  if (ct) {
    const children = collectSequenceChildren(ct);
    node.children = children;
  }
  return node;
}

/**
 * Collect ordered child <xs:element>s from a complexType. Handles a top-level
 * <xs:sequence> (the only compositor used by the DGII schemas). Inline
 * complexTypes without a sequence (none expected) yield no children.
 */
function collectSequenceChildren(complexType: Element): XsdNode[] {
  const seq = childElements(complexType, 'sequence')[0];
  if (!seq) return [];
  const result: XsdNode[] = [];
  for (let i = 0; i < seq.childNodes.length; i++) {
    const c = seq.childNodes[i] as any;
    if (c.nodeType === 1 && c.namespaceURI === XS && c.localName === 'element') {
      result.push(elementToNode(c as Element));
    }
    // <xs:any> placeholders (signature slot) are intentionally ignored here;
    // the signature is appended by the signer, not the builder.
  }
  return result;
}

const cache = new Map<string, XsdNode>();

/** Parse an XSD file and return the root <xs:element> as an ordered tree. */
export function parseXsd(xsdPath: string): XsdNode {
  const cached = cache.get(xsdPath);
  if (cached) return cached;
  const xml = fs.readFileSync(xsdPath, 'utf8');
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const schema = doc.documentElement!;
  const rootEl = childElements(schema, 'element')[0];
  if (!rootEl) throw new Error(`No root element in schema ${xsdPath}`);
  const node = elementToNode(rootEl);
  cache.set(xsdPath, node);
  return node;
}
