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

export interface ImportResult {
    importJobId?: string;
    totalRows: number;
    successCount: number;
    errorCount: number;
    errors: { row: number; field: string; error: string }[];
    createdCompanies: number;
    updatedCompanies: number;
    createdContacts: number;
    cancelled?: boolean;
}
