/**
 * Resolves the PlusVibe email ID, from-address, and subject needed to send a reply.
 *
 * Strategy:
 * 1. Check raw_payload cache (plusvibe_email_id, from_address, subject)
 * 2. If missing, fetch from PlusVibe API by lead email + campaign
 * 3. Cache resolved values back into raw_payload for future calls
 */
import { supabaseAdmin } from './supabase.js';
import { fetchEmailsByLead, getCampaignAccounts } from './plusvibeClient.js';
import { AppError } from '../middleware/errorHandler.js';
import { createLogger } from './logger.js';

const log = createLogger('plusvibe-reply-resolver');

export interface ResolvedReplyContext {
    plusvibeEmailId: string;
    fromAddress: string;
    subject: string;
}

export async function resolveReplyContext(
    emailReply: {
        id: string;
        campaign_id: string;
        sender_email: string;
        replied_at: string;
        raw_payload: Record<string, unknown> | null;
    },
    tenantId: string,
): Promise<ResolvedReplyContext> {
    const payload = emailReply.raw_payload || {};

    let plusvibeEmailId = payload.plusvibe_email_id as string | undefined;
    let fromAddress = payload.from_address as string | undefined;
    let subject = payload.subject as string | undefined;

    // If all cached, return immediately
    if (plusvibeEmailId && fromAddress && subject) {
        return { plusvibeEmailId, fromAddress, subject };
    }

    // ── Resolve plusvibe_email_id via API if not cached ──
    if (!plusvibeEmailId) {
        const emails = await fetchEmailsByLead(emailReply.campaign_id, emailReply.sender_email);

        if (emails.length === 0) {
            throw new AppError('Could not find this email thread in PlusVibe. The email may have been deleted.', 404);
        }

        // Find the most recent inbound email to reply to
        const inbound = emails
            .filter((e) => e.direction === 'IN')
            .sort((a, b) => new Date(b.timestamp_created).getTime() - new Date(a.timestamp_created).getTime());

        if (inbound.length === 0) {
            throw new AppError('No inbound emails found in PlusVibe for this sender/campaign', 404);
        }

        // Use the most recent inbound email
        const bestMatch = inbound[0];
        plusvibeEmailId = bestMatch.id;

        // Extract subject from the email
        if (!subject && bestMatch.subject) {
            subject = bestMatch.subject;
        }

        // Try to get from-address from the latest outbound email in the thread
        if (!fromAddress) {
            const outbound = emails.find((e) => e.direction === 'OUT');
            if (outbound) {
                fromAddress = outbound.from_address_email;
            }
        }

        log.info({ emailReplyId: emailReply.id, plusvibeEmailId }, 'Resolved PlusVibe email ID via API');
    }

    // ── Resolve from-address from campaign accounts if still missing ──
    if (!fromAddress) {
        // Check plusvibe_campaigns table first
        const { data: campaign } = await supabaseAdmin
            .from('plusvibe_campaigns')
            .select('sender_emails')
            .eq('pv_campaign_id', emailReply.campaign_id)
            .eq('tenant_id', tenantId)
            .single();

        if (campaign?.sender_emails && campaign.sender_emails.length > 0) {
            fromAddress = campaign.sender_emails[0];
        } else {
            // Fallback: fetch from API
            const accounts = await getCampaignAccounts(emailReply.campaign_id);
            if (accounts.length > 0) {
                fromAddress = accounts[0];
            }
        }
    }

    if (!fromAddress) {
        throw new AppError('Could not determine sender email account for this campaign. Please sync campaigns first.', 400);
    }

    // Default subject
    if (!subject) {
        subject = 'Re: Email';
    }

    if (!plusvibeEmailId) {
        throw new AppError('Could not resolve PlusVibe email ID for this reply', 500);
    }

    // ── Cache resolved values back into raw_payload ──
    const updatedPayload = {
        ...payload,
        plusvibe_email_id: plusvibeEmailId,
        from_address: fromAddress,
        subject,
    };

    await supabaseAdmin
        .from('email_replies')
        .update({ raw_payload: updatedPayload })
        .eq('id', emailReply.id)
        .eq('tenant_id', tenantId);

    return { plusvibeEmailId, fromAddress, subject };
}
