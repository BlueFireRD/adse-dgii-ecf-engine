const REPL = '�';

/**
 * Scan text fields for U+FFFD (Unicode replacement character), which is never
 * legitimate content — always upstream encoding mangling.
 * Pass a flat map of field names → values; nested object values (e.g. evidence)
 * have their top-level string-valued keys checked under "fieldName.key".
 * Returns an error body ready for res.status(400).json(), or null if clean.
 */
export function checkEncoding(
  fields: Record<string, unknown>
): { error: string } | null {
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value === 'string' && value.includes(REPL)) {
      return { error: `invalid encoding (U+FFFD) in field ${name} — send UTF-8` };
    }
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v === 'string' && v.includes(REPL)) {
          return { error: `invalid encoding (U+FFFD) in field ${name}.${k} — send UTF-8` };
        }
      }
    }
  }
  return null;
}
