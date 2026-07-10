/**
 * TG-LinkedIn — static residential proxy management (internal-only).
 *
 * The ONE way a dedicated IP enters the pool: an internal operator POSTs a verified
 * host:port:user:pass to the SERVER (never a client paste — that leaks plaintext creds +
 * enables SSRF; codex §9-P1.18). The route SSRF-guards + echo-verifies + geo-checks +
 * refuses a burned IP, then atomically imports+assigns via RPC and kicks a re-validate so
 * the account's send-time generation gate can open on the new IP.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod/v4';
import { requireRole } from '../../middleware/auth.js';
import { AppError } from '../../middleware/errorHandler.js';
import { createLogger } from '../../lib/logger.js';
import { validateBody, uuidField } from '../../lib/validation.js';
import { enqueueJob } from '../../lib/research/queue.js';
import { RESEARCH_JOB_TYPES } from '../../lib/research/jobTypes.js';
import { researchSupabaseAdmin } from '../../lib/research/supabase.js';
import { importAndAssignProxy, importProxyToPool } from '../../lib/linkedin/staticProxy.js';
import { hasAdapter } from '../../lib/research/worker/handlers/linkedinProxySync.js';
import {
    getQuote, placeOrder, pollOrder, provisionEnvPresent, evaluateSpendGuards,
    ProvisionError, type IproyalCredentials,
} from '../../lib/linkedin/provision.js';

const log = createLogger('route:linkedin:proxies');
const router = Router();
// Static proxy management is internal-only — it handles raw provider credentials and can
// dial arbitrary hosts, so client roles must never reach it.
const requireInternal = requireRole('superadmin', 'ops_agent');

const importSchema = z.object({
    account_id: uuidField('Invalid account_id'),
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    username: z.string().min(1).max(400),
    password: z.string().min(1).max(400),
    provider: z.string().min(1).max(40).optional(),
    ext_id: z.string().min(1).max(200).optional(),
    plan_id: z.string().min(1).max(200).optional(),
});

// Pool import — same verified host:port:user:pass, but WITHOUT an account (P1). The country is
// derived server-side from the echo-observed egress, so there is no account_id and no geo field.
const poolImportSchema = z.object({
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    username: z.string().min(1).max(400),
    password: z.string().min(1).max(400),
    provider: z.string().min(1).max(40).optional(),
    ext_id: z.string().min(1).max(200).optional(),
    plan_id: z.string().min(1).max(200).optional(),
});

// ── POST /proxies/import — verify + import + assign one static proxy to an account ──
router.post('/import', requireInternal, validateBody(importSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const b = req.body as z.infer<typeof importSchema>;

        const result = await importAndAssignProxy({
            tenantId,
            accountId: b.account_id,
            host: b.host,
            port: b.port,
            username: b.username,
            password: b.password,
            provider: b.provider,
            extId: b.ext_id ?? null,
            planId: b.plan_id ?? null,
        });

        if (!result.ok) {
            // Map the verify/RPC failure to a 4xx the operator can act on. exitIp/country are
            // safe to echo (public IP); credentials never appear in the response.
            res.status(422).json({
                error: result.error ?? 'import_failed',
                exit_ip: result.exitIp ?? null,
                country: result.country ?? null,
            });
            return;
        }

        // New IP must be re-validated before any send (the generation gate is cleared by the RPC).
        const job = await enqueueJob({
            tenantId,
            type: RESEARCH_JOB_TYPES.LINKEDIN_VALIDATE,
            payload: { account_id: b.account_id },
            maxAttempts: 1,
            createdBy: req.user?.id ?? null,
        });

        res.status(201).json({
            ok: true,
            proxy_id: result.proxyId,
            endpoint_generation: result.endpointGeneration,
            exit_ip: result.exitIp,
            country: result.country,
            validate_job_id: (job as { id?: string }).id ?? null,
        });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'proxy import error');
        next(new AppError('Proxy import failed', 500));
    }
});

// Proxy-sync trigger — internal seed/run of the daily staged reconcile loop (Proxy P2, §4a).
const syncSchema = z.object({
    provider: z.string().min(1).max(40).optional(),
});

// ── POST /proxies/sync — enqueue an immediate staged provider-inventory reconcile ──
// Seeds/kicks the self-rescheduling linkedin:proxy-sync loop. The job itself is fail-closed:
// any provider fetch error records an 'incomplete' run and changes nothing (§4a P1.8).
router.post('/sync', requireInternal, validateBody(syncSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const b = req.body as z.infer<typeof syncSchema>;
        const provider = b.provider ?? 'iproyal';
        // Reject an unknown provider up front (400) — otherwise it would enqueue a job that can only
        // ever record a fail-closed 'no_adapter' incomplete run, wasting a loop cycle.
        if (!hasAdapter(provider)) {
            throw new AppError(`Unknown proxy provider: ${provider}`, 400);
        }
        // Dedup: a concurrent double-trigger must not double-enqueue. Queued-ONLY (C6, matching
        // ensureProxySyncLoop): a RUNNING job must not block a fresh manual trigger, and the mig-110
        // partial unique index (at most one queued proxy-sync per tenant) is the atomic backstop for
        // the read→insert race — a lost race surfaces as a 23505 we treat as already-queued.
        const { data: existing } = await researchSupabaseAdmin
            .from('research_jobs').select('id, scheduled_at')
            .eq('tenant_id', tenantId).eq('type', RESEARCH_JOB_TYPES.LINKEDIN_PROXY_SYNC)
            .eq('status', 'queued').limit(1);
        if (existing && existing.length > 0) {
            const existingJob = existing[0] as { id: string; scheduled_at: string | null };
            // A queued successor already exists — a bare "already_queued" leaves an operator's manual
            // kick doing nothing until the loop's own 24h schedule comes around. Advance it to run now,
            // but ONLY when it's still scheduled in the future and still 'queued' (the .eq('status',
            // 'queued') guard prevents touching a row the worker has since claimed — an update matching
            // 0 rows just means we lost that race, which is handled below by falling through).
            const isFuture = existingJob.scheduled_at ? new Date(existingJob.scheduled_at).getTime() > Date.now() : false;
            if (isFuture) {
                const { data: advanced } = await researchSupabaseAdmin
                    .from('research_jobs')
                    .update({ scheduled_at: new Date().toISOString() })
                    .eq('id', existingJob.id).eq('status', 'queued')
                    .select('id');
                if (advanced && advanced.length > 0) {
                    res.status(202).json({ ok: true, provider, advanced: true, sync_job_id: existingJob.id });
                    return;
                }
                // Raced (job was claimed between the read and the update) — fall through to the normal
                // enqueue attempt below, which is tolerant of a concurrent successor via 23505.
            } else {
                res.status(202).json({ ok: true, provider, already_queued: true, sync_job_id: existingJob.id });
                return;
            }
        }
        let job: { id?: string };
        try {
            job = await enqueueJob({
                tenantId,
                type: RESEARCH_JOB_TYPES.LINKEDIN_PROXY_SYNC,
                payload: { provider },
                maxAttempts: 1,
                createdBy: req.user?.id ?? null,
            });
        } catch (enqErr) {
            if ((enqErr as { code?: string })?.code === '23505') {
                res.status(202).json({ ok: true, provider, already_queued: true, sync_job_id: null });
                return;
            }
            throw enqErr;
        }
        res.status(202).json({ ok: true, provider, sync_job_id: job.id ?? null });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'proxy sync trigger error');
        next(new AppError('Proxy sync trigger failed', 500));
    }
});

// ── POST /proxies/pool — verify + import one static proxy into the POOL (no account) ──
// Seeds a dedicated IP into the pool for a later linkedin_claim_proxy. Identical SSRF +
// echo-verify path to /import; it just never binds an account (so no revalidate is kicked).
router.post('/pool', requireInternal, validateBody(poolImportSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const b = req.body as z.infer<typeof poolImportSchema>;

        const result = await importProxyToPool({
            tenantId,
            host: b.host,
            port: b.port,
            username: b.username,
            password: b.password,
            provider: b.provider,
            extId: b.ext_id ?? null,
            planId: b.plan_id ?? null,
        });

        if (!result.ok) {
            res.status(422).json({
                error: result.error ?? 'import_failed',
                exit_ip: result.exitIp ?? null,
                country: result.country ?? null,
            });
            return;
        }

        res.status(201).json({
            ok: true,
            proxy_id: result.proxyId,
            endpoint_generation: result.endpointGeneration,
            exit_ip: result.exitIp,
            country: result.country,
        });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'proxy pool import error');
        next(new AppError('Proxy pool import failed', 500));
    }
});

// ══════════════════════════════════════════════════════════════════════════════════
// Proxy P3 — IPRoyal reseller auto-provision (quote → confirm-order → poll → import).
//
// SPEND SAFETY: a real charge is impossible without ALL of — internal role (route guard) +
// a fresh quote_id (< 15 min, still 'quoted', same tenant) + per-tenant daily cap (< 3 real
// orders / 24h) + reseller env present. placeOrder (the only money call) is reached solely after
// evaluateSpendGuards passes AND we atomically claim the quote row (quoted → ordered, single-use).
// ══════════════════════════════════════════════════════════════════════════════════

const provisionSchema = z.object({
    country: z.string().length(2).optional(),
    account_id: uuidField('Invalid account_id').optional(),
    confirm: uuidField('Invalid confirm quote_id').optional(),
});

const POLL_BUDGET_MS = 60_000;
const REPOLL_BUDGET_MS = 30_000;
const POLL_INTERVAL_MS = 5_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Map a ProvisionError to an operator-actionable status code. */
function provisionErrStatus(err: ProvisionError): number {
    switch (err.code) {
        case 'env_missing': return 503;
        case 'out_of_stock':
        case 'catalog_shifted': return 409;
        case 'product_not_found':
        case 'plan_not_found':
        case 'location_not_found': return 422;
        default: return 502; // http_error / bad_envelope / order_create_failed / poll_failed
    }
}

/** Result of the atomic cap-check + quoted→ordered claim RPC. */
type ClaimResult =
    | { ok: true; order_id: string; country: string | null; product_id: number | null; plan_id: number | null; quoted_price: number | null; account_id: string | null }
    | { ok: false; error: string };

/**
 * Atomic daily-cap check + quoted→ordered claim. This is the ONLY transition into a spend state:
 * a single DB tx (per-tenant advisory lock) both proves under-cap and claims the quote, stamping
 * the immutable purchase clock (ordered_at). FAIL CLOSED — any RPC/DB error throws, so the caller
 * must abort (never reach placeOrder). A null/unshaped payload is treated as an error, not ok.
 */
async function claimProvisionOrder(tenantId: string, quoteId: string): Promise<ClaimResult> {
    const { data, error } = await researchSupabaseAdmin.rpc('linkedin_claim_provision_order', {
        p_tenant: tenantId, p_quote_id: quoteId,
    });
    if (error) throw new AppError(`claim rpc failed: ${error.message}`, 500);
    const r = data as ClaimResult | null;
    if (!r || typeof r.ok !== 'boolean') throw new AppError('claim rpc returned no result', 500);
    return r;
}

/** Poll GET /orders/{id} until confirmed-with-credentials or the time budget runs out. */
async function pollUntilConfirmed(extOrderId: string, budgetMs: number): Promise<IproyalCredentials | null> {
    const deadline = Date.now() + budgetMs;
    // First poll immediately, then every POLL_INTERVAL_MS until the deadline.
    for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const r = await pollOrder(extOrderId);
        if (r.confirmed && r.credentials) return r.credentials;
        if (Date.now() + POLL_INTERVAL_MS >= deadline) return null;
        // eslint-disable-next-line no-await-in-loop
        await sleep(POLL_INTERVAL_MS);
    }
}

/**
 * Finish a PAID order: CAS-claim the import, run the credentials through the EXISTING server-side
 * import path (SSRF-guard + 2-echo egress-verify + burned-denylist + atomic RPC — reused, not
 * duplicated), then advance to a COUNTED terminal state. Binds to the account when the quote
 * carried one, else seeds the pool.
 *
 * CONCURRENCY (FIX 5): the confirm path and any number of GET re-polls can race here. We CAS-claim
 * an 'importing' state (UPDATE … WHERE id AND status IN ('ordered','confirmed')); if 0 rows we lost
 * the race (another request owns it, or it's already terminal) and we just report the current state
 * — never a second import, second validate-enqueue, or an 'imported' overwritten by a later failure.
 * Terminal writes are conditional on still being 'importing'.
 *
 * SPEND SAFETY (FIX 2): the row is already 'ordered'/counted before we get here, and an import
 * failure lands on 'import_failed' (COUNTED) — NEVER back on the uncounted pre-spend 'failed'. A
 * paid order can therefore never fall out of the daily cap.
 */
async function finishOrder(
    row: { id: string; account_id: string | null; ext_order_id: string | null; plan_id: number | null },
    tenantId: string, creds: IproyalCredentials, createdBy: string | null,
): Promise<{ http: number; body: Record<string, unknown> }> {
    // CAS-claim the import. Only one request can move ordered/confirmed → importing.
    const { data: claimed } = await researchSupabaseAdmin.from('linkedin_proxy_orders')
        .update({ status: 'importing', updated_at: new Date().toISOString() })
        .eq('id', row.id).in('status', ['ordered', 'confirmed']).select('id');
    if (!claimed || claimed.length === 0) {
        // Someone else owns the import (or the row is already terminal) — report current state.
        const { data: cur } = await researchSupabaseAdmin.from('linkedin_proxy_orders')
            .select('status, proxy_id, error, country').eq('id', row.id).eq('tenant_id', tenantId).maybeSingle();
        const c = cur as { status?: string; proxy_id?: string | null; error?: string | null; country?: string | null } | null;
        const s = c?.status ?? 'unknown';
        if (s === 'imported') return { http: 200, body: { ok: true, order_id: row.id, status: 'imported', proxy_id: c?.proxy_id ?? null, country: c?.country ?? null } };
        if (s === 'import_failed' || s === 'failed') return { http: 200, body: { ok: false, order_id: row.id, status: s, error: c?.error ?? null } };
        // Still importing under another request — pending, do NOT re-import.
        return { http: 202, body: { ok: true, order_id: row.id, status: s, pending: true } };
    }

    const extId = row.ext_order_id ? `iproyal:order:${row.ext_order_id}` : null;
    const planId = row.plan_id !== null ? String(row.plan_id) : null;

    const result = row.account_id
        ? await importAndAssignProxy({
            tenantId, accountId: row.account_id, host: creds.host, port: creds.port,
            username: creds.username, password: creds.password, provider: 'iproyal', extId, planId,
        })
        : await importProxyToPool({
            tenantId, host: creds.host, port: creds.port,
            username: creds.username, password: creds.password, provider: 'iproyal', extId, planId,
        });

    if (!result.ok) {
        // POST-payment import failure → COUNTED terminal state (never the uncounted 'failed').
        // This CAS write is the only thing that gets a stuck-'importing' PAID order out of limbo,
        // so a write error or an unexpected 0-row match must be loud (never silently reported as
        // success) and the response must reflect the row's true persisted state, not the assumed one.
        const { data: failedRows, error: failedErr } = await researchSupabaseAdmin.from('linkedin_proxy_orders')
            .update({ status: 'import_failed', error: `import:${result.error ?? 'import_failed'}`, updated_at: new Date().toISOString() })
            .eq('id', row.id).eq('status', 'importing').select('id');
        if (failedErr || !failedRows || failedRows.length === 0) {
            log.error({ err: failedErr?.message, orderId: row.id, intendedStatus: 'import_failed', matched: failedRows?.length ?? 0 },
                'PAID order: terminal import_failed write did not persist — order may be stuck in importing');
            const { data: reread } = await researchSupabaseAdmin.from('linkedin_proxy_orders')
                .select('status, error, country').eq('id', row.id).maybeSingle();
            const rr = reread as { status?: string; error?: string | null; country?: string | null } | null;
            return { http: 500, body: { ok: false, order_id: row.id, status: rr?.status ?? 'unknown', error: rr?.error ?? result.error ?? 'import_failed', persist_error: true } };
        }
        return { http: 422, body: { ok: false, order_id: row.id, status: 'import_failed', error: result.error ?? 'import_failed', exit_ip: result.exitIp ?? null, country: result.country ?? null } };
    }

    // Same CAS-terminal-write contract as the import_failed branch above: check the error and the
    // affected-row result, log loudly on failure, and re-read the true state rather than assuming
    // 'imported' succeeded (a PAID order silently stuck in 'importing' would otherwise be invisible).
    const { data: importedRows, error: importedErr } = await researchSupabaseAdmin.from('linkedin_proxy_orders')
        .update({ status: 'imported', proxy_id: result.proxyId ?? null, error: null, updated_at: new Date().toISOString() })
        .eq('id', row.id).eq('status', 'importing').select('id');
    if (importedErr || !importedRows || importedRows.length === 0) {
        log.error({ err: importedErr?.message, orderId: row.id, intendedStatus: 'imported', matched: importedRows?.length ?? 0, proxyId: result.proxyId ?? null },
            'PAID order: terminal imported write did not persist — order may be stuck in importing');
        const { data: reread } = await researchSupabaseAdmin.from('linkedin_proxy_orders')
            .select('status, proxy_id, error, country').eq('id', row.id).maybeSingle();
        const rr = reread as { status?: string; proxy_id?: string | null; error?: string | null; country?: string | null } | null;
        return { http: 500, body: { ok: false, order_id: row.id, status: rr?.status ?? 'unknown', proxy_id: rr?.proxy_id ?? result.proxyId ?? null, error: rr?.error ?? null, persist_error: true } };
    }

    // An account-bound IP must be re-validated before any send (generation gate cleared by the RPC).
    let validateJobId: string | null = null;
    if (row.account_id) {
        const job = await enqueueJob({
            tenantId, type: RESEARCH_JOB_TYPES.LINKEDIN_VALIDATE,
            payload: { account_id: row.account_id }, maxAttempts: 1, createdBy,
        });
        validateJobId = (job as { id?: string }).id ?? null;
    }
    return {
        http: 201,
        body: {
            ok: true, order_id: row.id, status: 'imported', proxy_id: result.proxyId, endpoint_generation: result.endpointGeneration,
            exit_ip: result.exitIp, country: result.country, validate_job_id: validateJobId,
        },
    };
}

// ── POST /proxies/provision — QUOTE (read-only) or CONFIRM (spends, guarded) ──
router.post('/provision', requireInternal, validateBody(provisionSchema), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const b = req.body as z.infer<typeof provisionSchema>;

        // ═══ CONFIRM MODE — the ONLY path that spends money ═══
        if (b.confirm) {
            const { data: rowData } = await researchSupabaseAdmin
                .from('linkedin_proxy_orders').select('*')
                .eq('id', b.confirm).eq('tenant_id', tenantId).maybeSingle();
            const row = rowData as {
                id: string; tenant_id: string; status: string; created_at: string;
                country: string | null; account_id: string | null; product_id: number | null;
                plan_id: number | null; quoted_price: number | null; ext_order_id: string | null;
            } | null;

            // ── PRE-SPEND advisory guard: env + fresh/valid quote (NOT the cap; the cap is the
            //    atomic RPC below). Gives the operator a granular code before the live re-price.
            const guard = evaluateSpendGuards({
                row: row ? { tenant_id: row.tenant_id, status: row.status, created_at: row.created_at } : null,
                tenantId, now: Date.now(), envPresent: provisionEnvPresent(), maxQuoteAgeMs: 15 * 60 * 1000,
            });
            if (!guard.ok) { res.status(guard.http).json({ error: guard.code }); return; }
            const q = row!; // guard proved it exists

            if (!q.country || !/^[a-z]{2}$/.test(q.country)) { res.status(422).json({ error: 'quote_no_country' }); return; }

            // Re-price live right before spending; refuse if the catalog drifted (product/plan
            // changed or price went UP vs the quote the operator authorized). PRE-SPEND — the row
            // is still 'quoted', so a refusal here never burns a cap slot.
            let fresh;
            try {
                fresh = await getQuote(q.country);
            } catch (err) {
                if (err instanceof ProvisionError) { res.status(provisionErrStatus(err)).json({ error: err.code }); return; }
                throw err;
            }
            if (fresh.productId !== q.product_id || fresh.planId !== q.plan_id ||
                (q.quoted_price !== null && fresh.price > q.quoted_price)) {
                res.status(409).json({ error: 'catalog_shifted', quoted_price: q.quoted_price, current_price: fresh.price });
                return;
            }

            // ═══ THE atomic spend gate ═══ ONE tx (advisory-locked) both proves the tenant is under
            // the daily cap AND claims this quote (quoted → ordered, stamps ordered_at). placeOrder
            // is reached ONLY past this. FAIL CLOSED: claimProvisionOrder throws on any DB/RPC error,
            // which the outer catch turns into a 5xx — never a call to placeOrder.
            const claim = await claimProvisionOrder(tenantId, q.id);
            if (!claim.ok) {
                const http = claim.error === 'daily_cap' ? 429 : claim.error === 'quote_invalid' ? 409 : 409;
                res.status(http).json({ error: claim.error });
                return;
            }

            // ⚠️ THE money call. Reached only past all guards + the atomic cap-check + claim. The row
            // is now 'ordered' (COUNTED). On ANY failure the order MAY have charged, so we keep it
            // 'ordered' (counted) and only record the error — NEVER downgrade to an uncounted state.
            let orderRef;
            try {
                orderRef = await placeOrder(fresh);
            } catch (err) {
                const code = err instanceof ProvisionError ? err.code : 'order_create_failed';
                await researchSupabaseAdmin.from('linkedin_proxy_orders')
                    .update({ error: `order:${code}`, updated_at: new Date().toISOString() }).eq('id', q.id);
                res.status(err instanceof ProvisionError ? provisionErrStatus(err) : 502).json({ error: code, order_id: q.id, status: 'ordered' });
                return;
            }
            // The order is ALREADY PAID (placeOrder succeeded above) — persisting ext_order_id is
            // for reconciliation only, not a gate. If this write fails, do NOT throw before the
            // order row (it's already 'ordered'); instead log loudly so an operator can reconcile
            // a paid order whose provider order id failed to persist, and surface it to the caller.
            const { error: extIdErr } = await researchSupabaseAdmin.from('linkedin_proxy_orders')
                .update({ ext_order_id: orderRef.extOrderId, updated_at: new Date().toISOString() }).eq('id', q.id);
            if (extIdErr) {
                log.error({ err: extIdErr.message, orderId: q.id, extOrderId: orderRef.extOrderId },
                    'PAID order: failed to persist ext_order_id — reconcile manually');
                res.status(500).json({ error: 'ext_order_id_persist_failed', order_id: q.id, status: 'ordered' });
                return;
            }

            // Bounded poll for the credentials.
            const creds = await pollUntilConfirmed(orderRef.extOrderId, POLL_BUDGET_MS);
            if (!creds) {
                // Still pending — the order stands ('ordered', counted); operator completes via GET /:id.
                res.status(202).json({ ok: true, order_id: q.id, ext_order_id: orderRef.extOrderId, status: 'ordered', pending: true });
                return;
            }

            // finishOrder CAS-claims the import (ordered/confirmed → importing) and lands a COUNTED
            // terminal state; a racing GET re-poll can't double-import.
            const done = await finishOrder(
                { id: q.id, account_id: q.account_id, ext_order_id: orderRef.extOrderId, plan_id: q.plan_id },
                tenantId, creds, req.user?.id ?? null,
            );
            res.status(done.http).json(done.body);
            return;
        }

        // ═══ QUOTE MODE — read-only catalog lookup, NO purchase ═══
        let country: string;
        let accountId: string | null = null;
        if (b.account_id) {
            // Country is derived from the account's own geo (server-side), never the body — an
            // operator can't price a US account against a TR IP.
            const { data: acct } = await researchSupabaseAdmin
                .from('linkedin_accounts').select('geo').eq('id', b.account_id).eq('tenant_id', tenantId).maybeSingle();
            const geo = ((acct as { geo?: string | null } | null)?.geo ?? '').trim().toLowerCase();
            if (!/^[a-z]{2}$/.test(geo)) { res.status(422).json({ error: 'account_no_geo' }); return; }
            country = geo;
            accountId = b.account_id;
        } else if (b.country) {
            country = b.country.trim().toLowerCase();
            if (!/^[a-z]{2}$/.test(country)) { res.status(400).json({ error: 'invalid_country' }); return; }
        } else {
            res.status(400).json({ error: 'need_country_or_account' });
            return;
        }

        if (!provisionEnvPresent()) { res.status(503).json({ error: 'env_missing' }); return; }

        let quote;
        try {
            quote = await getQuote(country);
        } catch (err) {
            if (err instanceof ProvisionError) { res.status(provisionErrStatus(err)).json({ error: err.code }); return; }
            throw err;
        }

        const { data: inserted, error: insErr } = await researchSupabaseAdmin
            .from('linkedin_proxy_orders')
            .insert({
                tenant_id: tenantId, provider: 'iproyal', account_id: accountId, country: quote.country,
                product_id: quote.productId, plan_id: quote.planId, quoted_price: quote.price,
                status: 'quoted', created_by: req.user?.id ?? null,
            })
            .select('id').single();
        if (insErr || !inserted) {
            log.error({ err: insErr?.message }, 'quote insert failed');
            throw new AppError('Quote persist failed', 500);
        }

        res.status(200).json({
            quote_id: (inserted as { id: string }).id,
            country: quote.country,
            price: quote.price,
            product_id: quote.productId,
            plan_id: quote.planId,
            confirm_hint: 'POST /proxies/provision { confirm: "<quote_id>" } within 15 minutes to purchase',
        });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'proxy provision error');
        next(new AppError('Proxy provision failed', 500));
    }
});

// ── GET /proxies/provision/:id — re-poll an 'ordered' row + finish import (idempotent) ──
router.get('/provision/:id', requireInternal, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        const id = String(req.params.id ?? '');
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
            throw new AppError('Invalid order id', 400);
        }
        const { data: rowData } = await researchSupabaseAdmin
            .from('linkedin_proxy_orders').select('*').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
        const row = rowData as {
            id: string; status: string; account_id: string | null; ext_order_id: string | null;
            plan_id: number | null; proxy_id: string | null; error: string | null; country: string | null;
        } | null;
        if (!row) { res.status(404).json({ error: 'order_not_found' }); return; }

        // Idempotent terminal states — return as-is (no re-poll, no re-import).
        if (row.status === 'imported') {
            res.status(200).json({ ok: true, order_id: row.id, status: 'imported', proxy_id: row.proxy_id, country: row.country });
            return;
        }
        // 'import_failed' = PAID order whose import failed (COUNTED); 'failed' = pre-spend abort.
        if (row.status === 'import_failed' || row.status === 'failed') {
            res.status(200).json({ ok: false, order_id: row.id, status: row.status, error: row.error }); return;
        }
        // Another request is mid-import — do NOT race it; report pending.
        if (row.status === 'importing') { res.status(202).json({ ok: true, order_id: row.id, status: 'importing', pending: true }); return; }
        if (row.status === 'quoted') { res.status(409).json({ error: 'not_ordered', order_id: row.id, status: 'quoted' }); return; }
        // 'ordered' or 'confirmed' with an ext_order_id → re-poll and try to finish.
        if (!row.ext_order_id) { res.status(202).json({ ok: true, order_id: row.id, status: row.status, pending: true }); return; }

        const creds = await pollUntilConfirmed(row.ext_order_id, REPOLL_BUDGET_MS);
        if (!creds) { res.status(202).json({ ok: true, order_id: row.id, ext_order_id: row.ext_order_id, status: 'ordered', pending: true }); return; }
        // finishOrder CAS-claims the import (ordered/confirmed → importing); a concurrent re-poll or
        // the confirm path can't double-import — the loser just gets the current state back.
        const done = await finishOrder(
            { id: row.id, account_id: row.account_id, ext_order_id: row.ext_order_id, plan_id: row.plan_id },
            tenantId, creds, req.user?.id ?? null,
        );
        res.status(done.http).json(done.body);
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'proxy provision status error');
        next(new AppError('Proxy provision status failed', 500));
    }
});

export default router;
