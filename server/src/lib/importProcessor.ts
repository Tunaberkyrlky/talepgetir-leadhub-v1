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
 * Execute the import: validate, dedup, insert/update
 */
export async function executeImport(
    tenantId: string,
    userId: string,
    fileName: string,
    fileType: 'csv' | 'xlsx' | 'matched',
    rows: Record<string, string>[],
    mapping: ColumnMapping,
): Promise<ImportResult> {
    const errors: ImportError[] = [];
    let successCount = 0;
    let createdCompanies = 0;
    let updatedCompanies = 0;
    let createdContacts = 0;

    // Create import job record
    // 'matched' is not yet in the DB constraint — store as 'csv' until migration is applied
    const storedFileType = fileType === 'matched' ? 'csv' : fileType;
    const { data: job, error: jobError } = await supabaseAdmin
        .from('import_jobs')
        .insert({
            tenant_id: tenantId,
            file_name: fileName,
            file_type: storedFileType,
            status: 'processing',
            total_rows: rows.length,
            column_mapping: mapping,
            created_by: userId,
        })
        .select()
        .single();

    if (jobError || !job) {
        throw new Error('Failed to create import job: ' + jobError?.message);
    }

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

    // Process each row
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowNum = i + 2; // +2 for 1-indexed + header row

        try {
            // Extract company fields
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
                if (val) {
                    customFields[header] = val;
                }
            }

            // If stage couldn't be mapped, save original value in custom_fields
            if (stageOverflow) {
                customFields['original_stage'] = stageOverflow;
            }

            // Dedup check: company name + website within tenant
            const website = getValue(row, 'companies.website');
            let existingCompany = null;

            const { data: dupCheck } = await supabaseAdmin
                .from('companies')
                .select('id, custom_fields')
                .eq('tenant_id', tenantId)
                .ilike('name', companyName)
                .limit(1);

            if (dupCheck && dupCheck.length > 0) {
                existingCompany = dupCheck[0];
            }

            // Build company data
            const companyData: Record<string, unknown> = {
                name: companyName,
                website: website || null,
                location: getValue(row, 'companies.location') || null,
                industry: getValue(row, 'companies.industry') || null,
                employee_count: getValue(row, 'companies.employee_count') || null,
                stage: resolvedStage,
                deal_summary: getValue(row, 'companies.deal_summary') || null,
                next_step: getValue(row, 'companies.next_step') || null,
            };

            // Merge custom_fields
            if (Object.keys(customFields).length > 0) {
                const existingCustom = (existingCompany?.custom_fields as Record<string, unknown>) || {};
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
                    .insert({
                        ...companyData,
                        tenant_id: tenantId,
                        assigned_to: userId,
                    })
                    .select('id')
                    .single();

                if (insertError || !newCompany) {
                    errors.push({ row: rowNum, field: 'company', error: 'Failed to create: ' + insertError?.message });
                    continue;
                }
                companyId = newCompany.id;
                createdCompanies++;
            }

            // Create contact if contact fields are mapped and have data
            const contactFirstName = getValue(row, 'contacts.first_name');
            if (contactFirstName) {
                const contactEmail = getValue(row, 'contacts.email');

                // Check for duplicate contact
                let contactExists = false;
                if (contactEmail) {
                    const { data: existingContact } = await supabaseAdmin
                        .from('contacts')
                        .select('id')
                        .eq('company_id', companyId)
                        .eq('tenant_id', tenantId)
                        .ilike('email', contactEmail)
                        .limit(1);
                    contactExists = !!(existingContact && existingContact.length > 0);
                }

                if (!contactExists) {
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
                            country: getValue(row, 'contacts.country') || null,
                            seniority: getValue(row, 'contacts.seniority') || null,
                            department: getValue(row, 'contacts.department') || null,
                        });

                    if (contactError) {
                        errors.push({ row: rowNum, field: 'contact', error: 'Failed to create contact: ' + contactError.message });
                    } else {
                        createdContacts++;
                    }
                }
            }

            successCount++;
        } catch (err: any) {
            errors.push({ row: rowNum, field: 'unknown', error: err.message || 'Unknown error' });
        }
    }

    // Update import job with results
    await supabaseAdmin
        .from('import_jobs')
        .update({
            status: errors.length === rows.length ? 'failed' : 'completed',
            success_count: successCount,
            error_count: errors.length,
            error_details: errors,
            completed_at: new Date().toISOString(),
        })
        .eq('id', job.id);

    return {
        importJobId: job.id,
        totalRows: rows.length,
        successCount,
        errorCount: errors.length,
        errors,
        createdCompanies,
        updatedCompanies,
        createdContacts,
    };
}
