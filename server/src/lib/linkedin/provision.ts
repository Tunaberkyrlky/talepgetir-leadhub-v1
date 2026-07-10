/**
 * TG-LinkedIn Proxy P3 — IPRoyal reseller API client (quote → order → poll).
 *
 * ⚠️ SPEND SAFETY: getQuote is READ-ONLY (catalog/pricing lookup) and safe to call live.
 * placeOrder hits the order-create endpoint and SPENDS REAL MONEY — it must ONLY be reached
 * behind the route's four-layer spend guard (fresh quote id + daily cap + env present + internal
 * role). Nothing here fabricates a success: an unrecognized envelope is a typed ProvisionError,
 * never a fake confirmed order.
 *
 * LIVE-PROVEN (2026-07-10, §11): base https://apid.iproyal.com/v1/reseller, header
 * X-Access-Token: <IPROYAL_API>. Catalog GET /products envelope was re-confirmed live during this
 * build: data[] with product id=9 "ISP Dedicated", plans[].{id,name,price} (30 Days id=22 $4.00),
 * locations[].{id,name,out_of_stock,child_locations[]} (Turkey id=147). The order-create and
 * order-poll network paths are reconstructed from https://docs.iproyal.com/proxies/isp/api/orders
 * and marked LIVE-VERIFY — they were NEVER called during the build (spending real money).
 */
import { createLogger } from '../logger.js';

const log = createLogger('linkedin:provision');

const RESELLER_BASE = 'https://apid.iproyal.com/v1/reseller';
const DEFAULT_PAYMENT_CARD_ID = '350281'; // §11 live-proven card id; override via IPROYAL_PAYMENT_CARD_ID
const DEFAULT_PRODUCT_NAME = 'ISP Dedicated'; // product id 9 (TR ISP dedicated static residential)
const DEFAULT_PLAN_NAME = '30 Days';          // plan id 22
const CALL_TIMEOUT_MS = 20_000;

/** Minimal ISO-2 → English country name map for locations[].name matching (extend as needed). */
const ISO2_TO_NAME: Record<string, string> = {
    tr: 'turkey', us: 'united states', gb: 'united kingdom', de: 'germany', fr: 'france',
    nl: 'netherlands', es: 'spain', it: 'italy', pl: 'poland', ca: 'canada', au: 'australia',
    ae: 'united arab emirates', sa: 'saudi arabia', in: 'india', br: 'brazil', jp: 'japan',
};

export type ProvisionErrorCode =
    | 'env_missing' | 'http_error' | 'bad_envelope' | 'product_not_found' | 'plan_not_found'
    | 'location_not_found' | 'out_of_stock' | 'order_create_failed' | 'poll_failed'
    | 'no_credentials' | 'catalog_shifted';

export class ProvisionError extends Error {
    code: ProvisionErrorCode;
    detail?: unknown;
    constructor(code: ProvisionErrorCode, message?: string, detail?: unknown) {
        super(message ?? code);
        this.name = 'ProvisionError';
        this.code = code;
        this.detail = detail;
    }
}

export interface IproyalQuote {
    productId: number;
    productName: string;
    planId: number;
    planName: string;
    locationId: number;
    locationName: string;
    price: number;
    country: string; // ISO-2 lower
}

export interface IproyalOrderRef {
    extOrderId: string;
    status: string;
}

export interface IproyalCredentials {
    host: string;
    port: number;
    username: string;
    password: string;
    exitIpHint?: string | null;
}

export interface IproyalPollResult {
    status: string;              // unpaid | in-progress | confirmed | refunded | expired
    confirmed: boolean;
    credentials: IproyalCredentials | null;
    expiresAt?: string | null;
}

type FetchLike = typeof fetch;
export interface ProvisionDeps { fetchImpl?: FetchLike; token?: string | null; }

export function resellerToken(): string | null {
    // Prefer an explicit reseller token; fall back to IPROYAL_API (the token §11 used live).
    return process.env.IPROYAL_API_RESELLER || process.env.IPROYAL_API || null;
}

export function paymentCardId(): string {
    return process.env.IPROYAL_PAYMENT_CARD_ID || DEFAULT_PAYMENT_CARD_ID;
}

/** Env is present iff a reseller token exists — the route's spend guard (c). */
export function provisionEnvPresent(): boolean {
    return !!resellerToken();
}

async function resellerFetch(
    deps: ProvisionDeps | undefined, method: 'GET' | 'POST', path: string, body?: unknown,
): Promise<unknown> {
    // An explicit `token` key in deps is authoritative (lets a test force "no token"); absent deps
    // ⇒ read the env token. The route never passes deps, so it always uses the env secret.
    const token = deps && 'token' in deps ? deps.token : resellerToken();
    if (!token) throw new ProvisionError('env_missing', 'IPROYAL_API (reseller token) is not set');
    const f = deps?.fetchImpl ?? fetch;
    let resp: Response;
    try {
        resp = await f(`${RESELLER_BASE}${path}`, {
            method,
            headers: {
                'X-Access-Token': token,
                Accept: 'application/json',
                ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        });
    } catch (err) {
        throw new ProvisionError('http_error', `reseller ${method} ${path} network error`, err);
    }
    const text = await resp.text();
    if (resp.status < 200 || resp.status >= 300) {
        throw new ProvisionError('http_error', `reseller ${method} ${path} → HTTP ${resp.status}`, text.slice(0, 400));
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new ProvisionError('bad_envelope', `reseller ${method} ${path} non-JSON body`, text.slice(0, 200));
    }
}

interface CatalogPlan { id?: number; name?: string; price?: number }
interface CatalogLocation { id?: number; name?: string; out_of_stock?: boolean }
interface CatalogProduct { id?: number; name?: string; plans?: CatalogPlan[]; locations?: CatalogLocation[] }

/**
 * READ-ONLY catalog/pricing lookup — safe to call live. Resolves the ISP-Dedicated product,
 * the 30-day plan, and the country's location, returning the priced quote. Fail-closed at every
 * step (unknown product/plan/location or out-of-stock → typed error, never a fabricated quote).
 */
export async function getQuote(country: string, deps?: ProvisionDeps): Promise<IproyalQuote> {
    const iso2 = (country ?? '').trim().toLowerCase();
    if (!/^[a-z]{2}$/.test(iso2)) throw new ProvisionError('location_not_found', `invalid country '${country}'`);

    const raw = await resellerFetch(deps, 'GET', '/products');
    const data = (raw as { data?: CatalogProduct[] } | null)?.data;
    if (!Array.isArray(data)) throw new ProvisionError('bad_envelope', 'catalog has no data[] array');

    const product = data.find((p) => (p?.name ?? '').trim().toLowerCase() === DEFAULT_PRODUCT_NAME.toLowerCase());
    if (!product || typeof product.id !== 'number') throw new ProvisionError('product_not_found', DEFAULT_PRODUCT_NAME);

    const plan = (product.plans ?? []).find((pl) => (pl?.name ?? '').trim().toLowerCase() === DEFAULT_PLAN_NAME.toLowerCase());
    if (!plan || typeof plan.id !== 'number' || typeof plan.price !== 'number') {
        throw new ProvisionError('plan_not_found', DEFAULT_PLAN_NAME);
    }

    const wantName = ISO2_TO_NAME[iso2];
    if (!wantName) throw new ProvisionError('location_not_found', `no country-name mapping for '${iso2}'`);
    const loc = (product.locations ?? []).find((l) => (l?.name ?? '').trim().toLowerCase() === wantName);
    if (!loc || typeof loc.id !== 'number') throw new ProvisionError('location_not_found', wantName);
    if (loc.out_of_stock) throw new ProvisionError('out_of_stock', `${wantName} is out of stock`);

    return {
        productId: product.id, productName: product.name ?? DEFAULT_PRODUCT_NAME,
        planId: plan.id, planName: plan.name ?? DEFAULT_PLAN_NAME,
        locationId: loc.id, locationName: loc.name ?? wantName,
        price: plan.price, country: iso2,
    };
}

/**
 * ⚠️ SPENDS REAL MONEY. Order-create. LIVE-VERIFY: reconstructed from docs (POST /orders with
 * product_id/product_plan_id/product_location_id/quantity/card_id). MUST be gated by the route's
 * spend guard. Never call from a smoke/build.
 */
export async function placeOrder(quote: IproyalQuote, cardId?: string, deps?: ProvisionDeps): Promise<IproyalOrderRef> {
    // LIVE-VERIFY: exact request field names + card_id typing (Integer per docs).
    const body = {
        product_id: quote.productId,
        product_plan_id: quote.planId,
        product_location_id: quote.locationId,
        quantity: 1,
        card_id: Number(cardId ?? paymentCardId()),
    };
    log.warn({ product: quote.productId, plan: quote.planId, loc: quote.locationId }, 'placeOrder: SPENDING via IPRoyal reseller');
    const raw = await resellerFetch(deps, 'POST', '/orders', body);
    const o = raw as { id?: number | string; status?: string } | null;
    if (!o || (o.id === undefined || o.id === null)) {
        throw new ProvisionError('order_create_failed', 'order response missing id', raw);
    }
    return { extOrderId: String(o.id), status: String(o.status ?? 'unknown') };
}

/** Pull host:port:user:pass out of the (undocumented) proxy_data envelope, fail-closed. */
export function extractCredentials(orderBody: unknown): IproyalCredentials | null {
    const pd = (orderBody as { proxy_data?: unknown } | null)?.proxy_data as
        { ports?: { 'http|https'?: number; http?: number; https?: number }; proxies?: unknown[] } | undefined;
    if (!pd) return null;
    const proxies = Array.isArray(pd.proxies) ? pd.proxies : [];
    if (proxies.length === 0) return null;
    const p = proxies[0] as Record<string, unknown>;
    // LIVE-VERIFY: the per-proxy credential field names. §11 gave IP 31.133.89.88:12323 user
    // 14ac4d163e078 — the array element likely carries ip/username/password; extract defensively.
    const host = String(p.ip ?? p.address ?? p.host ?? p.proxy_address ?? '');
    const username = String(p.username ?? p.user ?? p.login ?? '');
    const password = String(p.password ?? p.pass ?? '');
    const portRaw = (pd.ports?.['http|https'] ?? pd.ports?.http ?? pd.ports?.https ?? (p.port as number) ?? 0);
    const port = Number(portRaw);
    if (!host || !username || !password || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host, port, username, password, exitIpHint: host };
}

/**
 * LIVE-VERIFY network path: GET /orders/{id}. Read the status; when 'confirmed', extract the
 * credentials. Fail-closed: a confirmed order with no parseable credentials is 'no_credentials',
 * never a fabricated success.
 */
export async function pollOrder(extOrderId: string, deps?: ProvisionDeps): Promise<IproyalPollResult> {
    const raw = await resellerFetch(deps, 'GET', `/orders/${encodeURIComponent(extOrderId)}`);
    const o = raw as { status?: string; expire_date?: string } | null;
    const status = String(o?.status ?? 'unknown').toLowerCase();
    const confirmed = status === 'confirmed';
    const credentials = confirmed ? extractCredentials(raw) : null;
    return { status, confirmed, credentials, expiresAt: o?.expire_date ?? null };
}

// ── Spend guard (pure, testable) ──────────────────────────────────────────────────
// Fast-fail ADVISORY pre-check the route runs BEFORE the live re-price + the atomic claim. It
// covers env → row validity (exists/tenant/open/fresh) and gives the operator a granular HTTP
// code. It is NOT authoritative for the daily cap OR the claim: the AUTHORITATIVE cap-check +
// quoted→ordered transition happen together in linkedin_claim_provision_order (a single DB tx
// under a per-tenant advisory lock). The cap is deliberately NOT re-implemented here — a second,
// non-atomic TS count could disagree with the RPC and is the exact TOCTOU we're closing.
export interface QuoteRowLike {
    tenant_id: string;
    status: string;
    created_at: string; // ISO
}
export interface SpendGuardInput {
    row: QuoteRowLike | null;
    tenantId: string;
    now: number;                       // Date.now()
    envPresent: boolean;
    maxQuoteAgeMs?: number;            // default 15 min
}
export type SpendGuardResult = { ok: true } | { ok: false; code: string; http: number };

export function evaluateSpendGuards(input: SpendGuardInput): SpendGuardResult {
    const maxAge = input.maxQuoteAgeMs ?? 15 * 60 * 1000;
    // (c) env present — checked first so a spend can never be attempted without the token.
    if (!input.envPresent) return { ok: false, code: 'env_missing', http: 503 };
    // (a) quote row exists, same tenant, still 'quoted', younger than 15 min. (The RPC re-checks
    //     all of this authoritatively under the lock; this is only a friendlier early exit.)
    if (!input.row) return { ok: false, code: 'quote_not_found', http: 404 };
    if (input.row.tenant_id !== input.tenantId) return { ok: false, code: 'quote_not_found', http: 404 }; // no cross-tenant leak
    if (input.row.status !== 'quoted') return { ok: false, code: 'quote_not_open', http: 409 };
    const ageMs = input.now - new Date(input.row.created_at).getTime();
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > maxAge) return { ok: false, code: 'quote_stale', http: 410 };
    return { ok: true };
}
