/**
 * textSanitizer — defensa de codificación para los textos de e-CF y RI.
 *
 * Objetivos:
 *   1) Reparar automáticamente el mojibake más común: UTF-8 leído como
 *      Latin-1 / CP1252 (p.ej. "Ã©" -> "é", "Ã±" -> "ñ", "Â°" -> "°").
 *      Es una corrección reversible y segura: solo se aplica cuando el texto
 *      tiene la firma típica del mojibake y el resultado es UTF-8 válido.
 *   2) Detectar corrupción IRREPARABLE — el carácter de reemplazo "�" o
 *      un "¿"/"¡" pegado a una letra (placeholder de un acento perdido, como
 *      "CAF¿" por "CAFÉ") — y reportarla, para atraparla al CONSTRUIR el
 *      comprobante en vez de descubrirla en una factura impresa.
 *
 * No altera texto ya válido, y NUNCA "inventa" un reemplazo para corrupción
 * irreparable (el carácter original se perdió): solo lo reporta.
 */

// Firma típica de UTF-8 mal interpretado como Latin-1/CP1252.
const MOJIBAKE_SIGNATURE =
  /[ÃÂ][-¿]|â[¦]/;

/** Repara mojibake UTF-8↔Latin-1 de forma conservadora. Devuelve el texto sano. */
export function repairMojibake(input: string): string {
  if (!input || !MOJIBAKE_SIGNATURE.test(input)) return input;
  try {
    const repaired = Buffer.from(input, 'latin1').toString('utf8');
    // Aceptar solo si cambió y no introdujo caracteres de reemplazo.
    if (repaired && repaired !== input && !repaired.includes('�')) {
      return repaired;
    }
  } catch {
    /* si algo falla, se conserva el original */
  }
  return input;
}

/** Reporta señales de corrupción irreparable. Devuelve descripciones (vacío = sano). */
export function auditText(input: string): string[] {
  if (!input) return [];
  const issues: string[] = [];
  if (input.includes('�')) {
    issues.push('carácter de reemplazo "�"');
  }
  // "¿"/"¡" pegado a una letra = placeholder de un acento perdido.
  // El uso legítimo en español va precedido de espacio/inicio, no de una letra.
  if (/[\p{L}][¿¡]/u.test(input)) {
    issues.push('signo "¿/¡" pegado a una letra (posible acento perdido)');
  }
  return issues;
}

export interface SanitizeResult<T> {
  data: T;
  warnings: string[];
}

/**
 * Sanea (repara + audita) recursivamente los campos de texto de un registro.
 * Devuelve una copia saneada y la lista de advertencias encontradas.
 */
export function sanitizeRecord<T extends Record<string, any>>(
  data: T,
  label = ''
): SanitizeResult<T> {
  const warnings: string[] = [];
  const walk = (value: any): any => {
    if (typeof value === 'string') {
      const repaired = repairMojibake(value);
      const issues = auditText(repaired);
      return { value: repaired, issues };
    }
    if (Array.isArray(value)) {
      return { value: value.map((v) => walk(v).value), issues: [] };
    }
    if (value && typeof value === 'object') {
      const obj: Record<string, any> = {};
      for (const [k, v] of Object.entries(value)) {
        const r = walk(v);
        obj[k] = r.value;
        if (r.issues && r.issues.length) {
          warnings.push(`${label ? label + ' · ' : ''}${k}: ${r.issues.join('; ')} -> ${JSON.stringify(r.value)}`);
        }
      }
      return { value: obj, issues: [] };
    }
    return { value, issues: [] };
  };
  // Recorrer el nivel superior conservando claves.
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(data)) {
    const r = walk(v);
    out[k] = r.value;
    if (r.issues && r.issues.length) {
      warnings.push(`${label ? label + ' · ' : ''}${k}: ${r.issues.join('; ')} -> ${JSON.stringify(r.value)}`);
    }
  }
  return { data: out as T, warnings };
}

/** Sanea un registro e imprime las advertencias por consola (no lanza). */
export function sanitizeAndWarn<T extends Record<string, any>>(data: T, label = ''): T {
  const { data: clean, warnings } = sanitizeRecord(data, label);
  for (const w of warnings) console.warn(`[sanitizer] ${w}`);
  return clean;
}
