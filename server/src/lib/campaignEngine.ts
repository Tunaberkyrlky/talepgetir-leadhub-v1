/**
 * Campaign Engine — Enrollment state machine, scheduling, template resolution
 *
 * Hibrit v2: Enrollment'lar campaign_enrollments'ta, gönderilen email'ler
 * activities'te birer kayıt olarak oluşturulur (timeline'da görünür).
 *
 * Pattern references:
 *   - Batch: importProcessor.ts (cancellation check)
 *   - Rate limit: plusvibeClient.ts (sliding window)
 *   - Stage advance: emailMatcher.ts (advanceCompanyStageOnMatch)
 */

import crypto from 'crypto';
import { supabaseAdmin } from './supabase.js';
import { sendEmail } from './emailSender.js';
import { createLogger } from './logger.js';
import { AppError } from '../middleware/errorHandler.js';

const log = createLogger('campaignEngine');

const TRACKING_SECRET = process.env.TRACKING_SECRET || 'dev-tracking-secret-local-only';
if (!process.env.TRACKING_SECRET) {
    log.warn('TRACKING_SECRET env var not set — using insecure default. Set it in production!');
}
const API_BASE = process.env.API_BASE_URL || '';

// ── Types ──────────────────────────────────────────────────────────────────

interface CampaignStep {
    id: string;
    campaign_id: string;
    step_order: number;
    step_type: 'email' | 'delay' | 'condition';
    subject: string | null;
    body_html: string | null;
    delay_days: number;
    delay_hours: number;
}

interface EnrollContact {
    contact_id: string;
    company_id: string;
    email: string;
}

// ── Template Variables ─────────────────────────────────────────────────────

interface TemplateCtx {
    first_name: string;
    last_name: string;
    email: string;
    title: string;
    company_name: string;
    website: string;
    industry: string;
}

const TEMPLATE_KEYS = ['first_name', 'last_name', 'email', 'title', 'company_name', 'website', 'industry'] as const;

async function resolveTemplate(contactId: string, companyId: string): Promise<TemplateCtx> {
    const [cRes, coRes] = await Promise.all([
        supabaseAdmin.from('contacts').select('first_name, last_name, email, title').eq('id', contactId).single(),
        supabaseAdmin.from('companies').select('name, website, industry').eq('id', companyId).single(),
    ]);
    const c = cRes.data;
    const co = coRes.data;
    return {
        first_name: c?.first_name || '', last_name: c?.last_name || '',
        email: c?.email || '', title: c?.title || '',
        company_name: co?.name || '', website: co?.website || '', industry: co?.industry || '',
    };
}

function applyTemplate(template: string, ctx: TemplateCtx): string {
    let result = template;
    for (const key of TEMPLATE_KEYS) {
        result = result.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'gi'), ctx[key] || '');
    }
    return result;
}

// ── Tracking ───────────────────────────────────────────────────────────────

function createTrackingToken(id: string): string {
    const hmac = crypto.createHmac('sha256', TRACKING_SECRET).update(id).digest('hex').slice(0, 16);
    return `${id}:${hmac}`;
}

export function verifyTrackingToken(token: string): string | null {
    const [id, hmac] = token.split(':');
    if (!id || !hmac) return null;
    const expected = crypto.createHmac('sha256', TRACKING_SECRET).update(id).digest('hex').slice(0, 16);
    try {
        if (crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expected))) return id;
    } catch { /* length mismatch */ }
    return null;
}

function injectTracking(html: string, activityId: string): string {
    if (!API_BASE) return html;
    const token = createTrackingToken(activityId);
    const pixel = `<img src="${API_BASE}/api/t/o/${token}" width="1" height="1" style="display:none" alt="" />`;
    const wrapped = html.replace(
        /href="(https?:\/\/[^"]+)"/gi,
        (_, url) => `href="${API_BASE}/api/t/c/${token}?url=${encodeURIComponent(url)}"`,
    );
    return (wrapped.includes('</body>') ? wrapped.replace('</body>', `${pixel}</body>`) : wrapped + pixel);
}

function buildUnsubscribeFooter(enrollmentId: string): string {
    if (!API_BASE) return '';
    const token = createTrackingToken(enrollmentId);
    return `<div style="margin-top:32px;padding-top:16px;border-top:1px solid #eee;text-align:center;">
        <a href="${API_BASE}/api/unsubscribe/${token}" style="color:#999;font-size:11px;text-decoration:underline;">Unsubscribe</a>
    </div>`;
}

// ── Step Navigation ────────────────────────────────────────────────────────

async function findNextStep(campaignId: string, currentStepOrder: number): Promise<CampaignStep | null> {
    const { data } = await supabaseAdmin
        .from('campaign_steps')
        .select('*')
        .eq('campaign_id', campaignId)
        .gt('step_order', currentStepOrder)
        .order('step_order')
        .limit(1);
    return (data?.[0] as CampaignStep) || null;
}

function calcDelayMs(step: CampaignStep): number {
    return (step.delay_days * 86_400_000) + (step.delay_hours * 3_600_000);
}

// ── Enrollment ─────────────────────────────────────────────────────────────

export async function enrollLeads(
    campaignId: string,
    tenantId: string,
    userId: string,
    contacts: EnrollContact[],
): Promise<{ enrolled: number; skipped: number }> {
    // Fetch campaign + first step
    const { data: campaign, error: campErr } = await supabaseAdmin
        .from('campaigns')
        .select('id, status, total_enrolled')
        .eq('id', campaignId)
        .eq('tenant_id', tenantId)
        .single();

    if (campErr || !campaign) throw new AppError('Campaign not found', 404);

    const { data: steps } = await supabaseAdmin
        .from('campaign_steps')
        .select('*')
        .eq('campaign_id', campaignId)
        .order('step_order');

    if (!steps?.length) throw new AppError('Campaign has no steps', 422);

    const firstStep = steps[0] as CampaignStep;

    // Calculate initial next_scheduled_at
    let firstScheduleAt: string;
    if (firstStep.step_type === 'delay') {
        firstScheduleAt = new Date(Date.now() + calcDelayMs(firstStep)).toISOString();
    } else {
        firstScheduleAt = new Date().toISOString(); // email step → immediate
    }

    // Batch insert enrollments — single DB call, duplicates ignored via ON CONFLICT
    const rows = contacts.map((c) => ({
        tenant_id: tenantId,
        campaign_id: campaignId,
        contact_id: c.contact_id,
        company_id: c.company_id,
        email: c.email.toLowerCase(),
        status: 'active',
        current_step_id: firstStep.id,
        next_scheduled_at: firstScheduleAt,
    }));

    let enrolled = 0;
    let skipped = 0;

    // Try batch insert first; fall back to individual on conflict
    const { data: inserted, error: batchErr } = await supabaseAdmin
        .from('campaign_enrollments')
        .insert(rows)
        .select('id');

    if (batchErr) {
        if (batchErr.code === '23505') {
            // Batch had duplicates — fall back to individual inserts
            for (const row of rows) {
                const { error } = await supabaseAdmin
                    .from('campaign_enrollments')
                    .insert(row);
                if (error) { skipped++; } else { enrolled++; }
            }
        } else {
            log.error({ err: batchErr }, 'Batch enrollment insert failed');
            throw new AppError('Failed to enroll leads', 500);
        }
    } else {
        enrolled = inserted?.length || 0;
        skipped = contacts.length - enrolled;
    }

    // Update denormalized counter
    if (enrolled > 0) {
        await supabaseAdmin
            .from('campaigns')
            .update({ total_enrolled: (campaign.total_enrolled || 0) + enrolled })
            .eq('id', campaignId);
    }

    log.info({ campaignId, enrolled, skipped }, 'Leads enrolled');
    return { enrolled, skipped };
}

// ── Scheduled Email Processing ─────────────────────────────────────────────

export async function processScheduledEmails(): Promise<{ sent: number; failed: number; advanced: number }> {
    // Skip if no email sending capability is configured
    if (!process.env.RESEND_API_KEY) return { sent: 0, failed: 0, advanced: 0 };

    const { data: dueEnrollments, error } = await supabaseAdmin
        .from('campaign_enrollments')
        .select(`
            id, tenant_id, campaign_id, contact_id, company_id, email,
            current_step_id, next_scheduled_at, branch_path
        `)
        .eq('status', 'active')
        .lte('next_scheduled_at', new Date().toISOString())
        .order('next_scheduled_at')
        .limit(50);

    if (error) {
        log.error({ err: error }, 'Failed to fetch due enrollments');
        return { sent: 0, failed: 0, advanced: 0 };
    }
    if (!dueEnrollments?.length) return { sent: 0, failed: 0, advanced: 0 };

    log.info({ count: dueEnrollments.length }, 'Processing due enrollments');

    let sent = 0, failed = 0, advanced = 0;

    for (const enrollment of dueEnrollments) {
        try {
            // Optimistic lock: claim this enrollment so concurrent ticks can't double-process it.
            // If another process already claimed it, the update returns 0 rows and we skip.
            const { data: locked } = await supabaseAdmin
                .from('campaign_enrollments')
                .update({ next_scheduled_at: null })
                .eq('id', enrollment.id)
                .eq('status', 'active')
                .not('next_scheduled_at', 'is', null)
                .select('id')
                .single();

            if (!locked) continue; // already claimed by another tick or status changed

            // Fetch campaign status + tenant CC settings
            const [campaignRes, tenantRes] = await Promise.all([
                supabaseAdmin.from('campaigns').select('status, from_name, settings')
                    .eq('id', enrollment.campaign_id).single(),
                supabaseAdmin.from('tenants').select('settings')
                    .eq('id', enrollment.tenant_id).single(),
            ]);
            const campaign = campaignRes.data;
            const tenantSettings = tenantRes.data?.settings || {};

            if (!campaign || campaign.status !== 'active') {
                // Campaign no longer active — pause enrollment
                await supabaseAdmin
                    .from('campaign_enrollments')
                    .update({ status: 'paused' })
                    .eq('id', enrollment.id);
                continue;
            }

            // Fetch current step
            const { data: step } = await supabaseAdmin
                .from('campaign_steps')
                .select('*')
                .eq('id', enrollment.current_step_id)
                .single();

            if (!step) {
                log.warn({ enrollmentId: enrollment.id }, 'Current step not found — completing enrollment');
                await completeEnrollment(enrollment.id);
                continue;
            }

            const currentStep = step as CampaignStep;

            if (currentStep.step_type === 'email') {
                // ── Send email ─────────────────────────────────────────
                if (!enrollment.contact_id || !enrollment.company_id) {
                    await markEnrollmentFailed(enrollment.id, 'Missing contact or company');
                    failed++; continue;
                }

                // Resolve template
                const ctx = await resolveTemplate(enrollment.contact_id, enrollment.company_id);
                const subject = applyTemplate(currentStep.subject || '', ctx);
                let bodyHtml = applyTemplate(currentStep.body_html || '', ctx);

                // Create activity first (we need the ID for tracking)
                const { data: activity, error: actErr } = await supabaseAdmin
                    .from('activities')
                    .insert({
                        tenant_id: enrollment.tenant_id,
                        company_id: enrollment.company_id,
                        contact_id: enrollment.contact_id,
                        type: 'campaign_email',
                        summary: subject,
                        detail: (currentStep.body_html || '').slice(0, 500), // snippet for timeline
                        outcome: 'sending',
                        campaign_id: enrollment.campaign_id,
                        enrollment_id: enrollment.id,
                        visibility: 'internal',
                        occurred_at: new Date().toISOString(),
                        created_by: null, // system-generated
                    })
                    .select('id')
                    .single();

                if (actErr || !activity) {
                    log.error({ err: actErr }, 'Failed to create campaign activity');
                    failed++; continue;
                }

                // Inject tracking + unsubscribe
                bodyHtml = injectTracking(bodyHtml, activity.id);
                bodyHtml += buildUnsubscribeFooter(enrollment.id);

                try {
                    // CC: campaign-level override > tenant-level default
                    const ccAddresses: string[] = (campaign.settings?.cc
                        || tenantSettings.cc_addresses?.map((a: any) => a.email)
                        || []);

                    const result = await sendEmail(
                        enrollment.tenant_id,
                        enrollment.email,
                        subject,
                        bodyHtml,
                        {
                            fromName: campaign.from_name || undefined,
                            cc: ccAddresses.length > 0 ? ccAddresses : undefined,
                        },
                    );

                    // Mark activity as sent
                    await supabaseAdmin
                        .from('activities')
                        .update({ outcome: 'sent' })
                        .eq('id', activity.id);

                    sent++;
                    log.info({ enrollmentId: enrollment.id, to: enrollment.email, activityId: activity.id }, 'Campaign email sent');
                } catch (sendErr) {
                    const msg = sendErr instanceof Error ? sendErr.message : String(sendErr);
                    await supabaseAdmin
                        .from('activities')
                        .update({ outcome: `failed: ${msg.slice(0, 200)}` })
                        .eq('id', activity.id);
                    failed++;
                    log.error({ err: sendErr, enrollmentId: enrollment.id }, 'Campaign email send failed');
                    // Don't stop enrollment — advance to next step anyway
                }
            } else if (currentStep.step_type === 'delay') {
                // Delay step — time has elapsed, just advance
                advanced++;
            }
            // condition step handling will be added in FUP phase

            // ── Advance to next step ───────────────────────────────────
            const nextStep = await findNextStep(enrollment.campaign_id, currentStep.step_order);

            if (!nextStep) {
                await completeEnrollment(enrollment.id);
            } else if (nextStep.step_type === 'delay') {
                await supabaseAdmin
                    .from('campaign_enrollments')
                    .update({
                        current_step_id: nextStep.id,
                        next_scheduled_at: new Date(Date.now() + calcDelayMs(nextStep)).toISOString(),
                    })
                    .eq('id', enrollment.id);
            } else {
                // email or condition step → schedule for next tick
                await supabaseAdmin
                    .from('campaign_enrollments')
                    .update({
                        current_step_id: nextStep.id,
                        next_scheduled_at: new Date().toISOString(),
                    })
                    .eq('id', enrollment.id);
            }

        } catch (err) {
            log.error({ err, enrollmentId: enrollment.id }, 'Enrollment processing error');
            failed++;
        }
    }

    if (sent > 0 || failed > 0 || advanced > 0) {
        log.info({ sent, failed, advanced }, 'Scheduler tick complete');
    }
    return { sent, failed, advanced };
}

async function completeEnrollment(enrollmentId: string): Promise<void> {
    await supabaseAdmin
        .from('campaign_enrollments')
        .update({ status: 'completed', completed_at: new Date().toISOString(), next_scheduled_at: null })
        .eq('id', enrollmentId);
}

async function markEnrollmentFailed(enrollmentId: string, reason: string): Promise<void> {
    await supabaseAdmin
        .from('campaign_enrollments')
        .update({ status: 'paused', next_scheduled_at: null })
        .eq('id', enrollmentId);
    log.warn({ enrollmentId, reason }, 'Enrollment paused due to error');
}

// ── Reply Detection ────────────────────────────────────────────────────────

export async function cancelEnrollmentOnReply(senderEmail: string, tenantId: string): Promise<void> {
    const { data: contacts } = await supabaseAdmin
        .from('contacts')
        .select('id')
        .eq('tenant_id', tenantId)
        .ilike('email', senderEmail);

    if (!contacts?.length) return;

    const contactIds = contacts.map((c) => c.id);

    const { data: cancelled } = await supabaseAdmin
        .from('campaign_enrollments')
        .update({ status: 'replied', next_scheduled_at: null })
        .eq('status', 'active')
        .eq('tenant_id', tenantId)
        .in('contact_id', contactIds)
        .select('id, campaign_id');

    if (cancelled?.length) {
        log.info({ senderEmail, count: cancelled.length }, 'Enrollments cancelled on reply');
    }
}

// ── Campaign Stats ─────────────────────────────────────────────────────────

export interface CampaignStats {
    total_enrolled: number;
    active: number;
    completed: number;
    replied: number;
    paused: number;
    emails_sent: number;
    opens: number;
    clicks: number;
    replies: number;
    open_rate: number;
    click_rate: number;
    reply_rate: number;
}

export async function getCampaignStats(campaignId: string, tenantId: string): Promise<CampaignStats> {
    // Run enrollment counts + activity/event data in parallel (2 queries instead of 4)
    const [enrollmentRes, activityRes] = await Promise.all([
        supabaseAdmin
            .from('campaign_enrollments')
            .select('status')
            .eq('campaign_id', campaignId)
            .eq('tenant_id', tenantId),
        supabaseAdmin
            .from('activities')
            .select('id, outcome, campaign_email_events(event_type)')
            .eq('campaign_id', campaignId)
            .eq('tenant_id', tenantId)
            .eq('type', 'campaign_email'),
    ]);

    // Enrollment status counts
    const statusCounts: Record<string, number> = {};
    for (const e of enrollmentRes.data || []) {
        statusCounts[e.status] = (statusCounts[e.status] || 0) + 1;
    }
    const totalEnrolled = enrollmentRes.data?.length || 0;

    // Activity + event counts (single join query)
    let sentCount = 0;
    const openSet = new Set<string>();
    const clickSet = new Set<string>();
    const replySet = new Set<string>();

    for (const act of (activityRes.data || []) as any[]) {
        if (act.outcome === 'sent') sentCount++;
        for (const evt of act.campaign_email_events || []) {
            if (evt.event_type === 'open') openSet.add(act.id);
            if (evt.event_type === 'click') clickSet.add(act.id);
            if (evt.event_type === 'reply') replySet.add(act.id);
        }
    }

    const opens = openSet.size;
    const clicks = clickSet.size;
    const replyEvents = replySet.size;

    return {
        total_enrolled: totalEnrolled,
        active: statusCounts['active'] || 0,
        completed: statusCounts['completed'] || 0,
        replied: statusCounts['replied'] || 0,
        paused: statusCounts['paused'] || 0,
        emails_sent: sentCount,
        opens, clicks, replies: replyEvents,
        open_rate: sentCount > 0 ? opens / sentCount : 0,
        click_rate: sentCount > 0 ? clicks / sentCount : 0,
        reply_rate: sentCount > 0 ? replyEvents / sentCount : 0,
    };
}
