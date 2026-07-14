import type { QueryClient } from '@tanstack/react-query';

// Common React Query invalidation scope for archive / unarchive actions.
// Archiving is cross-cutting: it changes list contents, the pipeline board,
// dashboard statistics, filter-option dropdowns, and per-record detail views.
// These helpers keep every archive entry point (Leads, People, Company detail,
// Person detail) invalidating the SAME set so no view is left showing a stale
// archived/active state. invalidateQueries prefix-matches, so ['company'] and
// ['person'] cover their id-scoped detail queries too.

/** Caches touched when a COMPANY is archived / unarchived. */
export function invalidateCompanyArchiveCaches(qc: QueryClient): void {
    qc.invalidateQueries({ queryKey: ['companies'] });
    qc.invalidateQueries({ queryKey: ['company'] });
    qc.invalidateQueries({ queryKey: ['pipeline'] });
    qc.invalidateQueries({ queryKey: ['statistics'] });
    qc.invalidateQueries({ queryKey: ['filterOptions'] });
    // Archiving a company drops it from the People page company dropdown too.
    qc.invalidateQueries({ queryKey: ['contact-filter-options'] });
}

/** Caches touched when a CONTACT is archived / unarchived (company_count + totals shift). */
export function invalidateContactArchiveCaches(qc: QueryClient): void {
    qc.invalidateQueries({ queryKey: ['people'] });
    qc.invalidateQueries({ queryKey: ['person'] });
    qc.invalidateQueries({ queryKey: ['companies'] });
    qc.invalidateQueries({ queryKey: ['company'] });
    qc.invalidateQueries({ queryKey: ['statistics'] });
    qc.invalidateQueries({ queryKey: ['contact-filter-options'] });
    // contact_count shifts on the pipeline cards when a contact is archived/restored.
    qc.invalidateQueries({ queryKey: ['pipeline'] });
}
