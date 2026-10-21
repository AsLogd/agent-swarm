const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

/**
 * `TableColumn.format` — combine several row fields into one cell.
 *
 * - `{{key}}` (whitespace inside the braces allowed) is replaced by
 *   `row[key]`, looked up flat: a dotted key such as `{{owner.name}}` reads
 *   the literal `"owner.name"` column, never a nested path.
 * - `null` / `undefined` (including a missing field) → empty string.
 * - objects and arrays → `JSON.stringify(value)` (json columns), everything
 *   else → `String(value)`. No per-field `kind` formatting.
 * - text without a well-formed placeholder is returned unchanged.
 */
export function applyTemplate(template: string, row: Record<string, unknown>): string {
  return template.replace(PLACEHOLDER, (_match, key: string) => {
    const value = Object.hasOwn(row, key) ? row[key] : undefined;
    if (value === null || value === undefined) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  });
}
