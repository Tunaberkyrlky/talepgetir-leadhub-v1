/**
 * Types for the CSV/XLSX import feature.
 * Shared by ImportPage, DataMatchFlow, MappingEditor, and ImportProgressContext.
 */

export interface MappingSuggestion {
    fileHeader: string;
    dbField: string | null;
    table: string | null;
    field: string | null;
    confidence: number;
    required: boolean;
}

export interface AvailableField {
    value: string;
    label: string;
    table: string;
    field: string;
    required: boolean;
}

export interface MatchEntry {
    row: number;
    company: string;
    website: string | null;
    companyAction: 'created' | 'matched';
    companyId: string;
    contact: string | null;
    email: string | null;
    contactAction: 'created' | 'skipped_duplicate' | 'none';
}

export interface MatchReport {
    version: 1;
    summary: {
        companiesCreated: number;
        companiesMatched: number;
        contactsCreated: number;
        contactsSkippedDuplicate: number;
        contactsWithoutName: number;
        rowsErrored: number;
    };
    entries: MatchEntry[];
    entriesTruncated: boolean;
}

export interface ImportResult {
    importJobId?: string;
    totalRows: number;
    successCount: number;
    errorCount: number;
    errors: { row: number; field: string; error: string }[];
    createdCompanies: number;
    updatedCompanies: number;
    createdContacts: number;
    matchReport?: MatchReport;
    cancelled?: boolean;
}

// ── Kampanya alıcı importu (CampaignImportModal) ───────────────────────────

export type ImportType = 'crm' | 'campaign_recipients';

/** POST /import/campaign-summary — execute öncesi salt-okunur ön-uçuş özeti. */
export interface CampaignImportPreflight {
    total: number;
    byStatus: Record<string, number>;
    dncExcluded: number;
    duplicatesInFile: number;
    invalidEmails: number;
    multiEmailCells: number;
    eligible: number;
    estimatedDays: number | null;
    sendStatuses: string[];
    dailyLimit: number | null;
}

/** import_jobs.match_report.campaign — execute sonrası kalıcı özet. */
export interface CampaignImportSummary {
    enrolled: number;
    excluded: Record<string, number>;
    skippedDuplicateInFile: number;
    skippedAlreadyEnrolled: number;
    byStatus: Record<string, number>;
    estimatedDays: number | null;
}

export interface CampaignImportResult extends Omit<ImportResult, 'matchReport'> {
    campaign: CampaignImportSummary;
}
