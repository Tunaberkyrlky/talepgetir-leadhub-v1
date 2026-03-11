/**
 * Import Processor — Core import logic for CSV/XLSX files
 * Handles parsing, validation, dedup, and insertion
 */

import Papa from 'papaparse';
import ExcelJS from 'exceljs';
import fs from 'fs';
import { supabaseAdmin } from './supabase.js';
import { sanitizeCell, type MappingSuggestion } from './importMapper.js';

// Valid stages
const VALID_STAGES = [
    'new', 'researching', 'contacted', 'meeting_scheduled',
    'proposal_sent', 'negotiation', 'won', 'lost', 'on_hold',
];

// Turkish → English stage mapping for CSV import
const STAGE_ALIASES: Record<string, string> = {
    'yeni': 'new',
    'araştırılıyor': 'researching',
    'araştırma': 'researching',
    'iletişime geçildi': 'contacted',
    'görüşüldü': 'contacted',
    'gorusuldu': 'contacted',
    'toplantı planlandı': 'meeting_scheduled',
    'toplanti planlandi': 'meeting_scheduled',
    'teklif gönderildi': 'proposal_sent',
    'teklif gonderildi': 'proposal_sent',
    'müzakere': 'negotiation',
    'muzakere': 'negotiation',
    'kazanıldı': 'won',
    'kazanildi': 'won',
    'kaybedildi': 'lost',
    'ilgilenmiyorlar': 'lost',
    'ilgilenmiyor': 'lost',
    'reddedildi': 'lost',
    'iptal': 'lost',
    'beklemede': 'on_hold',
    'bekleniyor': 'on_hold',
};

/**
 * Normalize a stage value: try exact match, then Turkish alias, then return null
 */
function normalizeStage(raw: string): { stage: string; overflow: string | null } {
    const lower = raw.toLowerCase().trim();

    // Exact English match
    if (VALID_STAGES.includes(lower)) {
        return { stage: lower, overflow: null };
    }

    // Turkish alias match
    if (STAGE_ALIASES[lower]) {
        return { stage: STAGE_ALIASES[lower], overflow: null };
    }

    // Unrecognized → default to 'new', save original as overflow note
    return { stage: 'new', overflow: raw };
}

interface ImportError {
    row: number;
    field: string;
    error: string;
}

interface ImportResult {
    importJobId: string;
    totalRows: number;
    successCount: number;
    errorCount: number;
    errors: ImportError[];
    createdCompanies: number;
    updatedCompanies: number;
    createdContacts: number;
    cancelled?: boolean;
}

interface ColumnMapping {
    [fileHeader: string]: string | null; // null = custom_field
}

/**
 * Parse a CSV file and return rows as objects
 */
export async function parseCSV(filePath: string): Promise<{ headers: string[]; rows: Record<string, string>[] }> {
    const fileContent = fs.readFileSync(filePath, 'utf-8');

    return new Promise((resolve, reject) => {
        Papa.parse(fileContent, {
            header: true,
            skipEmptyLines: true,
            transformHeader: (h: string) => h.trim(),
            complete: (results) => {
                const headers = results.meta.fields || [];
                const rows = results.data as Record<string, string>[];
                resolve({ headers, rows });
            },
            error: (err: Error) => reject(err),
        });
    });
}

/**
 * Parse an XLSX file and return rows as objects
 */
export async function parseXLSX(filePath: string): Promise<{ headers: string[]; rows: Record<string, string>[] }> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);

    const worksheet = workbook.worksheets[0];
    if (!worksheet || worksheet.rowCount < 2) {
        return { headers: [], rows: [] };
    }

    // Get headers from first row
    const headerRow = worksheet.getRow(1);
    const headers: string[] = [];
    headerRow.eachCell((cell, colNumber) => {
        headers[colNumber - 1] = String(cell.value || '').trim();
    });

    // Get data rows
    const rows: Record<string, string>[] = [];
    for (let i = 2; i <= worksheet.rowCount; i++) {
        const row = worksheet.getRow(i);
        const rowData: Record<string, string> = {};
        let hasData = false;

        row.eachCell((cell, colNumber) => {
            const header = headers[colNumber - 1];
            if (header) {
                const value = sanitizeCell(cell.value);
                if (value) hasData = true;
                rowData[header] = value;
            }
        });

        if (hasData) {
            // Fill missing headers with empty strings
            for (const h of headers) {
                if (!(h in rowData)) rowData[h] = '';
            }
            rows.push(rowData);
        }
    }

    return { headers: headers.filter(Boolean), rows };
}

/**
 * Create an import job record and return its ID.
 * Call this before executeImport to get a jobId for progress polling.
 */
export async function createImportJob(
    tenantId: string,
    userId: string,
    fileName: string,
    fileType: 'csv' | 'xlsx' | 'matched',
    totalRows: number,
    mapping: ColumnMapping,
): Promise<string> {
    const storedFileType = fileType === 'matched' ? 'csv' : fileType;
    const { data: job, error } = await supabaseAdmin
        .from('import_jobs')
        .insert({
            tenant_id: tenantId,
            file_name: fileName,
            file_type: storedFileType,
            status: 'processing',
            total_rows: totalRows,
            column_mapping: mapping,
            created_by: userId,
            progress_count: 0,
        })
        .select('id')
        .single();

    if (error || !job) {
        throw new Error('Failed to create import job: ' + error?.message);
    }
    return job.id;
}

/**
 * Execute the import: validate, dedup, insert/update
 * Uses pre-fetched company/contact maps to minimize Supabase round-trips.
 * Updates progress_count every 20 rows for real-time progress polling.
 */
export async function executeImport(
    tenantId: string,
    userId: string,
    fileName: string,
    fileType: 'csv' | 'xlsx' | 'matched',
    rows: Record<string, string>[],
    mapping: ColumnMapping,
    jobId: string,
): Promise<ImportResult> {
    const errors: ImportError[] = [];
    let successCount = 0;
    let createdCompanies = 0;
    let updatedCompanies = 0;

    // Build reverse mapping: dbField -> fileHeader
    const reverseMap: Record<string, string> = {};
    const customFieldHeaders: string[] = [];

    for (const [fileHeader, dbField] of Object.entries(mapping)) {
        if (dbField) {
            reverseMap[dbField] = fileHeader;
        } else {
            customFieldHeaders.push(fileHeader);
        }
    }

    // Helper to get value from row using mapping
    const getValue = (row: Record<string, string>, dbField: string): string => {
        const fileHeader = reverseMap[dbField];
        if (!fileHeader) return '';
        return sanitizeCell(row[fileHeader] || '');
    };

    // ── Pre-fetch all existing companies for this tenant (one query) ──
    const { data: existingCompaniesRaw } = await supabaseAdmin
        .from('companies')
        .select('id, name, custom_fields')
        .eq('tenant_id', tenantId);

    const companyByName = new Map<string, { id: string; custom_fields: Record<string, unknown> }>();
    for (const c of existingCompaniesRaw || []) {
        companyByName.set(c.name.toLowerCase(), { id: c.id, custom_fields: c.custom_fields || {} });
    }

    // ── Pre-fetch all existing contacts (email → Set of company_ids) ──
    const { data: existingContactsRaw } = await supabaseAdmin
        .from('contacts')
        .select('email, company_id')
        .eq('tenant_id', tenantId)
        .not('email', 'is', null);

    const contactKeySet = new Set<string>(); // "email::company_id"
    for (const c of existingContactsRaw || []) {
        if (c.email && c.company_id) {
            contactKeySet.add(`${c.email.toLowerCase()}::${c.company_id}`);
        }
    }

    let wasCancelled = false;
    let createdContacts = 0;

    // ── Process each row ──
    for (let i = 0; i < rows.length; i++) {
        // ── Cancel check + progress update every 20 rows (at loop start, unaffected by continue) ──
        if (i > 0 && i % 20 === 0) {
            const { data: jobStatus } = await supabaseAdmin
                .from('import_jobs')
                .select('cancelled')
                .eq('id', jobId)
                .single();

            if (jobStatus?.cancelled) {
                wasCancelled = true;
                break;
            }

            await supabaseAdmin.from('import_jobs')
                .update({ progress_count: i })
                .eq('id', jobId);
        }

        const row = rows[i];
        const rowNum = i + 2; // +2 for 1-indexed + header row

        try {
            const companyName = getValue(row, 'companies.name');

            if (!companyName) {
                errors.push({ row: rowNum, field: 'company_name', error: 'Required field is empty' });
                continue;
            }

            const rawStage = getValue(row, 'companies.stage');
            let resolvedStage = 'new';
            let stageOverflow: string | null = null;

            if (rawStage) {
                const normalized = normalizeStage(rawStage);
                resolvedStage = normalized.stage;
                stageOverflow = normalized.overflow;
            }

            // Build custom_fields from unmapped columns
            const customFields: Record<string, string> = {};
            for (const header of customFieldHeaders) {
                const val = sanitizeCell(row[header] || '');
                if (val) customFields[header] = val;
            }
            if (stageOverflow) customFields['original_stage'] = stageOverflow;

            const existingCompany = companyByName.get(companyName.toLowerCase());

            // Build company data
            const companyData: Record<string, unknown> = {
                name: companyName,
                website: getValue(row, 'companies.website') || null,
                location: getValue(row, 'companies.location') || null,
                industry: (() => { const v = getValue(row, 'companies.industry'); return v ? v.charAt(0).toUpperCase() + v.slice(1) : null; })(),
                employee_size: getValue(row, 'companies.employee_size') || null,
                product_services: getValue(row, 'companies.product_services') || null,
                description: getValue(row, 'companies.description') || null,
                linkedin: getValue(row, 'companies.linkedin') || null,
                company_phone: getValue(row, 'companies.company_phone') || null,
                stage: resolvedStage,
                deal_summary: getValue(row, 'companies.deal_summary') || null,
                next_step: getValue(row, 'companies.next_step') || null,
            };

            if (Object.keys(customFields).length > 0) {
                const existingCustom = existingCompany?.custom_fields || {};
                companyData.custom_fields = { ...existingCustom, ...customFields };
            }

            let companyId: string;

            if (existingCompany) {
                // Update existing company
                const { error: updateError } = await supabaseAdmin
                    .from('companies')
                    .update(companyData)
                    .eq('id', existingCompany.id);

                if (updateError) {
                    errors.push({ row: rowNum, field: 'company', error: 'Failed to update: ' + updateError.message });
                    continue;
                }
                companyId = existingCompany.id;
                updatedCompanies++;
            } else {
                // Insert new company
                const { data: newCompany, error: insertError } = await supabaseAdmin
                    .from('companies')
                    .insert({ ...companyData, tenant_id: tenantId, assigned_to: userId })
                    .select('id')
                    .single();

                if (insertError || !newCompany) {
                    errors.push({ row: rowNum, field: 'company', error: 'Failed to create: ' + insertError?.message });
                    continue;
                }
                companyId = newCompany.id;
                createdCompanies++;
                // Add to in-memory map so duplicate rows in same file are handled
                companyByName.set(companyName.toLowerCase(), { id: companyId, custom_fields: {} });
            }

            // Insert contact (dedup via in-memory set — no per-row SELECT needed)
            const contactFirstName = getValue(row, 'contacts.first_name');
            if (contactFirstName) {
                const contactEmail = getValue(row, 'contacts.email');
                const contactKey = contactEmail
                    ? `${contactEmail.toLowerCase()}::${companyId}`
                    : null;

                const isDuplicate = contactKey ? contactKeySet.has(contactKey) : false;

                if (!isDuplicate) {
                    const { error: contactError } = await supabaseAdmin
                        .from('contacts')
                        .insert({
                            tenant_id: tenantId,
                            company_id: companyId,
                            first_name: contactFirstName,
                            last_name: getValue(row, 'contacts.last_name') || null,
                            title: getValue(row, 'contacts.title') || null,
                            email: contactEmail || null,
                            phone_e164: getValue(row, 'contacts.phone_e164') || null,
                            linkedin: getValue(row, 'contacts.linkedin') || null,
                            country: getValue(row, 'contacts.country') || null,
                            seniority: getValue(row, 'contacts.seniority') || null,
                            department: getValue(row, 'contacts.department') || null,
                        });

                    if (contactError) {
                        errors.push({ row: rowNum, field: 'contact', error: 'Failed to create contact: ' + contactError.message });
                    } else {
                        createdContacts++;
                        // Track in-memory to prevent same-file duplicates
                        if (contactKey) contactKeySet.add(contactKey);
                    }
                }
            }

            successCount++;
        } catch (err: any) {
            errors.push({ row: rowNum, field: 'unknown', error: err.message || 'Unknown error' });
        }

    }

    // ── Finalize import job ──
    const processedRows = wasCancelled
        ? successCount + errors.length
        : rows.length;

    await supabaseAdmin
        .from('import_jobs')
        .update({
            status: wasCancelled ? 'cancelled' : (errors.length === rows.length ? 'failed' : 'completed'),
            success_count: successCount,
            error_count: errors.length,
            error_details: errors,
            progress_count: processedRows,
            completed_at: new Date().toISOString(),
        })
        .eq('id', jobId);

    return {
        importJobId: jobId,
        totalRows: wasCancelled ? processedRows : rows.length,
        successCount,
        errorCount: errors.length,
        errors,
        createdCompanies,
        updatedCompanies,
        createdContacts,
        cancelled: wasCancelled,
    };
}
