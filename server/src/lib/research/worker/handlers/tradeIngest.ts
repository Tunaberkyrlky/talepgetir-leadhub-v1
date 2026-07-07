/** Y2 data-only ingest: normalized customs buyers -> unbilled review companies. */
import type { JobHandler } from '../types.js';
import { researchSupabaseAdmin } from '../../supabase.js';
import { canonicalKey, normalizeDomain } from '../../engine/canonical.js';
import { SuppressedError, upsertCompany } from '../../engine/ledger.js';

const PAGE_SIZE = 200;
const DISTINCT_PAGE_SIZE = 1000;

interface TradeRow {
    id: string;
    company_name: string | null;
    website: string | null;
    country: string | null;
    phone: string | null;
}

export const tradeIngestHandler: JobHandler = async ({ job, heartbeat }) => {
    const batchId = typeof job.payload?.batch_id === 'string' ? job.payload.batch_id : null;
    if (!batchId || !job.project_id || !job.locked_by || !job.lease) {
        throw new Error('trade:ingest requires batch_id, project_id, worker, and lease');
    }

    const { data: batch, error: batchError } = await researchSupabaseAdmin
        .from('research_trade_import_batches')
        .select('id')
        .eq('id', batchId)
        .eq('tenant_id', job.tenant_id)
        .eq('project_id', job.project_id)
        .maybeSingle();
    if (batchError || !batch) throw new Error('trade import batch not found for this tenant/project');

    const { error: startError } = await researchSupabaseAdmin
        .from('research_trade_import_batches')
        .update({ status: 'processing', error: null, job_id: job.id })
        .eq('tenant_id', job.tenant_id)
        .eq('id', batchId);
    if (startError) throw startError;

    let handled = 0;
    let linked = 0;
    let suppressed = 0;
    try {
        while (true) {
            const { data, error } = await researchSupabaseAdmin
                .from('research_trade_imports')
                .select('id, company_name, website, country, phone')
                .eq('tenant_id', job.tenant_id)
                .eq('batch_id', batchId)
                .eq('status', 'pending')
                .order('row_number')
                .limit(PAGE_SIZE);
            if (error) throw error;
            const rows = (data ?? []) as TradeRow[];
            if (rows.length === 0) break;

            for (const row of rows) {
                if (!row.company_name) {
                    await researchSupabaseAdmin.from('research_trade_imports').update({
                        status: 'rejected', needs_review: true, review_reasons: 'buyer company is required',
                    }).eq('tenant_id', job.tenant_id).eq('id', row.id);
                    handled++;
                    continue;
                }
                const domain = normalizeDomain(row.website);
                const key = canonicalKey({ domain, website: row.website, name: row.company_name, country: row.country });
                try {
                    const company = await upsertCompany({
                        tenantId: job.tenant_id,
                        canonicalKey: key,
                        projectId: job.project_id,
                        domain,
                        name: row.company_name,
                        website: row.website,
                        country: row.country,
                        phone: row.phone,
                        status: null,
                        // Trade evidence remains on research_trade_imports. Passing a summary here
                        // would overwrite an existing company's validated site rollup on conflict.
                        siteSummary: null,
                        sourcePath: 'Y2',
                        jobId: job.id,
                        worker: job.locked_by,
                        lease: job.lease,
                    });
                    const { error: updateError } = await researchSupabaseAdmin
                        .from('research_trade_imports')
                        .update({ status: 'processed', company_id: company.id })
                        .eq('tenant_id', job.tenant_id)
                        .eq('id', row.id);
                    if (updateError) throw updateError;
                    linked++;
                } catch (error) {
                    if (!(error instanceof SuppressedError)) throw error;
                    await researchSupabaseAdmin.from('research_trade_imports').update({
                        status: 'rejected', needs_review: true, review_reasons: 'company is suppressed',
                    }).eq('tenant_id', job.tenant_id).eq('id', row.id);
                    suppressed++;
                }
                handled++;
                if (handled % 25 === 0) {
                    await heartbeat({ stage: 'trade_ingest', handled, linked, suppressed });
                }
            }
        }

        const [{ count: processed }, { count: rejected }] = await Promise.all([
            researchSupabaseAdmin.from('research_trade_imports').select('id', { count: 'exact', head: true })
                .eq('tenant_id', job.tenant_id).eq('batch_id', batchId).eq('status', 'processed'),
            researchSupabaseAdmin.from('research_trade_imports').select('id', { count: 'exact', head: true })
                .eq('tenant_id', job.tenant_id).eq('batch_id', batchId).eq('status', 'rejected'),
        ]);
        const processedRows = processed ?? 0;
        const distinctCompanies = new Set<string>();
        for (let offset = 0; offset < processedRows; offset += DISTINCT_PAGE_SIZE) {
            const { data: links, error: linksError } = await researchSupabaseAdmin
                .from('research_trade_imports')
                .select('company_id')
                .eq('tenant_id', job.tenant_id)
                .eq('batch_id', batchId)
                .eq('status', 'processed')
                .not('company_id', 'is', null)
                .range(offset, offset + DISTINCT_PAGE_SIZE - 1);
            if (linksError) throw linksError;
            for (const link of links ?? []) {
                if (typeof link.company_id === 'string') distinctCompanies.add(link.company_id);
            }
            if ((links?.length ?? 0) < DISTINCT_PAGE_SIZE) break;
        }
        await researchSupabaseAdmin.from('research_trade_import_batches').update({
            status: 'processed', processed_rows: processedRows, linked_companies: distinctCompanies.size,
            rejected_rows: rejected ?? 0,
        }).eq('tenant_id', job.tenant_id).eq('id', batchId);
        return {
            batch_id: batchId,
            processed: processedRows,
            linked_companies: distinctCompanies.size,
            rejected: rejected ?? 0,
            suppressed,
        };
    } catch (error) {
        await researchSupabaseAdmin.from('research_trade_import_batches').update({
            status: 'failed', error: error instanceof Error ? error.message.slice(0, 500) : 'Trade ingest failed',
        }).eq('tenant_id', job.tenant_id).eq('id', batchId);
        throw error;
    }
};
