/**
 * Import Processor — Core import logic for CSV/XLSX files
 * Handles parsing, validation, dedup, and insertion
 */

import Papa from 'papaparse';
import ExcelJS from 'exceljs';
import fs from 'fs';
import { supabaseAdmin } from './supabase.js';
import { sanitizeCell } from './importMapper.js';
import { cleanWebsite } from './dataMatcher.js';
import { createLogger } from './logger.js';
import { getTenantStages } from '../routes/settings.js';
const log = createLogger('importProcessor');
const BATCH_SIZE = 500;

// Turkish → English stage mapping for CSV import
const STAGE_ALIASES: Record<string, string> = {
    'soğuk': 'cold',
    'soguk': 'cold',
    'sırada': 'in_queue',
    'sirada': 'in_queue',
    'yeni': 'in_queue',
    'new': 'in_queue',
    'ilk temas': 'first_contact',
    'ilk iletişim': 'first_contact',
    'bağlantı kuruldu': 'connected',
    'baglanti kuruldu': 'connected',
    'iletişime geçildi': 'connected',
    'nitelikli': 'qualified',
    'kalifiye': 'qualified',
    'görüşmede': 'in_meeting',
    'gorusmede': 'in_meeting',
    'toplantı planlandı': 'in_meeting',
    'toplanti planlandi': 'in_meeting',
    'takipte': 'follow_up',
    'takip': 'follow_up',
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
    'askıda': 'on_hold',
    'askida': 'on_hold',
    'beklemede': 'on_hold',
    'bekleniyor': 'on_hold',
};

/**
 * Normalize a stage value against the tenant's actual stage slugs.
 * Falls back to the tenant's initial stage slug (e.g. 'cold') for unrecognised values.
 */
function normalizeStage(
    raw: string,
    validStages: string[],
    initialStageSlug: string,
): { stage: string; overflow: string | null } {
    const lower = raw.toLowerCase().trim();

    // Exact match against tenant's valid stages
    if (validStages.includes(lower)) {
        return { stage: lower, overflow: null };
    }

    // Turkish alias → resolved slug must also be valid for this tenant
    const aliased = STAGE_ALIASES[lower];
    if (aliased && validStages.includes(aliased)) {
        return { stage: aliased, overflow: null };
    }

    // Unrecognised → fall back to tenant's initial stage, preserve original
    return { stage: initialStageSlug, overflow: raw };
}

/**
 * Normalize email_status values from external sources (e.g. OmniVerifier)
 */
function normalizeEmailStatus(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const lower = raw.toLowerCase().trim();
    if (lower === 'valid') return 'valid';
    if (lower === 'catch-all' || lower === 'catch_all' || lower === 'catchall') return 'uncertain';
    if (lower === 'uncertain') return 'uncertain';
    if (lower === 'unvalid' || lower === 'invalid' || lower === 'not valid') return 'invalid';
    return null;
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
    defaultCompanyName?: string,
): Promise<ImportResult> {
    const t0 = Date.now();

    try {
    return await _executeImportInner(tenantId, userId, rows, mapping, jobId, defaultCompanyName);
    } catch (err) {
        // Ensure job is marked as failed if an unexpected error crashes the import
        log.error({ err, jobId }, 'Import crashed — marking job as failed');
        try {
            await supabaseAdmin.from('import_jobs').update({
                status: 'failed',
                completed_at: new Date().toISOString(),
                error_details: [{ row: -1, field: 'system', error: String((err as Error)?.message || err) }],
            }).eq('id', jobId).eq('status', 'processing');
        } catch (updateErr) {
            log.error({ err: updateErr }, 'Failed to mark crashed job as failed');
        }
        throw err;
    }
}

async function _executeImportInner(
    tenantId: string,
    userId: string,
    rows: Record<string, string>[],
    mapping: ColumnMapping,
    jobId: string,
    defaultCompanyName?: string,
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

    // ── Phase 1: Pre-fetch existing data + tenant stage config ──
    log.info({ rows: rows.length, jobId }, 'Import started — pre-fetching');

    // Load tenant's valid stages once for the entire import run
    const tenantStages = await getTenantStages(tenantId);
    const validStages = tenantStages.map((s) => s.slug);
    const initialStageSlug = tenantStages.find((s) => s.stage_type === 'initial')?.slug ?? 'cold';
    log.info({ validStages, initialStageSlug }, 'Tenant stages loaded');

    async function fetchAll<T>(buildQuery: () => any): Promise<T[]> {
        const PAGE = 1000;
        const all: T[] = [];
        let offset = 0;
        while (true) {
            const { data, error } = await buildQuery().range(offset, offset + PAGE - 1);
            if (error) { log.error({ error: error.message }, 'Paginated fetch error'); break; }
            if (!data || data.length === 0) break;
            all.push(...data);
            if (data.length < PAGE) break;
            offset += PAGE;
        }
        return all;
    }

    const [companiesData, contactsData] = await Promise.all([
        fetchAll<{ id: string; name: string; website: string | null; custom_fields: Record<string, unknown> }>(
            () => supabaseAdmin.from('companies').select('id, name, website, custom_fields').eq('tenant_id', tenantId)
        ),
        fetchAll<{ email: string; company_id: string }>(
            () => supabaseAdmin.from('contacts').select('email, company_id').eq('tenant_id', tenantId).not('email', 'is', null)
        ),
    ]);

    // Primary lookup: cleaned website → company (used for dedup)
    const companyByWebsite = new Map<string, { id: string; custom_fields: Record<string, unknown> }>();
    for (const c of companiesData) {
        const cleanedSite = cleanWebsite(c.website || '');
        if (cleanedSite) {
            companyByWebsite.set(cleanedSite, { id: c.id, custom_fields: c.custom_fields || {} });
        }
    }
    const contactKeySet = new Set<string>();
    for (const c of contactsData) {
        if (c.email && c.company_id) contactKeySet.add(`${c.email.toLowerCase()}::${c.company_id}`);
    }
    log.info({ existingCompanies: companyByWebsite.size, existingContacts: contactKeySet.size, elapsed: Date.now() - t0 }, 'Pre-fetch done');

    // ── Phase 2: Scan rows — build company insert/update maps ──
    // Map key = cleanedWebsite, value = latest payload (last-row-wins per company)
    const newCompanyMap = new Map<string, Record<string, unknown>>();
    const updateCompanyMap = new Map<string, Record<string, unknown> & { id: string }>();
    const rowValid: boolean[] = new Array(rows.length).fill(false);
    const rowCompanyKey: string[] = new Array(rows.length).fill('');

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowNum = i + 2;
        const companyName = getValue(row, 'companies.name') || defaultCompanyName || '';
        const rawWebsite = getValue(row, 'companies.website');
        const websiteKey = cleanWebsite(rawWebsite);
        if (!companyName) {
            errors.push({ row: rowNum, field: 'company_name', error: 'Required field is empty' });
            continue;
        }

        const rawStage = getValue(row, 'companies.stage');
        let resolvedStage = initialStageSlug;
        let stageOverflow: string | null = null;
        if (rawStage) {
            const { stage, overflow } = normalizeStage(rawStage, validStages, initialStageSlug);
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
            website: rawWebsite || null,
            location: getValue(row, 'companies.location') || null,
            industry: (() => { const v = getValue(row, 'companies.industry'); return v ? v.charAt(0).toUpperCase() + v.slice(1) : null; })(),
            employee_size: getValue(row, 'companies.employee_size') || null,
            product_services: getValue(row, 'companies.product_services') || null,
            product_portfolio: getValue(row, 'companies.product_portfolio') || null,
            linkedin: getValue(row, 'companies.linkedin') || null,
            company_phone: getValue(row, 'companies.company_phone') || null,
            company_email: getValue(row, 'companies.company_email') || null,
            ...(() => { const es = normalizeEmailStatus(getValue(row, 'companies.email_status')); return es ? { email_status: es } : {}; })(),
            stage: resolvedStage,
            company_summary: getValue(row, 'companies.company_summary') || null,
            next_step: getValue(row, 'companies.next_step') || null,
            fit_score: getValue(row, 'companies.fit_score') || null,
            partnership_observation_1: getValue(row, 'companies.partnership_observation_1') || null,
            partnership_observation_2: getValue(row, 'companies.partnership_observation_2') || null,
            partnership_observation_3: getValue(row, 'companies.partnership_observation_3') || null,
        };

        // Dedup by website if available; otherwise treat as new company
        const existing = websiteKey ? companyByWebsite.get(websiteKey) : undefined;
        // Use websiteKey for dedup, or generate a unique key for website-less rows
        const mapKey = websiteKey || `__no_website_${i}`;

        if (existing) {
            // Only include fields that have actual values — preserve existing data for empty fields
            const updatePayload: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(companyPayload)) {
                if (value !== null && value !== undefined && value !== '') {
                    updatePayload[key] = value;
                }
            }
            if (Object.keys(customFields).length > 0) {
                const prevCustom = (updateCompanyMap.get(mapKey)?.custom_fields as Record<string, string>) ?? existing.custom_fields;
                updatePayload.custom_fields = { ...prevCustom, ...customFields };
            }
            updateCompanyMap.set(mapKey, { ...updatePayload, id: existing.id } as Record<string, unknown> & { id: string });
        } else {
            if (Object.keys(customFields).length > 0) {
                const prevCustom = (newCompanyMap.get(mapKey)?.custom_fields as Record<string, string>) ?? {};
                companyPayload.custom_fields = { ...prevCustom, ...customFields };
            }
            newCompanyMap.set(mapKey, companyPayload);
        }

        rowValid[i] = true;
        rowCompanyKey[i] = mapKey;
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
    const failedCompanyKeys = new Set<string>();

    if (newCompanyMap.size > 0) {
        const newEntries = Array.from(newCompanyMap.entries()); // [mapKey, payload]
        const toInsert = newEntries.map(([, p]) => {
            // Geocoding skipped — user can trigger manually via dashboard "Konumları Güncelle" button
            return { ...p, tenant_id: tenantId, assigned_to: userId };
        });
        log.info({ count: toInsert.length }, 'Batch inserting new companies');
        const t1 = Date.now();

        for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
            const chunk = toInsert.slice(i, i + BATCH_SIZE);
            const chunkKeys = newEntries.slice(i, i + BATCH_SIZE).map(([k]) => k);
            const { data: inserted, error } = await supabaseAdmin.from('companies').insert(chunk).select('id');
            if (error || !inserted) {
                for (const k of chunkKeys) failedCompanyKeys.add(k);
                log.error({ error: error?.message, batch: Math.floor(i / BATCH_SIZE) + 1 }, 'Company insert batch failed');
            } else if (inserted.length !== chunkKeys.length) {
                log.warn({ expected: chunkKeys.length, got: inserted.length, batch: Math.floor(i / BATCH_SIZE) + 1 }, 'Insert count mismatch — treating batch as failed');
                for (const k of chunkKeys) failedCompanyKeys.add(k);
            } else {
                for (let j = 0; j < inserted.length; j++) {
                    companyByWebsite.set(chunkKeys[j], { id: inserted[j].id, custom_fields: {} });
                }
                createdCompanies += inserted.length;
                log.info({ batch: Math.floor(i / BATCH_SIZE) + 1, inserted: inserted.length, elapsed: Date.now() - t1 }, 'Company insert batch done');
            }
        }
        await supabaseAdmin.from('import_jobs').update({ progress_count: Math.floor(rows.length * 0.4) }).eq('id', jobId);
    }

    // ── Phase 4: Batch upsert existing companies ──
    let updatedCompanies = 0;

    if (updateCompanyMap.size > 0) {
        const updateEntries = Array.from(updateCompanyMap.entries());
        const toUpdate = updateEntries.map(([, p]) => {
            return { ...p, tenant_id: tenantId };
        });
        log.info({ count: toUpdate.length }, 'Batch upserting existing companies');
        const t2 = Date.now();

        for (let i = 0; i < toUpdate.length; i += BATCH_SIZE) {
            const chunk = toUpdate.slice(i, i + BATCH_SIZE);
            const chunkKeys = updateEntries.slice(i, i + BATCH_SIZE).map(([k]) => k);
            const { error } = await supabaseAdmin.from('companies').upsert(chunk, { onConflict: 'id' });
            if (error) {
                for (const k of chunkKeys) failedCompanyKeys.add(k);
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
        const companyKey = rowCompanyKey[i];
        if (failedCompanyKeys.has(companyKey)) {
            errors.push({ row: i + 2, field: 'company', error: 'Company operation failed' });
            continue;
        }
        const companyInfo = companyByWebsite.get(companyKey);
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
