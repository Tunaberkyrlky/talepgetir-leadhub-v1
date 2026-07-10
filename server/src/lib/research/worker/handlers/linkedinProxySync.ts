/**
 * linkedin:proxy-sync — daily STAGED reconcile of the provider proxy inventory (Proxy P2, §4a).
 *
 * Reconciles what the provider still lists against our linkedin_proxies rows, with §4a's
 * NON-NEGOTIABLE invariants (all enforced in the linkedin_proxy_sync_apply RPC, mig 110):
 *   1. Assemble the FULL provider snapshot IN MEMORY first. ANY fetch error / rate-limit /
 *      unrecognized envelope → the run is 'incomplete' → ZERO destructive change (P1.8).
 *   2. Only a COMPLETE snapshot reconciles: matched rows refresh provider_health / plan_expires_at
 *      / last_seen_sync + reset their miss counter; unmatched rows bump consecutive_sync_misses.
 *   3. A proxy is flagged provider-gone (provider_health='unhealthy' + provider_gone_at) ONLY after
 *      N=3 consecutive COMPLETE-run misses — NEVER on a single miss.
 *   4. Sync NEVER touches reputation_state or assignments, and NEVER inserts a new proxy (creds +
 *      echo-verified exit_ip only enter via the server-side import path).
 *
 * SELF-HEALING LOOP (retention pattern): the daily successor is enqueued BEFORE the fetch/RPC work
 * that can throw, with a queued-ONLY dedup (C6) so this job's own still-'running' row can never
 * suppress its successor, so a transient failure can't permanently kill the loop. A fetch failure is
 * NOT a job failure — it is recorded as an 'incomplete' run (safe, non-destructive) and the job still
 * succeeds; only a genuine DB/RPC error throws.
 *
 * PROVIDER ADAPTER: IPRoyal uses the reseller API (apid.iproyal.com/v1/reseller). The response shape
 * is not verifiable offline, so the adapter is FAIL-CLOSED: only an HTTP-200 recognized envelope
 * yields a COMPLETE snapshot; anything else → incomplete → no destructive change. Every offline
 * assumption is flagged with a `// LIVE-VERIFY:` comment.
 */
import type { JobHandler } from '../types.js';
import { researchSupabaseAdmin } from '../../supabase.js';
import { createLogger } from '../../../logger.js';
import { enqueueJob } from '../../queue.js';
import { RESEARCH_JOB_TYPES } from '../../jobTypes.js';

const log = createLogger('research:handler:linkedin-proxy-sync');

const LOOP_MS = 24 * 3_600_000;

function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** One provider-listed proxy, normalized to the reconcile RPC's snapshot shape. */
export interface ProxySnapshotEntry {
    ext_id: string;
    /** The provider-listed IP (C7). The RPC matches a row by ext_id OR by exit_ip = ip::inet, so a
     *  row imported with an order-derived ext_id (e.g. `iproyal:order:...`) still reconciles against
     *  a snapshot that only agrees on the egress IP. */
    ip?: string | null;
    provider_health?: 'healthy' | 'unhealthy' | null;
    plan_expires_at?: string | null;
}

type FetchResult =
    | { ok: true; entries: ProxySnapshotEntry[] }
    | { ok: false; error: string };

interface ProviderAdapter {
    provider: string;
    fetchSnapshot(): Promise<FetchResult>;
}

// ── IPRoyal reseller adapter (fail-closed) ───────────────────────────────────────
// LIVE-VERIFY: the reseller proxy/order listing ENDPOINT PATH. Docs:
//   https://docs.iproyal.com/proxies/isp/api/orders
//   https://docs.iproyal.com/proxies/isp/api/proxies
// §11 proved the reseller base (apid.iproyal.com/v1/reseller) + `X-Access-Token` header work for
// order creation; the exact listing path + JSON envelope below must be confirmed against a live call.
const IPROYAL_RESELLER_LIST_URL = 'https://apid.iproyal.com/v1/reseller/proxies';

/** Pull the array of proxy objects out of whatever envelope the reseller API returns, defensively.
 *  Returns null (→ unrecognized → incomplete, fail-closed) when no array of proxies can be found. */
function extractProxyArray(body: unknown): Record<string, unknown>[] | null {
    if (Array.isArray(body)) return body as Record<string, unknown>[];
    if (body && typeof body === 'object') {
        // LIVE-VERIFY: the wrapper key. Common REST shapes: { data: [...] } / { proxies: [...] } /
        // { results: [...] }. If the live envelope differs, add its key here.
        for (const key of ['data', 'proxies', 'results', 'items']) {
            const v = (body as Record<string, unknown>)[key];
            if (Array.isArray(v)) return v as Record<string, unknown>[];
        }
    }
    return null;
}

/** C4 (codex P1.4): a paginated envelope means the array we extracted is only ONE page — accepting
 *  it as the FULL inventory would silently drop every proxy on the later pages and (after 3 complete
 *  runs) flag them provider-gone. Until a live call proves the reseller returns the whole inventory
 *  in one response, ANY marker indicating more data is fail-closed. A missing / null `next` (etc.) is
 *  NOT a marker. LIVE-VERIFY: confirm the real pagination envelope + wire single-page fetch-all here
 *  before trusting a COMPLETE run on a large inventory. */
function hasPaginationMarker(body: Record<string, unknown>, arrayLen: number): boolean {
    const truthy = (v: unknown): boolean =>
        v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    for (const k of ['next', 'next_page', 'next_page_url', 'cursor', 'has_more']) {
        if (truthy(body[k])) return true;
    }
    const links = body.links;
    if (links && typeof links === 'object' && (links as Record<string, unknown>).next != null) return true;
    const meta = (body.meta && typeof body.meta === 'object') ? (body.meta as Record<string, unknown>) : undefined;
    const total = num(body.total) ?? num(meta?.total);
    if (total !== null && total > arrayLen) return true;
    const lastPage = num(body.last_page) ?? num(meta?.last_page);
    if (lastPage !== null && lastPage > 1) return true;
    // Nested envelopes: some APIs wrap pagination state under a dedicated `pagination` / `meta` /
    // `page_info` object rather than at the top level. Inspect each for the same truthy/next/total
    // signals so a wrapped envelope isn't silently accepted as a single complete page.
    for (const wrapperKey of ['pagination', 'meta', 'page_info']) {
        const wrapper = body[wrapperKey];
        if (!wrapper || typeof wrapper !== 'object') continue;
        const w = wrapper as Record<string, unknown>;
        if (truthy(w.has_more) || truthy(w.has_next_page)) return true;
        if (w.next !== undefined && w.next !== null) return true;
        if (w.next_page !== undefined && w.next_page !== null) return true;
        if (w.next_cursor !== undefined && w.next_cursor !== null) return true;
        const wTotalPages = num(w.total_pages) ?? num(w.last_page);
        if (wTotalPages !== null && wTotalPages > 1) return true;
        const wTotal = num(w.total);
        if (wTotal !== null && wTotal > arrayLen) return true;
    }
    return false;
}

function normalizeEntry(p: Record<string, unknown>): ProxySnapshotEntry | null {
    // LIVE-VERIFY: the IP field name. C7: the REAL imported row's ext_id is order-derived
    // (`iproyal:order:76592603`, from the reseller purchase path) — NOT `manual:<ip>` — so an
    // ext_id-only match would NEVER hit it and every complete run would be zero_match_suspicious. We
    // therefore emit BOTH a synthesized ext_id AND the raw listed `ip`; the RPC matches a row by
    // ext_id OR by exit_ip = ip::inet (for IPRoyal ISP static the listed IP == the observed exit IP,
    // §11: 31.133.89.88 == exit_ip). If the reseller field is not one of these, or the listed IP is
    // NOT the egress IP, this must be updated — the exit_ip bridge is the load-bearing match key.
    const ipRaw = p.ip ?? p.ip_address ?? p.address ?? p.proxy_address ?? p.host ?? null;
    const ip = typeof ipRaw === 'string' ? ipRaw.trim() : '';
    if (!ip) return null;

    // LIVE-VERIFY: the status/health field + its truthy values. Map an active/live proxy to
    // 'healthy'. Unknown/absent → leave provider_health untouched (RPC keeps the existing value).
    let health: 'healthy' | 'unhealthy' | null = null;
    const status = p.status ?? p.state ?? null;
    if (typeof status === 'string') {
        const s = status.toLowerCase();
        if (['active', 'live', 'enabled', 'available', 'healthy'].includes(s)) health = 'healthy';
        else if (['expired', 'disabled', 'suspended', 'inactive', 'error'].includes(s)) health = 'unhealthy';
    }

    // LIVE-VERIFY: the expiry field name. plan_expires_at drives the claim RPC's safety window.
    // Only pass a value that LOOKS like an ISO-8601-ish timestamp (or that Date.parse accepts AND
    // contains a '-') through to the ::timestamptz cast — a garbage string must become null here
    // rather than reach the DB and (pre-FIX-4b) risk aborting the reconcile txn.
    const expRaw = p.expires_at ?? p.expire_at ?? p.expiry ?? p.expiration ?? p.plan_expires_at ?? null;
    const expStr = typeof expRaw === 'string' ? expRaw.trim() : '';
    const isoLike = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(expStr)
        || (expStr.includes('-') && !Number.isNaN(Date.parse(expStr)));
    const planExpiresAt = expStr && isoLike ? expStr : null;

    return { ext_id: `manual:${ip}`, ip, provider_health: health, plan_expires_at: planExpiresAt };
}

function iproyalResellerAdapter(): ProviderAdapter {
    return {
        provider: 'iproyal',
        async fetchSnapshot(): Promise<FetchResult> {
            // Worker secret. Prefer an explicit reseller token; fall back to IPROYAL_API (the token
            // §11 used for the live reseller call). Fail-closed when neither is set.
            const token = process.env.IPROYAL_API_RESELLER || process.env.IPROYAL_API;
            if (!token) return { ok: false, error: 'iproyal_token_missing' };

            let resp: Response;
            try {
                resp = await fetch(IPROYAL_RESELLER_LIST_URL, {
                    method: 'GET',
                    headers: { 'X-Access-Token': token, Accept: 'application/json' },
                    signal: AbortSignal.timeout(20_000),
                });
            } catch (err) {
                return { ok: false, error: `fetch_error:${errMsg(err)}` };
            }
            if (!resp.ok) return { ok: false, error: `http_${resp.status}` };
            // C4 continued: a standard RFC 5988 Link header with rel="next" is itself a pagination
            // marker, independent of anything in the JSON body — fail-closed before even parsing it.
            const linkHeader = resp.headers.get('link');
            if (linkHeader && /rel="next"/.test(linkHeader)) return { ok: false, error: 'paginated_unverified' };

            let body: unknown;
            try {
                body = await resp.json();
            } catch {
                return { ok: false, error: 'bad_json' };
            }

            const arr = extractProxyArray(body);
            if (arr === null) return { ok: false, error: 'unrecognized_envelope' };
            // C4: fail-closed if the envelope is a paginated object and we only saw the first page.
            if (body && typeof body === 'object' && !Array.isArray(body)
                && hasPaginationMarker(body as Record<string, unknown>, arr.length)) {
                return { ok: false, error: 'paginated_unverified' };
            }

            // A recognized-but-empty list IS a valid complete snapshot (the account genuinely owns 0
            // proxies → our rows would be legitimately missed). Only an UNRECOGNIZED shape is incomplete.
            const entries: ProxySnapshotEntry[] = [];
            for (const p of arr) {
                const e = normalizeEntry(p);
                if (e) entries.push(e);
            }
            // Defense in depth: a RECOGNIZED array where ANY element fails to normalize is NOT a
            // complete snapshot — a changed IP/field shape would silently drop real proxies and
            // (after 3 runs) flag them gone. Only a GENUINELY empty array (0 owned proxies) stays
            // complete; the RPC's zero_match_suspicious guard is the second line of defense.
            if (arr.length > 0 && entries.length !== arr.length) {
                return { ok: false, error: 'normalize_incomplete' };
            }
            return { ok: true, entries };
        },
    };
}

/** The providers we have a snapshot adapter for. The /sync route validates against this so an
 *  operator typo (or an unknown provider) is a 400 up front, not a silently-incomplete run. */
export const KNOWN_PROVIDERS = ['iproyal'] as const;

export function hasAdapter(provider: string): boolean {
    return (KNOWN_PROVIDERS as readonly string[]).includes(provider);
}

function getAdapter(provider: string): ProviderAdapter | null {
    if (provider === 'iproyal') return iproyalResellerAdapter();
    // Webshare etc. would slot in here (§2). Unknown provider → no adapter → fail-closed incomplete.
    return null;
}

/**
 * Enqueue tomorrow's proxy-sync job for a tenant, unless one is already QUEUED. Never throws
 * (best-effort keep-alive).
 *
 * C6 (codex P2.6): the dedup considers status='queued' ONLY — a still-RUNNING job must NOT suppress
 * its own successor. The old queued-OR-running guard was the loop-death bug: two proxy-sync jobs
 * running concurrently each saw the OTHER's 'running' row and neither enqueued a successor, killing
 * the chain. A partial unique index (mig 110) enforces at-most-one queued successor atomically, so a
 * lost read/insert race surfaces as a 23505 which we swallow as already-queued.
 */
export async function ensureProxySyncLoop(
    tenantId: string, provider: string, delayMs = LOOP_MS,
): Promise<boolean> {
    try {
        // Zero owned proxies for this provider → nothing to reconcile; stop rescheduling (mirrors
        // ensureRetentionLoop's zero-accounts stop). A read error fails-OPEN and still schedules —
        // dropping the loop is the worse failure.
        const { count, error: cntErr } = await researchSupabaseAdmin
            .from('linkedin_proxies').select('id', { count: 'exact', head: true })
            .eq('owner_tenant_id', tenantId).eq('provider', provider);
        if (!cntErr && (count ?? 0) === 0) return false;
        const { data: existing } = await researchSupabaseAdmin
            .from('research_jobs').select('id')
            .eq('tenant_id', tenantId).eq('type', RESEARCH_JOB_TYPES.LINKEDIN_PROXY_SYNC)
            .eq('status', 'queued').limit(1);
        if (existing && existing.length > 0) return false;
        try {
            await enqueueJob({
                tenantId, type: RESEARCH_JOB_TYPES.LINKEDIN_PROXY_SYNC,
                payload: { provider }, maxAttempts: 1, scheduledAt: new Date(Date.now() + delayMs),
            });
        } catch (enqErr) {
            // A concurrent enqueue won the partial-unique-index race — a queued successor already
            // exists, which is exactly the desired end-state. Treat as already-queued, not a failure.
            if ((enqErr as { code?: string })?.code === '23505') {
                log.debug({ tenantId, provider }, 'proxy-sync successor already queued (unique-index race)');
                return false;
            }
            throw enqErr;
        }
        return true;
    } catch (err) {
        log.warn({ err, tenantId }, 'ensureProxySyncLoop failed (non-fatal)');
        return false;
    }
}

export const linkedinProxySyncHandler: JobHandler = async ({ job, heartbeat }) => {
    const tenantId = job.tenant_id;
    await heartbeat({ stage: 'proxy-sync' });

    const p = (job.payload ?? {}) as Record<string, unknown>;
    const provider = typeof p.provider === 'string' && p.provider ? p.provider : 'iproyal';

    // Self-healing: queue the successor BEFORE any fetch/RPC that can throw (retention pattern). The
    // dedup is queued-only (C6), so THIS still-'running' job never suppresses its own successor.
    const rescheduled = await ensureProxySyncLoop(tenantId, provider, LOOP_MS);

    // Assemble the full snapshot in memory. A fetch failure is a SAFE incomplete run, not a job
    // failure — nothing destructive happens and the loop continues.
    let entries: ProxySnapshotEntry[] = [];
    let complete = false;
    let fetchError: string | null = null;

    const adapter = getAdapter(provider);
    if (!adapter) {
        fetchError = `no_adapter:${provider}`;
    } else {
        const res = await adapter.fetchSnapshot();
        if (res.ok) { entries = res.entries; complete = true; }
        else { fetchError = res.error; }
    }

    const { data, error } = await researchSupabaseAdmin.rpc('linkedin_proxy_sync_apply', {
        p_provider: provider,
        p_owner_tenant: tenantId, // reconcile THIS tenant's owned rows (global-pool fan-out = follow-up)
        p_snapshot: complete ? entries : [],
        p_complete: complete,
        p_error: complete ? null : (fetchError ?? 'fetch_failed'),
    });
    if (error) throw error; // genuine DB/RPC failure → fail the run (the successor is already queued)

    const result = (data ?? {}) as Record<string, unknown>;
    log.info({ jobId: job.id, tenantId, provider, complete, fetchError, rescheduled, ...result },
        `linkedin:proxy-sync ${complete ? 'reconciled' : 'incomplete (non-destructive)'}`);
    return { provider, complete, fetch_error: fetchError, rescheduled, ...result };
};
