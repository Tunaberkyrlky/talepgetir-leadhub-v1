/**
 * icp:revise (WP1 calibration) — propose an ICP ruleset revision from feedback.
 *
 * Loads the ICP plus the customer's good/bad ratings at the CURRENT ruleset (084:
 * feedback against an older version describes rules that may no longer exist), joins
 * each rated firm's verdict evidence, and asks the strategy model for FULL replacement
 * ruleset arrays. The proposal lands in research_icps.revision_draft via the fenced
 * RPC — the live ruleset columns (and the 062 bump trigger) stay untouched until the
 * customer applies the revision through the apply-revision route.
 */
import type { HandlerContext } from '../types.js';
import { researchSupabaseAdmin } from '../../supabase.js';
import { runLlmJson } from '../../llm/index.js';
import { withLlmMeter, type MeteredError } from '../../llm/meter.js';
import { costFromUsageSummary } from '../../engine/pricing.js';
import { icpRevisionSchema } from '../../icp/reviseSchema.js';
import { buildIcpRevisePrompt, type ReviseIcp, type ReviseFeedbackEntry } from '../../icp/revisePrompt.js';
import { createLogger } from '../../../logger.js';

const log = createLogger('research:handler:icp-revise');

interface FeedbackRow {
    company_id: string;
    rating: 'good' | 'bad';
    note: string | null;
}

interface CompanyRow {
    id: string;
    name: string;
    domain: string | null;
    site_summary: string | null;
}

interface VerdictRow {
    company_id: string;
    verdict: string;
    score: number | null;
    evidence: string | null;
}

function truncate(s: string | null | undefined, max: number): string | null {
    if (!s) return null;
    return s.length > max ? `${s.slice(0, max)}…` : s;
}

export async function icpReviseHandler({ job, heartbeat }: HandlerContext): Promise<Record<string, unknown>> {
    const icpId = typeof job.payload?.icp_id === 'string' ? job.payload.icp_id : null;
    if (!icpId) throw new Error('icp:revise requires payload.icp_id');
    const tenantId = job.tenant_id;

    await heartbeat({ stage: 'loading' });

    const { data: icp, error: icpErr } = await researchSupabaseAdmin
        .from('research_icps')
        .select('id, project_id, name, code, segment, note, signals, negative_signals, neutral_signals, elimination_rules, ruleset_version')
        .eq('id', icpId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
    if (icpErr) throw icpErr;
    if (!icp) throw new Error(`icp:revise: ICP ${icpId} not found for tenant ${tenantId}`);
    const icpRow = icp as ReviseIcp & { id: string; project_id: string };

    // count:'exact' so a clip past the window is DETECTED — silently dropping the oldest
    // (often most deliberate) ratings from the revision would be invisible otherwise.
    const { data: feedback, error: fbErr, count: feedbackTotal } = await researchSupabaseAdmin
        .from('research_company_feedback')
        .select('company_id, rating, note', { count: 'exact' })
        .eq('tenant_id', tenantId)
        .eq('icp_id', icpId)
        .eq('ruleset_version', icpRow.ruleset_version)
        .order('created_at', { ascending: false })
        .limit(400);
    if (fbErr) throw fbErr;
    const feedbackRows = (feedback ?? []) as FeedbackRow[];
    if (feedbackRows.length === 0) {
        throw new Error('icp:revise requires calibration feedback at the current ruleset');
    }
    const feedbackOmitted = Math.max(0, (feedbackTotal ?? feedbackRows.length) - feedbackRows.length);
    if (feedbackOmitted > 0) {
        log.warn({ jobId: job.id, icpId, feedbackOmitted }, 'icp:revise feedback window clipped');
    }

    const companyIds = feedbackRows.map((f) => f.company_id);

    const { data: companies, error: coErr } = await researchSupabaseAdmin
        .from('research_companies')
        .select('id, name, domain, site_summary')
        .eq('tenant_id', tenantId)
        .in('id', companyIds);
    if (coErr) throw coErr;

    // The verdict each firm was rated against (same ICP + ruleset) — its evidence tells the
    // model WHY the ruleset surfaced the firm, which is what a revision has to correct.
    const { data: verdicts, error: vErr } = await researchSupabaseAdmin
        .from('research_company_verdicts')
        .select('company_id, verdict, score, evidence')
        .eq('tenant_id', tenantId)
        .eq('icp_id', icpId)
        .eq('ruleset_version', icpRow.ruleset_version)
        .in('company_id', companyIds);
    if (vErr) throw vErr;

    const companyById = new Map(((companies ?? []) as CompanyRow[]).map((c) => [c.id, c]));
    const verdictByCompany = new Map(((verdicts ?? []) as VerdictRow[]).map((v) => [v.company_id, v]));

    const entries: ReviseFeedbackEntry[] = feedbackRows.map((f) => {
        const company = companyById.get(f.company_id);
        const verdict = verdictByCompany.get(f.company_id);
        return {
            name: company?.name ?? '(unknown firm)',
            domain: company?.domain ?? null,
            rating: f.rating,
            note: f.note,
            verdict: verdict?.verdict ?? null,
            score: verdict?.score ?? null,
            evidence: truncate(verdict?.evidence, 600),
            site_summary: truncate(company?.site_summary, 300),
        };
    });

    // WP5: measured campaign outcomes (research-owned aggregate, counts only) join the
    // revision evidence when the tenant has exported+campaigned firms for this ICP. A read
    // failure degrades to the pre-WP5 prompt — never fails the revision.
    let outcomes: import('../../icp/revisePrompt.js').ReviseOutcomeSummary | null = null;
    {
        const { data: statRows, error: statErr } = await researchSupabaseAdmin
            .from('research_outcome_stats')
            .select('angle_code, exported, sent, replies, positive, optouts')
            .eq('tenant_id', tenantId)
            .eq('icp_id', icpId)
            .eq('period', 'all');
        if (statErr) {
            log.warn({ err: statErr, jobId: job.id }, 'outcome stats read failed — revising without outcomes');
        } else {
            const rows = (statRows ?? []) as Array<{ angle_code: string | null; exported: number; sent: number; replies: number; positive: number; optouts: number }>;
            const totals = rows.filter((r) => r.angle_code == null);
            if (totals.length > 0) {
                outcomes = {
                    exported: totals.reduce((n, r) => n + r.exported, 0),
                    sent: totals.reduce((n, r) => n + r.sent, 0),
                    replies: totals.reduce((n, r) => n + r.replies, 0),
                    positive: totals.reduce((n, r) => n + r.positive, 0),
                    optouts: totals.reduce((n, r) => n + r.optouts, 0),
                    by_angle: Object.values(
                        rows.filter((r) => r.angle_code != null).reduce((acc, r) => {
                            const key = r.angle_code as string;
                            acc[key] = acc[key] ?? { angle: key, sent: 0, replies: 0, positive: 0 };
                            acc[key].sent += r.sent; acc[key].replies += r.replies; acc[key].positive += r.positive;
                            return acc;
                        }, {} as Record<string, { angle: string; sent: number; replies: number; positive: number }>)
                    ),
                };
            }
        }
    }

    const { system, messages } = buildIcpRevisePrompt({ icp: icpRow, feedback: entries, omitted: feedbackOmitted, outcomes });

    await heartbeat({ stage: 'revising', feedback: entries.length });
    // Metered like icp:generate (1b): Opus spend outside the harvest path, recorded raw + as a
    // dollar estimate in the job result for the admin margin panel. The catch covers the WHOLE
    // paid section (LLM call + heartbeat + persistence): any failure after the spend warn-logs
    // the tally (captured or the partial withLlmMeter attached to the throw), so a failed-but-paid
    // attempt never disappears from calibration.
    let usage: Awaited<ReturnType<typeof withLlmMeter>>['usage'] | undefined;
    try {
        const metered = await withLlmMeter(async () =>
            runLlmJson('strategy', icpRevisionSchema, {
                system,
                messages,
                effort: 'high',
                maxTokens: 8000,
            })
        );
        usage = metered.usage;
        const { value, result } = metered.result;

        // No-op guard (codex #6): a proposal identical to the live ruleset can't fire the
        // bump trigger on apply — fail loudly here instead of persisting a useless draft.
        const noop = (['signals', 'negative_signals', 'neutral_signals', 'elimination_rules'] as const)
            .every((k) => JSON.stringify(value[k]) === JSON.stringify(icpRow[k] ?? []));
        if (noop) {
            throw new Error('icp:revise: model proposed no ruleset changes — gather more feedback and re-run');
        }

        await heartbeat({ stage: 'persisting', changes: value.changes_summary.length });

        // Fenced persistence (084/085, 063 pattern): only the attempt that still holds the job
        // lease may write the proposal — a reaped, stale attempt can't clobber a newer one. The
        // RPC also refuses when the live ruleset moved past p_base_ruleset (the proposal was
        // computed from feedback against rules that no longer exist — DETAIL 'RULESET_MOVED')
        // or when the ICP is already 'calibrated' (terminal until re-sampled — DETAIL 'CALIBRATED').
        const { error: persistErr } = await researchSupabaseAdmin.rpc('research_persist_icp_revision', {
            p_tenant: tenantId,
            p_icp_id: icpId,
            p_job_id: job.id,
            p_worker: job.locked_by,
            p_lease: job.lease,
            p_revision: value,
            p_base_ruleset: icpRow.ruleset_version,
        });
        if (persistErr) throw persistErr;

        log.info(
            { jobId: job.id, icpId, rulesetVersion: icpRow.ruleset_version, changes: value.changes_summary.length, model: result.model },
            'icp:revise persisted revision draft'
        );

        return {
            icp_id: icpId,
            ruleset_version: icpRow.ruleset_version,
            changes: value.changes_summary.length,
            feedback_used: entries.length,
            feedback_omitted: feedbackOmitted,
            provider: result.provider,
            model: result.model,
            // COGS trail (admin-only downstream: 068 hides result from client reads; the API
            // sanitizer strips usage_raw/cost_usd for non-internal roles).
            usage_raw: usage,
            cost_usd: costFromUsageSummary(usage),
        };
    } catch (err) {
        const partialUsage = usage ?? ((err && typeof err === 'object') ? (err as MeteredError).llmUsage : undefined);
        if (partialUsage && partialUsage.totalCalls > 0) {
            log.warn({ jobId: job.id, usage_raw: partialUsage }, 'icp:revise failed after spending — partial COGS');
        }
        throw err;
    }
}
