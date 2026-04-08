/**
 * PlusVibe API client — global credentials (single workspace), global rate limiter.
 * Pattern: deepl.ts (native fetch, createLogger, structured errors).
 *
 * Auth: x-api-key header + workspace_id query/body param.
 * Credentials: PLUSVIBE_API_KEY + PLUSVIBE_WORKSPACE_ID env vars.
 * Rate limit: 5 req/sec (single PlusVibe workspace).
 */
import { createLogger } from './logger.js';
import { AppError } from '../middleware/errorHandler.js';

const log = createLogger('plusvibe');

const BASE_URL = process.env.PLUSVIBE_API_BASE_URL || 'https://api.plusvibe.ai/api/v1';
const API_KEY = process.env.PLUSVIBE_API_KEY || '';
const WORKSPACE_ID = process.env.PLUSVIBE_WORKSPACE_ID || '';

/** Check if PlusVibe global credentials are configured. */
export function isConfigured(): boolean {
    return !!(API_KEY && WORKSPACE_ID);
}

// ── Global rate limiter (5 req/sec sliding window) ──────────────────────────

let requestTimestamps: number[] = [];
const MAX_REQUESTS_PER_SEC = 5;

async function waitForRateLimit(): Promise<void> {
    const now = Date.now();
    requestTimestamps = requestTimestamps.filter((t) => now - t < 1000);

    if (requestTimestamps.length >= MAX_REQUESTS_PER_SEC) {
        const oldest = requestTimestamps[0];
        const waitMs = 1000 - (now - oldest) + 10;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        requestTimestamps = requestTimestamps.filter((t) => Date.now() - t < 1000);
    }

    requestTimestamps.push(Date.now());
}

// ── Core fetch wrapper ─────────────────────────────────────────────────────

export async function plusVibeFetch<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
    path: string,
    body?: unknown,
): Promise<T> {
    if (!API_KEY || !WORKSPACE_ID) {
        throw new AppError('PlusVibe integration not configured. Set PLUSVIBE_API_KEY and PLUSVIBE_WORKSPACE_ID env vars.', 500);
    }

    await waitForRateLimit();

    let url = `${BASE_URL}${path}`;
    const headers: Record<string, string> = {
        'x-api-key': API_KEY,
        'Content-Type': 'application/json',
    };

    let fetchBody: string | undefined;

    if (method === 'GET' || method === 'DELETE') {
        const sep = url.includes('?') ? '&' : '?';
        url += `${sep}workspace_id=${WORKSPACE_ID}`;
    } else {
        const payload = body && typeof body === 'object'
            ? { workspace_id: WORKSPACE_ID, ...body }
            : { workspace_id: WORKSPACE_ID };
        fetchBody = JSON.stringify(payload);
    }

    log.info({ method, path }, 'PlusVibe API request');

    const res = await fetch(url, { method, headers, body: fetchBody });

    if (!res.ok) {
        const errorBody = await res.text();
        log.error({ status: res.status, body: errorBody, path }, 'PlusVibe API error');
        throw new AppError(`PlusVibe API error: ${res.status}`, res.status >= 500 ? 502 : res.status);
    }

    return await res.json() as T;
}

// ── Campaign functions ─────────────────────────────────────────────────────

export interface PlusVibeCampaign {
    id: string;
    _id: string;
    name: string;
    status: string;
    created_at?: string;
    last_lead_sent?: string;
    last_lead_replied?: string;
    tags?: string[];
    [key: string]: unknown;
}

export interface PlusVibeCampaignStats {
    campaign_id?: string;
    total_leads?: number;
    emails_sent?: number;
    opens?: number;
    clicks?: number;
    replies?: number;
    bounces?: number;
    open_rate?: number;
    click_rate?: number;
    reply_rate?: number;
    [key: string]: unknown;
}

export async function checkConnection(): Promise<boolean> {
    try {
        await plusVibeFetch('GET', '/campaign/list');
        return true;
    } catch {
        return false;
    }
}

export async function listCampaigns(): Promise<PlusVibeCampaign[]> {
    const data = await plusVibeFetch<PlusVibeCampaign[] | { data?: PlusVibeCampaign[] }>(
        'GET', '/campaign/list',
    );
    return Array.isArray(data) ? data : (data.data || []);
}

export async function getCampaignSummary(campaignId: string): Promise<PlusVibeCampaignStats> {
    return plusVibeFetch<PlusVibeCampaignStats>(
        'GET',
        `/campaign/summary?campaign_id=${encodeURIComponent(campaignId)}`,
    );
}

export async function getCampaignStats(
    startDate: string,
    endDate?: string,
): Promise<PlusVibeCampaignStats> {
    let path = `/campaign/stats?start_date=${encodeURIComponent(startDate)}`;
    if (endDate) path += `&end_date=${encodeURIComponent(endDate)}`;
    return plusVibeFetch<PlusVibeCampaignStats>('GET', path);
}

export async function activateCampaign(campaignId: string): Promise<unknown> {
    return plusVibeFetch('POST', '/campaign/activate', { campaign_id: campaignId });
}

export async function pauseCampaign(campaignId: string): Promise<unknown> {
    return plusVibeFetch('POST', '/campaign/pause', { campaign_id: campaignId });
}

// ── Unibox (email) functions ───────────────────────────────────────────────

export interface PlusVibeEmail {
    id: string;
    direction: 'IN' | 'OUT';
    from_address_email: string;
    to_address_email_list: string;
    subject: string;
    body: string;
    content_preview: string;
    timestamp_created: string;
    campaign_id: string;
    label: string;
    is_unread: number;
    lead_id: string;
    thread_id: string;
    lead?: Record<string, unknown>;
    [key: string]: unknown;
}

interface UniboxPage {
    page_trail: string | null;
    data: PlusVibeEmail[];
}

/** Fetch one page of emails for a campaign. Returns { data, nextPageTrail }. */
export async function fetchEmailsPage(
    campaignId: string,
    pageTrail?: string,
): Promise<{ emails: PlusVibeEmail[]; nextPageTrail: string | null }> {
    let path = `/unibox/emails?campaign_id=${encodeURIComponent(campaignId)}`;
    if (pageTrail) path += `&page_trail=${encodeURIComponent(pageTrail)}`;

    const result = await plusVibeFetch<UniboxPage>('GET', path);
    return {
        emails: result.data || [],
        nextPageTrail: result.page_trail || null,
    };
}

/** Fetch email accounts linked to a campaign. Returns email address strings. */
export async function getCampaignAccounts(campaignId: string): Promise<string[]> {
    const data = await plusVibeFetch<string[] | { data?: string[] }>(
        'GET',
        `/campaign/get/accounts?campaign_id=${encodeURIComponent(campaignId)}`,
    );
    return Array.isArray(data) ? data : (data.data || []);
}

/** Fetch emails for a specific lead (sender) within a campaign. */
export async function fetchEmailsByLead(
    campaignId: string,
    leadEmail: string,
): Promise<PlusVibeEmail[]> {
    const allEmails: PlusVibeEmail[] = [];
    let pageTrail: string | undefined;

    for (let page = 0; page < 50; page++) {
        let path = `/unibox/emails?campaign_id=${encodeURIComponent(campaignId)}&lead=${encodeURIComponent(leadEmail)}`;
        if (pageTrail) path += `&page_trail=${encodeURIComponent(pageTrail)}`;

        const result = await plusVibeFetch<UniboxPage>('GET', path);
        if (result.data?.length) allEmails.push(...result.data);
        if (!result.page_trail) break;
        pageTrail = result.page_trail;
    }

    return allEmails;
}

/** Send a reply to an existing email via PlusVibe. */
export async function replyToEmail(params: {
    reply_to_id: string;
    subject: string;
    from: string;
    to: string;
    body: string;
    cc?: string;
    bcc?: string;
}): Promise<{ status: string; id: string }> {
    return plusVibeFetch<{ status: string; id: string }>(
        'POST',
        '/unibox/emails/reply',
        params,
    );
}

/** Fetch ALL incoming reply emails for a campaign (paginated). */
export async function fetchAllReplies(campaignId: string): Promise<PlusVibeEmail[]> {
    const allReplies: PlusVibeEmail[] = [];
    let pageTrail: string | undefined;
    let pageCount = 0;

    for (let page = 0; page < 200; page++) { // safety limit
        const { emails, nextPageTrail } = await fetchEmailsPage(campaignId, pageTrail);
        if (emails.length === 0) break;
        pageCount++;

        // Only keep incoming replies
        for (const email of emails) {
            if (email.direction === 'IN') {
                allReplies.push(email);
            }
        }

        if (!nextPageTrail) break;
        pageTrail = nextPageTrail;
    }

    log.info({ campaignId, pages: pageCount, inboundCount: allReplies.length }, 'fetchAllReplies completed');
    return allReplies;
}
