// Shared type definitions for the DGII e-CF / RFCE engine.

/** A single dataset case is a flat map of field-name -> value. "#e" means empty. */
export type RawCase = Record<string, string>;

/** A normalized case: "#e" values stripped out entirely. */
export type CaseData = Record<string, string>;

/** Parsed XSD element node (ordered tree, sequence order preserved). */
export interface XsdNode {
  name: string;
  minOccurs: number;
  maxOccurs: number; // Number.POSITIVE_INFINITY for "unbounded"
  /** undefined => leaf (simple type); array => container (complexType/sequence). */
  children?: XsdNode[];
}

export interface ValidationResult {
  encf: string;
  schema: string;
  valid: boolean;
  errors: string[];
}

export const ECF_TYPES = ['31', '32', '33', '34', '41', '43', '44', '45', '46', '47'] as const;
export type EcfType = (typeof ECF_TYPES)[number];

/** The four tipo-32 consumo ENCFs that must be emitted as RFCE summaries. */
export const RFCE_ENCFS = [
  'E320000000011',
  'E320000000012',
  'E320000000013',
  'E320000000015',
];
