/**
 * Campaign Import Processor — CSV alıcı listesini drip kampanyasına import eder.
 *
 * Akış: kampanya + giriş adımı doğrula (yazım öncesi) → satırları normalize et
 * (e-posta, statü, dosya içi dedupe) → companies upsert → sentetik contact insert
 * → enrollment batch insert (excluded_reason mantığı + conflict-skip) → özet.
 *
 * importProcessor._executeImportInner desenini izler: faz arası cancel check,
 * progress_count güncellemeleri, crash → job 'failed'. CRM yolu savaşta test
 * edildiği için refactor edilmez; buradaki mütevazı kopya bilinçlidir.
 * Plan: plans/DRIP_CSV_IMPORT_PLAN.md
 */

import { supabaseAdmin } from './supabase.js';
import { sanitizeCell } from './importMapper.js';
import { cleanWebsite } from './dataMatcher.js';
import { clearCompanyCache } from './emailMatcher.js';
import { getEntryStepSchedule } from './campaignEngine.js';
import { getTenantStages } from '../routes/settings.js';
import { createLogger } from './logger.js';
import { AppError } from '../middleware/errorHandler.js';

const log = createLogger('campaignImportProcessor');
const BATCH_SIZE = 500;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type CampaignEmailStatus = 'ok' | 'catch_all' | 'unknown' | 'invalid' | 'error';

interface ImportError {
    row: number;
    field: string;
    error: string;
}

export interface CampaignImportSummary {
    enrolled: number; // gönderime uygun (active) eklenen
    excluded: Record<string, number>; // excluded_reason → adet
    skippedDuplicateInFile: number;
    skippedAlreadyEnrolled: number;
    byStatus: Record<string, number>; // normalize e-posta statüsü → adet
    estimatedDays: number | null; // ceil(enrolled / daily_limit)
}

interface CampaignImportResult {
    importJobId: string;
    totalRows: number;
    successCount: number; // eklenen enrollment sayısı (excluded dahil)
    errorCount: number;
    errors: ImportError[];
    createdCompanies: number;
    updatedCompanies: number;
    createdContacts: number;
    campaign: CampaignImportSummary;
    cancelled?: boolean;
}

interface ColumnMapping {
    [fileHeader: string]: string | null;
}

// Kampanya statüsü normalize: harici doğrulayıcı yazımları tek forma iner.
// Boş hücre null (statü yok = filtrelenmez); tanınmayan değer 'unknown'.
export function normalizeCampaignEmailStatus(raw: string | null | undefined): CampaignEmailStatus | null {
    if (!raw || !raw.trim()) return null;
    const lower = raw.toLowerCase().trim();
    if (lower === 'ok' || lower === 'valid') return 'ok';
    if (lower === 'catch-all' || lower === 'catch_all' || lower === 'catchall' || lower === 'catch all') return 'catch_all';
    if (lower === 'invalid' || lower === 'unvalid' || lower === 'not valid') return 'invalid';
    if (lower === 'error') return 'error';
    return 'unknown';
}

// companies.email_status CHECK'i valid|uncertain|invalid kabul eder — kampanya
// statüsü CRM diline eşlenir (ham statü enrollment.email_status'ta kalır).
function toCrmEmailStatus(status: CampaignEmailStatus | null): string | null {
    if (!status) return null;
    if (status === 'ok') return 'valid';
    if (status === 'invalid' || status === 'error') return 'invalid';
    return 'uncertain'; // catch_all | unknown
}

// Hücredeki ilk regex-geçerli e-posta (lowercase) + kalan tokenlar.
export function extractEmails(cell: string): { email: string | null; others: string[] } {
    const tokens = cell.split(/[;,]/).map((t) => t.trim()).filter(Boolean);
    const idx = tokens.findIndex((t) => EMAIL_RE.test(t));
    if (idx === -1) return { email: null, others: tokens };
    return {
        email: tokens[idx].toLowerCase(),
        others: tokens.filter((_, i) => i !== idx),
    };
}

export function computeExcludedReason(
    emailStatus: CampaignEmailStatus | null,
    dncStatus: string | null,
    sendStatuses: string[],
): string | null {
    if (emailStatus === 'invalid') return 'invalid_status';
    if (emailStatus === 'error') return 'error_status';
    if (dncStatus && !/^ok/i.test(dncStatus.trim())) return 'dnc';
    if (emailStatus && !sendStatuses.includes(emailStatus)) return 'status_filtered';
    return null;
}

export async function executeCampaignImport(
    tenantId: string,
    userId: string,
    rows: Record<string, string>[],
    mapping: ColumnMapping,
    jobId: string,
    campaignId: string,
): Promise<CampaignImportResult> {
    try {
        return await _executeCampaignImportInner(tenantId, userId, rows, mapping, jobId, campaignId);
    } catch (err) {
        log.error({ err, jobId }, 'Campaign import crashed — marking job as failed');
        try {
            await supabaseAdmin.from('import_jobs').update({
                status: 'failed',
                completed_at: new Date().toISOString(),
                error_details: [{ row: -1, field: 'system', error: String((err as Error)?.message || err) }],
            }).eq('id', jobId).eq('status', 'processing');
        } catch (updateErr) {
            log.error({ err: updateErr }, 'Failed to mark crashed campaign import as failed');
        }
        throw err;
    }
}

async function _executeCampaignImportInner(
    tenantId: string,
    userId: string,
    rows: Record<string, string>[],
    mapping: ColumnMapping,
    jobId: string,
    campaignId: string,
): Promise<CampaignImportResult> {
    const t0 = Date.now();
    const errors: ImportError[] = [];

    // ── 1. Kampanya + giriş adımı — hiçbir yazım öncesi (404/422 fırlatır) ──
    const { entryStepId, firstScheduleAt, settings } = await getEntryStepSchedule(campaignId, tenantId);
    const sendStatuses: string[] = Array.isArray(settings.send_statuses) && settings.send_statuses.length > 0
        ? settings.send_statuses
        : ['ok', 'catch_all'];

    // Mapping: dbField → fileHeader
    const reverseMap: Record<string, string> = {};
    for (const [fileHeader, dbField] of Object.entries(mapping)) {
        if (dbField) reverseMap[dbField] = fileHeader;
    }
    const getValue = (row: Record<string, string>, dbField: string): string => {
        const fileHeader = reverseMap[dbField];
        if (!fileHeader) return '';
        return sanitizeCell(row[fileHeader] || '');
    };

    // ── 2. Satır normalize + dosya içi e-posta dedupe (ilk satır kazanır) ──
    interface NormalizedRow {
        index: number; // rows[] index
        rowNum: number; // dosyadaki satır (header = 1)
        companyName: string;
        website: string | null;
        location: string | null;
        industry: string | null;
        email: string | null; // null = geçersiz e-posta (şirket yine upsert edilir)
        otherEmails: string[];
        message: string | null;
        subject: string | null;
        emailStatus: CampaignEmailStatus | null;
        dncStatus: string | null;
        language: string | null;
        angle: string | null;
        region: string | null;
        sourceRow: string | null;
        duplicateInFile: boolean;
        excludedReason: string | null;
    }

    const normalized: NormalizedRow[] = [];
    const seenEmails = new Set<string>();
    let skippedDuplicateInFile = 0;
    const byStatus: Record<string, number> = {};

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowNum = i + 2;
        const companyName = getValue(row, 'companies.name');
        if (!companyName) {
            errors.push({ row: rowNum, field: 'company_name', error: 'Required field is empty' });
            continue;
        }

        const emailCell = getValue(row, 'campaign.email');
        const { email, others } = extractEmails(emailCell);
        if (!email) {
            errors.push({ row: rowNum, field: 'email', error: emailCell ? 'No valid email address in cell' : 'Required field is empty' });
        }

        const emailStatus = normalizeCampaignEmailStatus(getValue(row, 'campaign.email_status'));
        if (emailStatus) byStatus[emailStatus] = (byStatus[emailStatus] || 0) + 1;
        const dncStatus = getValue(row, 'campaign.dnc_status') || null;

        const duplicateInFile = !!email && seenEmails.has(email);
        if (duplicateInFile) skippedDuplicateInFile++;
        else if (email) seenEmails.add(email);

        normalized.push({
            index: i,
            rowNum,
            companyName,
            website: getValue(row, 'companies.website') || null,
            location: getValue(row, 'companies.location') || null,
            industry: (() => { const v = getValue(row, 'companies.industry'); return v ? v.charAt(0).toUpperCase() + v.slice(1) : null; })(),
            email,
            otherEmails: others,
            message: getValue(row, 'campaign.message') || null,
            subject: getValue(row, 'campaign.subject') || null,
            emailStatus,
            dncStatus,
            language: getValue(row, 'campaign.language') || null,
            angle: getValue(row, 'campaign.angle') || null,
            region: getValue(row, 'campaign.region') || null,
            sourceRow: getValue(row, 'campaign.source_row') || null,
            duplicateInFile,
            excludedReason: computeExcludedReason(emailStatus, dncStatus, sendStatuses),
        });
    }

    log.info({ rows: rows.length, normalized: normalized.length, rowErrors: errors.length, jobId, campaignId }, 'Campaign import — rows normalized');

    // ── Cancel check ──
    const summaryEmpty: CampaignImportSummary = { enrolled: 0, excluded: {}, skippedDuplicateInFile, skippedAlreadyEnrolled: 0, byStatus, estimatedDays: null };
    const { data: jobStatus1 } = await supabaseAdmin.from('import_jobs').select('cancelled').eq('id', jobId).single();
    if (jobStatus1?.cancelled) {
        await supabaseAdmin.from('import_jobs').update({ status: 'cancelled', progress_count: 0, completed_at: new Date().toISOString() }).eq('id', jobId);
        return { importJobId: jobId, totalRows: rows.length, successCount: 0, errorCount: errors.length, errors, createdCompanies: 0, updatedCompanies: 0, createdContacts: 0, campaign: summaryEmpty, cancelled: true };
    }

    // ── 3. Companies upsert (CRM deseninin sadeleşmiş kopyası) ──
    const tenantStages = await getTenantStages(tenantId);
    const initialStageSlug = tenantStages.find((s) => s.stage_type === 'initial')?.slug ?? 'cold';

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
        fetchAll<{ id: string; website: string | null }>(
            () => supabaseAdmin.from('companies').select('id, website').eq('tenant_id', tenantId)
        ),
        fetchAll<{ id: string; email: string | null; company_id: string }>(
            () => supabaseAdmin.from('contacts').select('id, email, company_id').eq('tenant_id', tenantId).not('email', 'is', null)
        ),
    ]);

    const companyByWebsite = new Map<string, { id: string }>();
    for (const c of companiesData) {
        const key = cleanWebsite(c.website || '');
        if (key) companyByWebsite.set(key, { id: c.id });
    }
    const contactIdByKey = new Map<string, string>(); // lower(email)::company_id → contact id
    for (const c of contactsData) {
        if (c.email && c.company_id) contactIdByKey.set(`${c.email.toLowerCase()}::${c.company_id}`, c.id);
    }

    // Satır → şirket anahtarı (website yoksa satıra özel sentetik anahtar)
    const newCompanyMap = new Map<string, Record<string, unknown>>();
    const updateCompanyMap = new Map<string, Record<string, unknown> & { id: string }>();
    const rowCompanyKey = new Map<number, string>(); // normalized index → mapKey

    for (const n of normalized) {
        const websiteKey = cleanWebsite(n.website || '');
        const mapKey = websiteKey || `__no_website_${n.index}`;
        rowCompanyKey.set(n.index, mapKey);

        const crmEmailStatus = toCrmEmailStatus(n.emailStatus);
        const existing = websiteKey ? companyByWebsite.get(websiteKey) : undefined;
        if (existing) {
            const updatePayload: Record<string, unknown> = { id: existing.id };
            if (n.companyName) updatePayload.name = n.companyName;
            if (n.website) updatePayload.website = n.website;
            if (n.location) updatePayload.location = n.location;
            if (n.industry) updatePayload.industry = n.industry;
            if (crmEmailStatus) updatePayload.email_status = crmEmailStatus;
            updateCompanyMap.set(mapKey, updatePayload as Record<string, unknown> & { id: string });
        } else {
            newCompanyMap.set(mapKey, {
                name: n.companyName,
                website: n.website,
                location: n.location,
                industry: n.industry,
                stage: initialStageSlug,
                ...(crmEmailStatus ? { email_status: crmEmailStatus } : {}),
            });
        }
    }

    let createdCompanies = 0;
    let updatedCompanies = 0;
    const failedCompanyKeys = new Set<string>();

    if (newCompanyMap.size > 0) {
        const newEntries = Array.from(newCompanyMap.entries());
        const toInsert = newEntries.map(([, p]) => ({ ...p, tenant_id: tenantId, assigned_to: userId }));
        for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
            const chunk = toInsert.slice(i, i + BATCH_SIZE);
            const chunkKeys = newEntries.slice(i, i + BATCH_SIZE).map(([k]) => k);
            const { data: inserted, error } = await supabaseAdmin.from('companies').insert(chunk).select('id');
            if (error || !inserted || inserted.length !== chunkKeys.length) {
                for (const k of chunkKeys) failedCompanyKeys.add(k);
                log.error({ error: error?.message, batch: Math.floor(i / BATCH_SIZE) + 1 }, 'Campaign import: company insert batch failed');
            } else {
                for (let j = 0; j < inserted.length; j++) companyByWebsite.set(chunkKeys[j], { id: inserted[j].id });
                createdCompanies += inserted.length;
            }
        }
    }

    if (updateCompanyMap.size > 0) {
        const updateEntries = Array.from(updateCompanyMap.entries());
        const toUpdate = updateEntries.map(([, p]) => ({ ...p, tenant_id: tenantId }));
        for (let i = 0; i < toUpdate.length; i += BATCH_SIZE) {
            const chunk = toUpdate.slice(i, i + BATCH_SIZE);
            const chunkKeys = updateEntries.slice(i, i + BATCH_SIZE).map(([k]) => k);
            const { error } = await supabaseAdmin.from('companies').upsert(chunk, { onConflict: 'id' });
            if (error) {
                for (const k of chunkKeys) failedCompanyKeys.add(k);
                log.error({ error: error.message, batch: Math.floor(i / BATCH_SIZE) + 1 }, 'Campaign import: company upsert batch failed');
            } else {
                updatedCompanies += chunk.length;
            }
        }
    }

    await supabaseAdmin.from('import_jobs').update({ progress_count: Math.floor(rows.length * 0.4) }).eq('id', jobId);

    // ── 4. Sentetik contact'lar (CSV'de kişi adı yok → first_name = şirket adı) ──
    // Enroll edilebilir satır: geçerli e-posta + dosya içi ilk kopya + şirket çözülmüş.
    const enrollable = normalized.filter((n) => {
        if (!n.email || n.duplicateInFile) return false;
        const key = rowCompanyKey.get(n.index)!;
        if (failedCompanyKeys.has(key)) {
            errors.push({ row: n.rowNum, field: 'company', error: 'Company operation failed' });
            return false;
        }
        if (!companyByWebsite.get(key)) {
            errors.push({ row: n.rowNum, field: 'company', error: 'Company not resolved after insert' });
            return false;
        }
        return true;
    });

    const contactsToInsert: Record<string, unknown>[] = [];
    const pendingContactKeys = new Set<string>();
    for (const n of enrollable) {
        const companyId = companyByWebsite.get(rowCompanyKey.get(n.index)!)!.id;
        const contactKey = `${n.email}::${companyId}`;
        if (contactIdByKey.has(contactKey) || pendingContactKeys.has(contactKey)) continue;
        pendingContactKeys.add(contactKey);
        contactsToInsert.push({
            tenant_id: tenantId,
            company_id: companyId,
            first_name: n.companyName, // contacts.first_name NOT NULL; konu şablonu {{company_name}} kullanmalı
            email: n.email,
            country: n.location,
        });
    }

    let createdContacts = 0;
    for (let i = 0; i < contactsToInsert.length; i += BATCH_SIZE) {
        const chunk = contactsToInsert.slice(i, i + BATCH_SIZE);
        const { data: inserted, error } = await supabaseAdmin.from('contacts').insert(chunk).select('id, email, company_id');
        if (error || !inserted) {
            log.error({ error: error?.message, batch: Math.floor(i / BATCH_SIZE) + 1 }, 'Campaign import: contact insert batch failed');
            errors.push({ row: -1, field: 'contact', error: `Batch contact insert failed: ${error?.message || 'unknown'}` });
        } else {
            for (const c of inserted) {
                if (c.email && c.company_id) contactIdByKey.set(`${c.email.toLowerCase()}::${c.company_id}`, c.id);
            }
            createdContacts += inserted.length;
        }
    }

    await supabaseAdmin.from('import_jobs').update({ progress_count: Math.floor(rows.length * 0.7) }).eq('id', jobId);

    // ── Cancel check ──
    const { data: jobStatus2 } = await supabaseAdmin.from('import_jobs').select('cancelled').eq('id', jobId).single();
    if (jobStatus2?.cancelled) {
        await supabaseAdmin.from('import_jobs').update({ status: 'cancelled', progress_count: Math.floor(rows.length * 0.7), completed_at: new Date().toISOString() }).eq('id', jobId);
        return { importJobId: jobId, totalRows: rows.length, successCount: 0, errorCount: errors.length, errors, createdCompanies, updatedCompanies, createdContacts, campaign: summaryEmpty, cancelled: true };
    }

    // ── 5. Enrollment'lar (conflict-skip: aynı kampanyada aynı e-posta atlanır) ──
    const enrollmentRows: Record<string, unknown>[] = [];
    for (const n of enrollable) {
        const companyId = companyByWebsite.get(rowCompanyKey.get(n.index)!)!.id;
        const contactId = contactIdByKey.get(`${n.email}::${companyId}`);
        if (!contactId) {
            errors.push({ row: n.rowNum, field: 'contact', error: 'Contact not resolved after insert' });
            continue;
        }
        const eligible = n.excludedReason === null;
        const meta: Record<string, unknown> = {};
        if (n.angle) meta.angle = n.angle;
        if (n.language) meta.language = n.language;
        if (n.region) meta.region = n.region;
        if (n.website) meta.website = n.website;
        meta.source_row = n.sourceRow || String(n.rowNum);
        if (n.otherEmails.length > 0) meta.other_emails = n.otherEmails;

        enrollmentRows.push({
            tenant_id: tenantId,
            campaign_id: campaignId,
            contact_id: contactId,
            company_id: companyId,
            email: n.email,
            status: eligible ? 'active' : 'paused',
            current_step_id: entryStepId,
            next_scheduled_at: eligible ? firstScheduleAt : null,
            custom_subject: n.subject,
            custom_body_text: n.message,
            email_status: n.emailStatus,
            dnc_status: n.dncStatus,
            excluded_reason: n.excludedReason,
            import_job_id: jobId,
            meta,
        });
    }

    let insertedEnrollments = 0;
    let enrolledActive = 0;
    let skippedAlreadyEnrolled = 0;
    const excluded: Record<string, number> = {};

    for (let i = 0; i < enrollmentRows.length; i += BATCH_SIZE) {
        const chunk = enrollmentRows.slice(i, i + BATCH_SIZE);
        const { data: inserted, error } = await supabaseAdmin
            .from('campaign_enrollments')
            .upsert(chunk, { onConflict: 'campaign_id,email', ignoreDuplicates: true })
            .select('id, status, excluded_reason');
        if (error || !inserted) {
            log.error({ error: error?.message, batch: Math.floor(i / BATCH_SIZE) + 1 }, 'Campaign import: enrollment batch failed');
            errors.push({ row: -1, field: 'enrollment', error: `Batch enrollment insert failed: ${error?.message || 'unknown'}` });
        } else {
            insertedEnrollments += inserted.length;
            skippedAlreadyEnrolled += chunk.length - inserted.length;
            for (const e of inserted) {
                if (e.excluded_reason) excluded[e.excluded_reason] = (excluded[e.excluded_reason] || 0) + 1;
                else enrolledActive++;
            }
        }
    }

    // Denormalize sayaç — enrollLeads deseni (gerçek sayıdan türet, yarış koşulu yok)
    if (insertedEnrollments > 0) {
        const { count } = await supabaseAdmin
            .from('campaign_enrollments')
            .select('id', { count: 'exact', head: true })
            .eq('campaign_id', campaignId);
        await supabaseAdmin.from('campaigns').update({ total_enrolled: count || 0 }).eq('id', campaignId);
    }

    // ── 6. Finalize ──
    clearCompanyCache(tenantId);

    const dailyLimit = Number(settings.daily_limit) || 0;
    const campaignSummary: CampaignImportSummary = {
        enrolled: enrolledActive,
        excluded,
        skippedDuplicateInFile,
        skippedAlreadyEnrolled,
        byStatus,
        estimatedDays: dailyLimit > 0 && enrolledActive > 0 ? Math.ceil(enrolledActive / dailyLimit) : null,
    };

    await supabaseAdmin
        .from('import_jobs')
        .update({
            status: rows.length > 0 && errors.length === rows.length ? 'failed' : 'completed',
            success_count: insertedEnrollments,
            error_count: errors.length,
            error_details: errors,
            match_report: { version: 1, campaign: campaignSummary },
            progress_count: rows.length,
            completed_at: new Date().toISOString(),
        })
        .eq('id', jobId);

    log.info({
        jobId, campaignId, insertedEnrollments, enrolledActive, excluded,
        skippedDuplicateInFile, skippedAlreadyEnrolled,
        createdCompanies, updatedCompanies, createdContacts,
        elapsed: Date.now() - t0,
    }, 'Campaign import complete');

    return {
        importJobId: jobId,
        totalRows: rows.length,
        successCount: insertedEnrollments,
        errorCount: errors.length,
        errors,
        createdCompanies,
        updatedCompanies,
        createdContacts,
        campaign: campaignSummary,
    };
}

// Ön-uçuş özeti (salt-okunur): execute öncesi Preview adımı için satırları analiz
// eder, hiçbir yazım yapmaz. Modal'daki statü kırılımı rozetleri bunu gösterir.
export async function summarizeCampaignImport(
    tenantId: string,
    rows: Record<string, string>[],
    mapping: ColumnMapping,
    campaignId: string,
): Promise<{
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
}> {
    const { settings } = await getEntryStepSchedule(campaignId, tenantId);
    const sendStatuses: string[] = Array.isArray(settings.send_statuses) && settings.send_statuses.length > 0
        ? settings.send_statuses
        : ['ok', 'catch_all'];

    const reverseMap: Record<string, string> = {};
    for (const [fileHeader, dbField] of Object.entries(mapping)) {
        if (dbField) reverseMap[dbField] = fileHeader;
    }
    const getValue = (row: Record<string, string>, dbField: string): string => {
        const fileHeader = reverseMap[dbField];
        if (!fileHeader) return '';
        return sanitizeCell(row[fileHeader] || '');
    };

    const seen = new Set<string>();
    const byStatus: Record<string, number> = {};
    let dncExcluded = 0, duplicatesInFile = 0, invalidEmails = 0, multiEmailCells = 0, eligible = 0;

    for (const row of rows) {
        const { email, others } = extractEmails(getValue(row, 'campaign.email'));
        if (others.length > 0 && email) multiEmailCells++;
        if (!email) { invalidEmails++; continue; }
        if (seen.has(email)) { duplicatesInFile++; continue; }
        seen.add(email);

        const emailStatus = normalizeCampaignEmailStatus(getValue(row, 'campaign.email_status'));
        if (emailStatus) byStatus[emailStatus] = (byStatus[emailStatus] || 0) + 1;
        const dncStatus = getValue(row, 'campaign.dnc_status') || null;
        const reason = computeExcludedReason(emailStatus, dncStatus, sendStatuses);
        if (reason === 'dnc') dncExcluded++;
        if (reason === null) eligible++;
    }

    const dailyLimit = Number(settings.daily_limit) || 0;
    return {
        total: rows.length,
        byStatus,
        dncExcluded,
        duplicatesInFile,
        invalidEmails,
        multiEmailCells,
        eligible,
        estimatedDays: dailyLimit > 0 && eligible > 0 ? Math.ceil(eligible / dailyLimit) : null,
        sendStatuses,
        dailyLimit: dailyLimit > 0 ? dailyLimit : null,
    };
}
