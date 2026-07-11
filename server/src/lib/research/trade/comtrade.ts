/**
 * UN Comtrade trade-statistics client (research, Y2+). Supplies bounded country rankings and
 * bilateral product-flow facts without asking an LLM to infer trade values. The clean default is
 * the keyless public preview API; COMTRADE_SUBSCRIPTION_KEY switches the same queries to the
 * higher-quota data API and is sent only as its required query parameter.
 *
 * Comtrade silently substitutes an aggregate row for an invalid/nonexistent commodity code, so
 * EVERY data query is gated by the official HS reference nomenclature. That fail-closed check is
 * the hallucination guard: if the reference blob cannot be fetched, validation returns false and
 * no possibly unrelated trade value is allowed into research output. Static reference blobs are
 * fetched lazily and cached once per process after a successful load.
 *
 * Ranking calls are sequential, paced, and partial-result tolerant. Read-only data requests retry
 * only HTTP 429 responses (at most three total attempts); failures are logged, and failed or
 * missing points are omitted rather than aborting a whole country batch.
 */
import { createLogger } from '../../logger.js';

const log = createLogger('research:trade:comtrade');

const API_ORIGIN = 'https://comtradeapi.un.org';
const PREVIEW_PATH = '/public/v1/preview/C/A/HS';
const DATA_PATH = '/data/v1/get/C/A/HS';
const HS_REFERENCE_URL = `${API_ORIGIN}/files/v1/app/reference/HS.json`;
const REPORTERS_REFERENCE_URL = `${API_ORIGIN}/files/v1/app/reference/Reporters.json`;
const PARTNERS_REFERENCE_URL = `${API_ORIGIN}/files/v1/app/reference/partnerAreas.json`;

function envNum(key: string, fallback: number): number {
    const v = process.env[key];
    if (v === undefined) return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

const MAJOR_TRADING_ECONOMIES = [
    'US', 'CN', 'DE', 'JP', 'GB', 'FR', 'IN', 'IT', 'KR', 'NL', 'ES', 'CA',
    'MX', 'RU', 'BR', 'AU', 'CH', 'TR', 'SA', 'PL', 'BE', 'SE', 'TH', 'ID',
    'AT', 'NG', 'IE', 'IL', 'SG', 'VN', 'AE', 'ZA', 'DK', 'MY', 'PH',
] as const;

const MAX_REPORTERS = Math.min(
    MAJOR_TRADING_ECONOMIES.length,
    Math.max(0, Math.floor(envNum('COMTRADE_MAX_REPORTERS', MAJOR_TRADING_ECONOMIES.length))),
);
const INTER_CALL_DELAY_MS = Math.max(0, envNum('COMTRADE_INTER_CALL_DELAY_MS', 350));
// This knob counts retries after the first request; clamp to three total attempts.
const MAX_ATTEMPTS = Math.min(3, Math.max(1, Math.floor(envNum('COMTRADE_RETRY_COUNT', 2)) + 1));
const TIMEOUT_MS = Math.max(1, envNum('COMTRADE_TIMEOUT_MS', 20_000));
const FALLBACK_RATE_LIMIT_DELAY_MS = 2_500;

export type ComtradeFlow = 'M' | 'X';

export interface WorldImportRankingConfig {
    hsCode: string;
    year: number;
    /** When supplied, growth is (current - prior) / prior * 100. */
    priorYear?: number;
}

export interface WorldImportRankingEntry {
    rank: number;
    iso2: string;
    country: string;
    reporterCode: number;
    importValueUsd: number;
    priorYearImportValueUsd: number | null;
    growthPct: number | null;
}

export interface WorldImportRankingResult {
    hsCode: string;
    year: number;
    priorYear: number | null;
    ranked: WorldImportRankingEntry[];
    /** ISO2 reporters omitted because a requested Comtrade call failed, not merely had no data. */
    failed: string[];
}

export interface BilateralTradeConfig {
    reporter: string;
    partner: string;
    hsCode: string;
    flow: ComtradeFlow;
    year: number;
    /** When supplied, growth is (current - prior) / prior * 100. */
    priorYear?: number;
}

export interface BilateralTradeResult {
    hsCode: string;
    flow: ComtradeFlow;
    year: number;
    actualYear: number;
    priorYear: number | null;
    reporter: string;
    reporterCode: number;
    partner: string;
    partnerCode: number;
    primaryValueUsd: number;
    priorPrimaryValueUsd: number | null;
    growthPct: number | null;
}

interface HsReferenceRow {
    id?: unknown;
    aggrLevel?: unknown;
}

interface CountryReferenceRow {
    code: number;
    description: string;
    iso2: string;
    iso3: string;
    isGroup: boolean;
    isCurrent: boolean;
    /** Raw entryExpiredDate, only set when !isCurrent — lets preferCurrent() pick the most
     *  recently expired entity when every candidate for a code is defunct. */
    expiredDate: string | null;
}

interface RawCountryReferenceRow {
    reporterCode?: unknown;
    reporterDesc?: unknown;
    reporterCodeIsoAlpha2?: unknown;
    reporterCodeIsoAlpha3?: unknown;
    PartnerCode?: unknown;
    PartnerDesc?: unknown;
    PartnerCodeIsoAlpha2?: unknown;
    PartnerCodeIsoAlpha3?: unknown;
    isGroup?: unknown;
    entryExpiredDate?: unknown;
}

interface TradeRow {
    primaryValue?: unknown;
    partner2Code?: unknown;
}

interface TradeResponse {
    data?: TradeRow[];
}

type TradePointOutcome =
    | { kind: 'value'; value: number }
    | { kind: 'missing' }
    | { kind: 'failed' };

let hsCodesPromise: Promise<Set<string>> | null = null;
let reportersPromise: Promise<CountryReferenceRow[]> | null = null;
let partnersPromise: Promise<CountryReferenceRow[]> | null = null;

function apiKey(): string | null {
    return process.env.COMTRADE_SUBSCRIPTION_KEY?.trim() || null;
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function normalizeHsCode(code: string): string {
    return code.trim().replace(/\D/g, '');
}

function validYear(year: number): boolean {
    return Number.isInteger(year) && year >= 1000 && year <= 9999;
}

function sleep(ms: number): Promise<void> {
    return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

async function fetchReference(url: string, reference: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            headers: { Accept: 'application/json', 'User-Agent': 'tg-research-worker/1.0' },
            signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (err) {
        log.warn({ reference, err: errorMessage(err) }, 'comtrade reference fetch failed (fail-closed)');
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

function cachedLoad<T>(
    current: Promise<T> | null,
    setCurrent: (promise: Promise<T> | null) => void,
    load: () => Promise<T>,
): Promise<T> {
    if (current) return current;
    const promise = load().catch((err) => {
        // Cache successful reference data for process lifetime, but allow a later call to recover
        // from a transient first-load failure.
        setCurrent(null);
        throw err;
    });
    setCurrent(promise);
    return promise;
}

function hsCodes(): Promise<Set<string>> {
    return cachedLoad(hsCodesPromise, (promise) => { hsCodesPromise = promise; }, async () => {
        const json = (await fetchReference(HS_REFERENCE_URL, 'HS')) as { results?: HsReferenceRow[] };
        if (!Array.isArray(json.results)) throw new Error('invalid HS reference response');
        const codes = new Set<string>();
        for (const row of json.results) {
            if (typeof row.id === 'string' && /^\d{6}$/.test(row.id) && row.aggrLevel === 6) codes.add(row.id);
        }
        if (codes.size === 0) throw new Error('HS reference contained no six-digit codes');
        return codes;
    });
}

function countryRows(kind: 'reporter' | 'partner'): Promise<CountryReferenceRow[]> {
    const current = kind === 'reporter' ? reportersPromise : partnersPromise;
    const setCurrent = (promise: Promise<CountryReferenceRow[]> | null): void => {
        if (kind === 'reporter') reportersPromise = promise;
        else partnersPromise = promise;
    };
    return cachedLoad(current, setCurrent, async () => {
        const url = kind === 'reporter' ? REPORTERS_REFERENCE_URL : PARTNERS_REFERENCE_URL;
        const json = (await fetchReference(url, kind)) as { results?: RawCountryReferenceRow[] };
        if (!Array.isArray(json.results)) throw new Error(`invalid ${kind} reference response`);
        const rows: CountryReferenceRow[] = [];
        for (const row of json.results) {
            const code = kind === 'reporter' ? row.reporterCode : row.PartnerCode;
            const description = kind === 'reporter' ? row.reporterDesc : row.PartnerDesc;
            const iso2 = kind === 'reporter' ? row.reporterCodeIsoAlpha2 : row.PartnerCodeIsoAlpha2;
            const iso3 = kind === 'reporter' ? row.reporterCodeIsoAlpha3 : row.PartnerCodeIsoAlpha3;
            if (typeof code !== 'number' || typeof description !== 'string') continue;
            rows.push({
                code,
                description,
                iso2: typeof iso2 === 'string' ? iso2.toUpperCase() : '',
                iso3: typeof iso3 === 'string' ? iso3.toUpperCase() : '',
                isGroup: row.isGroup === true,
                isCurrent: row.entryExpiredDate == null,
                expiredDate: typeof row.entryExpiredDate === 'string' ? row.entryExpiredDate : null,
            });
        }
        if (rows.length === 0) throw new Error(`${kind} reference contained no countries`);
        return rows;
    });
}

/** Validate a normalized six-digit commodity code against the official HS nomenclature.
 *  Reference failures fail closed (false) so Comtrade cannot substitute an unrelated aggregate. */
export async function validateHsCode(code: string): Promise<boolean> {
    const normalized = normalizeHsCode(code);
    if (!/^\d{6}$/.test(normalized)) return false;
    try {
        return (await hsCodes()).has(normalized);
    } catch {
        return false;
    }
}

function foldCountry(value: string): string {
    return value
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function preferCurrent(rows: CountryReferenceRow[]): CountryReferenceRow[] {
    const current = rows.filter((row) => row.isCurrent);
    if (current.length > 0) return current;
    // Every candidate is defunct (e.g. several historical entities sharing an ISO code) —
    // pick deterministically by most-recently-expired instead of leaving it upstream-array-
    // order-dependent. Rows without a parsed date sort last (least likely to be the right one).
    return [...rows].sort((a, b) => {
        const at = a.expiredDate ? Date.parse(a.expiredDate) : NaN;
        const bt = b.expiredDate ? Date.parse(b.expiredDate) : NaN;
        if (Number.isNaN(at) && Number.isNaN(bt)) return 0;
        if (Number.isNaN(at)) return 1;
        if (Number.isNaN(bt)) return -1;
        return bt - at;
    });
}

async function resolveCountry(input: string, kind: 'reporter' | 'partner'): Promise<CountryReferenceRow | null> {
    const folded = foldCountry(input);
    if (!folded) return null;
    let rows: CountryReferenceRow[];
    try {
        rows = (await countryRows(kind)).filter((row) => !row.isGroup);
    } catch {
        return null;
    }

    const upper = input.trim().toUpperCase();
    const byCode = preferCurrent(rows.filter((row) => row.iso2 === upper || row.iso3 === upper));
    if (byCode.length > 0) return byCode[0];
    const exact = preferCurrent(rows.filter((row) => foldCountry(row.description) === folded));
    if (exact.length > 0) return exact[0];

    const loose = preferCurrent(rows.filter((row) => {
        const description = foldCountry(row.description);
        return description.includes(folded) || folded.includes(description);
    }));
    if (loose.length === 1) return loose[0];
    if (loose.length > 1) {
        log.warn({ input, kind, matches: loose.length }, 'comtrade country name was ambiguous');
    }
    return null;
}

/** Resolve an ISO2, ISO3, or case-insensitive country name to Comtrade's numeric area code. */
export async function resolveCountryCode(input: string, kind: 'reporter' | 'partner'): Promise<number | null> {
    return (await resolveCountry(input, kind))?.code ?? null;
}

/** Resolve a free-text country name to Comtrade's canonical description — the exact string
 *  market:analyze persists into research_markets.country — so evidence lookups elsewhere can
 *  match on it precisely regardless of what free text a human typed for the geography cell. */
export async function resolveCountryName(input: string, kind: 'reporter' | 'partner'): Promise<string | null> {
    return (await resolveCountry(input, kind))?.description ?? null;
}

let callGate: Promise<void> = Promise.resolve();
let nextCallAt = 0;

/** Serialize request starts across callers so separate ranking/bilateral operations share pacing. */
async function waitForCallSlot(): Promise<void> {
    const previous = callGate;
    let release!: () => void;
    callGate = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
        await sleep(Math.max(0, nextCallAt - Date.now()));
        nextCallAt = Date.now() + INTER_CALL_DELAY_MS;
    } finally {
        release();
    }
}

function rateLimitDelay(body: string): number {
    try {
        const parsed = JSON.parse(body) as { message?: unknown };
        const message = typeof parsed.message === 'string' ? parsed.message : '';
        const seconds = message.match(/try again in\s+([\d.]+)\s+seconds?/i)?.[1];
        const parsedSeconds = seconds === undefined ? NaN : Number(seconds);
        if (Number.isFinite(parsedSeconds) && parsedSeconds >= 0) return parsedSeconds * 1_000;
    } catch {
        // The fallback below intentionally handles non-JSON throttling responses.
    }
    return FALLBACK_RATE_LIMIT_DELAY_MS;
}

function tradeUrl(reporterCode: number, partnerCode: number, period: number, hsCode: string, flow: ComtradeFlow): URL {
    const key = apiKey();
    const url = new URL(key ? DATA_PATH : PREVIEW_PATH, API_ORIGIN);
    url.searchParams.set('reporterCode', String(reporterCode));
    url.searchParams.set('partnerCode', String(partnerCode));
    url.searchParams.set('period', String(period));
    url.searchParams.set('cmdCode', hsCode);
    url.searchParams.set('flowCode', flow);
    url.searchParams.set('motCode', '0');
    url.searchParams.set('customsCode', 'C00');
    if (key) url.searchParams.set('subscription-key', key);
    return url;
}

async function tradePoint(
    reporterCode: number,
    partnerCode: number,
    period: number,
    hsCode: string,
    flow: ComtradeFlow,
    countryContext: string,
): Promise<TradePointOutcome> {
    const context = { reporterCode, partnerCode, period, hsCode, flow, country: countryContext };
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        await waitForCallSlot();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        let res: Response;
        try {
            res = await fetch(tradeUrl(reporterCode, partnerCode, period, hsCode, flow), {
                headers: { Accept: 'application/json', 'User-Agent': 'tg-research-worker/1.0' },
                signal: controller.signal,
            });
        } catch (err) {
            log.warn({ ...context, attempt, err: errorMessage(err) }, 'comtrade data request failed');
            return { kind: 'failed' };
        } finally {
            clearTimeout(timer);
        }

        if (res.status === 429) {
            const body = await res.text().catch(() => '');
            const delayMs = rateLimitDelay(body);
            // Publish the server's body-only cooldown to every concurrent caller, not just this
            // loop, so an unrelated ranking cannot immediately spend another throttled request.
            nextCallAt = Math.max(nextCallAt, Date.now() + delayMs);
            log.warn({ ...context, attempt, delayMs }, 'comtrade rate limited');
            if (attempt < MAX_ATTEMPTS) {
                continue;
            }
            return { kind: 'failed' };
        }
        if (!res.ok) {
            log.warn({ ...context, attempt, status: res.status }, 'comtrade data response non-ok');
            return { kind: 'failed' };
        }

        let json: TradeResponse;
        try {
            json = (await res.json()) as TradeResponse;
        } catch (err) {
            log.warn({ ...context, attempt, err: errorMessage(err) }, 'comtrade data response was not JSON');
            return { kind: 'failed' };
        }
        const rows = Array.isArray(json.data)
            ? json.data.filter((row) => typeof row.primaryValue === 'number' && Number.isFinite(row.primaryValue))
            : [];
        if (rows.length === 0) return { kind: 'missing' };
        // motCode/customsCode still permits a duplicate distinguished only by partner2Code.
        // Values are identical; selecting one (never summing) prevents double-counting.
        const representative = rows.find((row) => row.partner2Code === 0) ?? rows[0];
        return { kind: 'value', value: representative.primaryValue as number };
    }
    return { kind: 'failed' };
}

function growth(current: number, prior: number | null): number | null {
    return prior === null || prior === 0 ? null : ((current - prior) / prior) * 100;
}

/** Build a bounded, descending world-import ranking over the curated major-economy shortlist. */
export async function getWorldImportRanking(config: WorldImportRankingConfig): Promise<WorldImportRankingResult> {
    const hsCode = normalizeHsCode(config.hsCode);
    const empty = (): WorldImportRankingResult => ({
        hsCode,
        year: config.year,
        priorYear: config.priorYear ?? null,
        ranked: [],
        failed: [],
    });
    if (!validYear(config.year) || (config.priorYear !== undefined && !validYear(config.priorYear))) {
        log.warn({ year: config.year, priorYear: config.priorYear }, 'comtrade ranking received invalid year');
        return empty();
    }
    if (!(await validateHsCode(hsCode))) {
        log.warn({ hsCode }, 'comtrade ranking rejected unverified HS code');
        return empty();
    }

    const ranked: Omit<WorldImportRankingEntry, 'rank'>[] = [];
    const failed: string[] = [];
    for (const iso2 of MAJOR_TRADING_ECONOMIES.slice(0, MAX_REPORTERS)) {
        const reporter = await resolveCountry(iso2, 'reporter');
        if (!reporter) {
            log.warn({ iso2 }, 'comtrade ranking reporter did not resolve; skipping');
            continue;
        }
        const current = await tradePoint(reporter.code, 0, config.year, hsCode, 'M', iso2);
        if (current.kind === 'failed') {
            failed.push(iso2);
            continue;
        }
        if (current.kind === 'missing') continue;

        let priorValue: number | null = null;
        if (config.priorYear !== undefined) {
            const prior = await tradePoint(reporter.code, 0, config.priorYear, hsCode, 'M', iso2);
            if (prior.kind === 'failed') {
                failed.push(iso2);
                continue;
            }
            if (prior.kind === 'value') priorValue = prior.value;
        }
        ranked.push({
            iso2,
            country: reporter.description,
            reporterCode: reporter.code,
            importValueUsd: current.value,
            priorYearImportValueUsd: priorValue,
            growthPct: growth(current.value, priorValue),
        });
    }

    ranked.sort((a, b) => b.importValueUsd - a.importValueUsd);
    return {
        hsCode,
        year: config.year,
        priorYear: config.priorYear ?? null,
        ranked: ranked.map((row, index) => ({ ...row, rank: index + 1 })),
        failed,
    };
}

/** Fetch one reporter-to-partner product flow; missing and failed points return null softly. */
export async function getBilateralTrade(config: BilateralTradeConfig): Promise<BilateralTradeResult | null> {
    const hsCode = normalizeHsCode(config.hsCode);
    const context = { reporter: config.reporter, partner: config.partner, hsCode, flow: config.flow };
    if (!validYear(config.year) || (config.priorYear !== undefined && !validYear(config.priorYear))) {
        log.warn({ ...context, year: config.year, priorYear: config.priorYear }, 'comtrade bilateral received invalid year');
        return null;
    }
    if (config.flow !== 'M' && config.flow !== 'X') {
        log.warn(context, 'comtrade bilateral received invalid flow');
        return null;
    }
    if (!(await validateHsCode(hsCode))) {
        log.warn(context, 'comtrade bilateral rejected unverified HS code');
        return null;
    }

    const [reporter, partner] = await Promise.all([
        resolveCountry(config.reporter, 'reporter'),
        resolveCountry(config.partner, 'partner'),
    ]);
    if (!reporter || !partner) {
        log.warn({ ...context, reporterResolved: !!reporter, partnerResolved: !!partner }, 'comtrade bilateral country resolution failed');
        return null;
    }

    let current = await tradePoint(reporter.code, partner.code, config.year, hsCode, config.flow, `${reporter.iso2}:${partner.iso2}`);
    let actualYear = config.year;
    if (current.kind === 'missing' && config.priorYear !== undefined) {
        log.info(
            { ...context, requestedYear: config.year, fallbackYear: config.priorYear },
            'comtrade bilateral current value missing; trying fallback year',
        );
        const fallback = await tradePoint(reporter.code, partner.code, config.priorYear, hsCode, config.flow, `${reporter.iso2}:${partner.iso2}`);
        if (fallback.kind === 'value') {
            current = fallback;
            actualYear = config.priorYear;
        } else {
            log.warn(
                { ...context, requestedYear: config.year, fallbackYear: config.priorYear, outcome: fallback.kind },
                'comtrade bilateral fallback value unavailable',
            );
            return null;
        }
    }
    if (current.kind !== 'value') {
        log.warn({ ...context, year: config.year, outcome: current.kind }, 'comtrade bilateral current value unavailable');
        return null;
    }

    let priorValue: number | null = null;
    if (actualYear === config.year && config.priorYear !== undefined) {
        const prior = await tradePoint(reporter.code, partner.code, config.priorYear, hsCode, config.flow, `${reporter.iso2}:${partner.iso2}`);
        if (prior.kind === 'failed') {
            log.warn({ ...context, priorYear: config.priorYear }, 'comtrade bilateral prior value failed');
            return null;
        }
        if (prior.kind === 'value') priorValue = prior.value;
        else log.warn({ ...context, priorYear: config.priorYear }, 'comtrade bilateral prior value missing');
    }

    return {
        hsCode,
        flow: config.flow,
        year: config.year,
        actualYear,
        priorYear: config.priorYear ?? null,
        reporter: reporter.description,
        reporterCode: reporter.code,
        partner: partner.description,
        partnerCode: partner.code,
        primaryValueUsd: current.value,
        priorPrimaryValueUsd: priorValue,
        growthPct: growth(current.value, priorValue),
    };
}
