/**
 * Import Processor — Core import logic for CSV/XLSX files
 * Handles parsing, validation, dedup, and insertion
 */

import Papa from 'papaparse';
import ExcelJS from 'exceljs';
import fs from 'fs';
import { supabaseAdmin } from './supabase.js';
import { sanitizeCell } from './importMapper.js';
import { createLogger } from './logger.js';

const log = createLogger('importProcessor');
const BATCH_SIZE = 500;

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
 * Batch strategy: scan all rows first, then bulk insert/upsert companies and contacts.
 * Reduces Supabase round-trips from O(rows) to O(rows/BATCH_SIZE).
 */
export async function executeImport(
    tenantId: string,
    userId: string,
    _fileName: string,
    _fileType: 'csv' | 'xlsx' | 'matched',
    rows: Record<string, string>[],
    mapping: ColumnMapping,
    jobId: string,
): Promise<ImportResult> {
    const t0 = Date.now();
    const errors: ImportError[] = [];

    // Build reverse mapping: dbField -> fileHeader
    const reverseMap: Record<string, string> = {};
    const customFieldHeaders: string[] = [];
    for (const [fileHeader, dbField] of Object.entries(mapping)) {
        if (dbField) reverseMap[dbField] = fileHeader;
        else customFieldHeaders.push(fileHeader);
    }
    const getValue = (row: Record<string, string>, dbField: string): string => {
        const fileHeader = reverseMap[dbField];
        if (!fileHeader) return '';
        return sanitizeCell(row[fileHeader] || '');
    };

    // ── Phase 1: Pre-fetch existing data (2 parallel queries) ──
    log.info({ rows: rows.length, jobId }, 'Import started — pre-fetching');
    const [companiesRes, contactsRes] = await Promise.all([
        supabaseAdmin.from('companies').select('id, name, custom_fields').eq('tenant_id', tenantId),
        supabaseAdmin.from('contacts').select('email, company_id').eq('tenant_id', tenantId).not('email', 'is', null),
    ]);

    const companyByName = new Map<string, { id: string; custom_fields: Record<string, unknown> }>();
    for (const c of companiesRes.data || []) {
        companyByName.set(c.name.toLowerCase(), { id: c.id, custom_fields: c.custom_fields || {} });
    }
    const contactKeySet = new Set<string>();
    for (const c of contactsRes.data || []) {
        if (c.email && c.company_id) contactKeySet.add(`${c.email.toLowerCase()}::${c.company_id}`);
    }
    log.info({ existingCompanies: companyByName.size, existingContacts: contactKeySet.size, elapsed: Date.now() - t0 }, 'Pre-fetch done');

    // ── Phase 2: Scan rows — build company insert/update maps ──
    // Map key = normalizedName, value = latest payload (last-row-wins per company)
    const newCompanyMap = new Map<string, Record<string, unknown>>();
    const updateCompanyMap = new Map<string, Record<string, unknown> & { id: string }>();
    const rowValid: boolean[] = new Array(rows.length).fill(false);
    const rowCompanyKey: string[] = new Array(rows.length).fill('');

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowNum = i + 2;
        const companyName = getValue(row, 'companies.name');

        if (!companyName) {
            errors.push({ row: rowNum, field: 'company_name', error: 'Required field is empty' });
            continue;
        }

        const rawStage = getValue(row, 'companies.stage');
        let resolvedStage = 'new';
        let stageOverflow: string | null = null;
        if (rawStage) {
            const { stage, overflow } = normalizeStage(rawStage);
            resolvedStage = stage;
            stageOverflow = overflow;
        }

        const customFields: Record<string, string> = {};
        for (const header of customFieldHeaders) {
            const val = sanitizeCell(row[header] || '');
            if (val) customFields[header] = val;
        }
        if (stageOverflow) customFields['original_stage'] = stageOverflow;

        const companyPayload: Record<string, unknown> = {
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

        const nameLower = companyName.toLowerCase();
        const existing = companyByName.get(nameLower);

        if (existing) {
            if (Object.keys(customFields).length > 0) {
                const prevCustom = (updateCompanyMap.get(nameLower)?.custom_fields as Record<string, string>) ?? existing.custom_fields;
                companyPayload.custom_fields = { ...prevCustom, ...customFields };
            }
            updateCompanyMap.set(nameLower, { ...companyPayload, id: existing.id });
        } else {
            if (Object.keys(customFields).length > 0) {
                const prevCustom = (newCompanyMap.get(nameLower)?.custom_fields as Record<string, string>) ?? {};
                companyPayload.custom_fields = { ...prevCustom, ...customFields };
            }
            newCompanyMap.set(nameLower, companyPayload);
        }

        rowValid[i] = true;
        rowCompanyKey[i] = nameLower;
    }

    log.info({
        newCompanies: newCompanyMap.size,
        updateCompanies: updateCompanyMap.size,
        validRows: rowValid.filter(Boolean).length,
        rowErrors: errors.length,
        elapsed: Date.now() - t0,
    }, 'Row scan done');

    // ── Cancel check ──
    const { data: jobStatus1 } = await supabaseAdmin.from('import_jobs').select('cancelled').eq('id', jobId).single();
    if (jobStatus1?.cancelled) {
        await supabaseAdmin.from('import_jobs').update({ status: 'cancelled', progress_count: 0, completed_at: new Date().toISOString() }).eq('id', jobId);
        return { importJobId: jobId, totalRows: rows.length, successCount: 0, errorCount: errors.length, errors, createdCompanies: 0, updatedCompanies: 0, createdContacts: 0, cancelled: true };
    }

    // ── Phase 3: Batch insert new companies ──
    let createdCompanies = 0;
    const failedCompanyNames = new Set<string>();

    if (newCompanyMap.size > 0) {
        const toInsert = Array.from(newCompanyMap.values()).map(p => ({ ...p, tenant_id: tenantId, assigned_to: userId })) as unknown as Array<Record<string, unknown> & { name: string }>;
        log.info({ count: toInsert.length }, 'Batch inserting new companies');
        const t1 = Date.now();

        for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
            const chunk = toInsert.slice(i, i + BATCH_SIZE);
            const { data: inserted, error } = await supabaseAdmin.from('companies').insert(chunk).select('id, name');
            if (error || !inserted) {
                for (const c of chunk) failedCompanyNames.add((c.name as string).toLowerCase());
                log.error({ error: error?.message, batch: Math.floor(i / BATCH_SIZE) + 1 }, 'Company insert batch failed');
            } else {
                for (const c of inserted) companyByName.set(c.name.toLowerCase(), { id: c.id, custom_fields: {} });
                createdCompanies += inserted.length;
                log.info({ batch: Math.floor(i / BATCH_SIZE) + 1, inserted: inserted.length, elapsed: Date.now() - t1 }, 'Company insert batch done');
            }
        }
        await supabaseAdmin.from('import_jobs').update({ progress_count: Math.floor(rows.length * 0.4) }).eq('id', jobId);
    }

    // ── Phase 4: Batch upsert existing companies ──
    let updatedCompanies = 0;

    if (updateCompanyMap.size > 0) {
        const toUpdate = Array.from(updateCompanyMap.values()).map(p => ({ ...p, tenant_id: tenantId })) as unknown as Array<Record<string, unknown> & { name: string }>;
        log.info({ count: toUpdate.length }, 'Batch upserting existing companies');
        const t2 = Date.now();

        for (let i = 0; i < toUpdate.length; i += BATCH_SIZE) {
            const chunk = toUpdate.slice(i, i + BATCH_SIZE);
            const { error } = await supabaseAdmin.from('companies').upsert(chunk, { onConflict: 'id' });
            if (error) {
                for (const c of chunk) failedCompanyNames.add((c.name as string).toLowerCase());
                log.error({ error: error.message, batch: Math.floor(i / BATCH_SIZE) + 1 }, 'Company upsert batch failed');
            } else {
                updatedCompanies += chunk.length;
                log.info({ batch: Math.floor(i / BATCH_SIZE) + 1, updated: chunk.length, elapsed: Date.now() - t2 }, 'Company upsert batch done');
            }
        }
        await supabaseAdmin.from('import_jobs').update({ progress_count: Math.floor(rows.length * 0.6) }).eq('id', jobId);
    }

    // ── Cancel check ──
    const { data: jobStatus2 } = await supabaseAdmin.from('import_jobs').select('cancelled').eq('id', jobId).single();
    if (jobStatus2?.cancelled) {
        await supabaseAdmin.from('import_jobs').update({ status: 'cancelled', progress_count: createdCompanies + updatedCompanies, completed_at: new Date().toISOString() }).eq('id', jobId);
        return { importJobId: jobId, totalRows: rows.length, successCount: createdCompanies + updatedCompanies, errorCount: errors.length, errors, createdCompanies, updatedCompanies, createdContacts: 0, cancelled: true };
    }

    // ── Phase 5: Collect and batch insert contacts ──
    const contactsToInsert: Record<string, unknown>[] = [];
    let successCount = 0;

    for (let i = 0; i < rows.length; i++) {
        if (!rowValid[i]) continue;
        const nameLower = rowCompanyKey[i];
        if (failedCompanyNames.has(nameLower)) {
            errors.push({ row: i + 2, field: 'company', error: 'Company operation failed' });
            continue;
        }
        const companyInfo = companyByName.get(nameLower);
        if (!companyInfo) {
            errors.push({ row: i + 2, field: 'company', error: 'Company not resolved after insert' });
            continue;
        }
        successCount++;

        const row = rows[i];
        const contactFirstName = getValue(row, 'contacts.first_name');
        if (!contactFirstName) continue;

        const contactEmail = getValue(row, 'contacts.email');
        const contactKey = contactEmail ? `${contactEmail.toLowerCase()}::${companyInfo.id}` : null;
        if (contactKey && contactKeySet.has(contactKey)) continue;
        if (contactKey) contactKeySet.add(contactKey);

        contactsToInsert.push({
            tenant_id: tenantId,
            company_id: companyInfo.id,
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
    }

    let createdContacts = 0;
    if (contactsToInsert.length > 0) {
        log.info({ count: contactsToInsert.length }, 'Batch inserting contacts');
        const t3 = Date.now();

        for (let i = 0; i < contactsToInsert.length; i += BATCH_SIZE) {
            const chunk = contactsToInsert.slice(i, i + BATCH_SIZE);
            const { error } = await supabaseAdmin.from('contacts').insert(chunk);
            if (error) {
                log.error({ error: error.message, batch: Math.floor(i / BATCH_SIZE) + 1 }, 'Contact insert batch failed');
                errors.push({ row: -1, field: 'contact', error: `Batch contact insert failed: ${error.message}` });
            } else {
                createdContacts += chunk.length;
                log.info({ batch: Math.floor(i / BATCH_SIZE) + 1, inserted: chunk.length, elapsed: Date.now() - t3 }, 'Contact insert batch done');
            }
        }
    }

    // ── Finalize ──
    const totalElapsed = Date.now() - t0;
    log.info({ successCount, errorCount: errors.length, createdCompanies, updatedCompanies, createdContacts, totalElapsed }, 'Import complete');

    await supabaseAdmin
        .from('import_jobs')
        .update({
            status: errors.length === rows.length ? 'failed' : 'completed',
            success_count: successCount,
            error_count: errors.length,
            error_details: errors,
            progress_count: rows.length,
            completed_at: new Date().toISOString(),
        })
        .eq('id', jobId);

    return {
        importJobId: jobId,
        totalRows: rows.length,
        successCount,
        errorCount: errors.length,
        errors,
        createdCompanies,
        updatedCompanies,
        createdContacts,
    };
}
