// Shared pipeline "working signal" helpers, used by both the Kanban card and the
// pipeline table view. Kept in their own module (not PipelineCard.tsx) so the card file
// only exports components — react-refresh requires component files to stay component-only.

/** Overdue is recomputed client-side from due_at so a cached card can't stay "on time". */
export function isTaskOverdue(dueAt: string | null | undefined): boolean {
    if (!dueAt) return false;
    return new Date(dueAt).getTime() < Date.now();
}

/** Whole days since a timestamp (>= 0), or null when there is none. */
export function getContactAgeDays(iso: string | null | undefined): number | null {
    if (!iso) return null;
    return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
}

/** Up-to-two-char initials from a display name/email — never a raw UUID. */
export function getOwnerInitials(name: string | null | undefined, email: string | null | undefined): string {
    const source = (name && name.trim()) || (email ? email.split('@')[0] : '') || '';
    const parts = source.split(/[\s._-]+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
}
