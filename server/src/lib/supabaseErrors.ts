/**
 * Supabase-js (PostgREST / Postgres) error classification — the single home for
 * deciding WHICH DB errors justify a fallback / typed-failure path.
 *
 * Keeping these rules in one place (not inlined at each call site) means a
 * fallback fires ONLY on a genuine "object not found" error — a missing function
 * or a missing column on a pre-migration DB — and NEVER on a general DB /
 * permission fault, which must surface as a 500 instead of being silently masked.
 *
 * Both classifiers are pure and dependency-free.
 */

/** Minimal shape of a supabase-js / PostgrestError we classify on. */
export type SupabaseErrorLike = { code?: string | null; message?: string | null } | null | undefined;

/**
 * A missing FUNCTION / signature mismatch — the RPC (or the specific overload
 * that was called) does not exist on this DB. Covers:
 *   - Postgres SQLSTATE 42883 (undefined_function)
 *   - PostgREST PGRST202 (no function matches the name + args in the schema cache)
 *   - message text 'does not exist' / 'schema cache' (older / looser surfaces)
 * A signature mismatch (extra RPC args a pre-migration function rejects) surfaces
 * as PGRST202, so this also gates an "extra-param" retry.
 */
export function isMissingFunctionError(err: SupabaseErrorLike): boolean {
    if (!err) return false;
    const code = err.code ?? '';
    const message = (err.message ?? '').toLowerCase();
    return (
        code === '42883' ||
        code === 'PGRST202' ||
        message.includes('does not exist') ||
        message.includes('schema cache')
    );
}

/**
 * A missing COLUMN — the named column is absent on this DB (e.g. a pre-migration
 * table). Covers:
 *   - Postgres SQLSTATE 42703 (undefined_column) — unambiguous on its own
 *   - message text naming the column AND 'does not exist' / 'column'
 * The column name guards the message-text branch so an unrelated 'does not exist'
 * (e.g. a missing function) is NOT misread as a missing column.
 */
export function isMissingColumnError(err: SupabaseErrorLike, column: string): boolean {
    if (!err) return false;
    const code = err.code ?? '';
    const message = (err.message ?? '').toLowerCase();
    if (code === '42703') return true;
    const col = column.toLowerCase();
    return message.includes(col) && (message.includes('does not exist') || message.includes('column'));
}
