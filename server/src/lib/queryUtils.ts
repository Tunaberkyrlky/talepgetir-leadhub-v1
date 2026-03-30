/**
 * Sanitize user input for use in PostgREST ILIKE filters.
 * Strips PostgREST syntax characters and escapes ILIKE wildcards.
 */
export function sanitizeSearch(value: string): string {
  return value
    .replace(/[,().\\]/g, '')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}
