/**
 * Single source of truth for role constants.
 * Import from here — never redeclare in individual route/middleware files.
 */

export const INTERNAL_ROLES = ['superadmin', 'ops_agent'] as const;

export type InternalRole = typeof INTERNAL_ROLES[number];

/** Returns true when the given role has internal (staff) access. */
export function isInternalRole(role: string): boolean {
    return (INTERNAL_ROLES as readonly string[]).includes(role);
}
