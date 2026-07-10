/**
 * Domain Health Check — MX / SPF / DKIM / DMARC diagnostics for a connected
 * mailbox's sending domain.
 *
 * Pure DNS, no HTTP calls. Every check runs through a dedicated
 * `dns.promises.Resolver` (short timeout, few retries) so a slow/broken
 * nameserver degrades one check to `unknown` instead of hanging the request
 * or crashing the route. Results are cached in-memory per domain for a
 * short window since these are read repeatedly (settings panel) and DNS
 * records change rarely.
 */

import { Resolver } from 'node:dns/promises';
import { createLogger } from './logger.js';

const log = createLogger('lib:domainHealth');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'unknown';

export type MxProvider = 'm365' | 'google' | 'yandex' | 'zoho' | 'other' | 'none';

export interface DomainCheck {
    status: CheckStatus;
    found: string[] | string | null;
    suggested?: string;
    portalUrl?: string;
    notes: string[];
}

export interface DomainHealthResult {
    domain: string;
    managed: boolean;
    provider: MxProvider;
    checkedAt: string;
    checks: {
        mx: DomainCheck;
        spf: DomainCheck;
        dkim: DomainCheck;
        dmarc: DomainCheck;
    };
}

export interface ManagedDomainResult {
    domain: string;
    managed: true;
    provider: string;
    checkedAt: string;
}

// ---------------------------------------------------------------------------
// Consumer / managed domains — provider owns DNS, nothing for us to check.
// ---------------------------------------------------------------------------

const CONSUMER_DOMAINS: Record<string, string> = {
    'gmail.com': 'Google',
    'googlemail.com': 'Google',
    'outlook.com': 'Microsoft',
    'hotmail.com': 'Microsoft',
    'live.com': 'Microsoft',
    'msn.com': 'Microsoft',
    'passport.com': 'Microsoft',
    'outlook.com.tr': 'Microsoft',
    'outlook.co.uk': 'Microsoft',
    'outlook.de': 'Microsoft',
    'outlook.fr': 'Microsoft',
    'outlook.es': 'Microsoft',
    'outlook.it': 'Microsoft',
    'outlook.jp': 'Microsoft',
    'outlook.com.br': 'Microsoft',
    'outlook.com.ar': 'Microsoft',
    'outlook.co.id': 'Microsoft',
    'outlook.com.au': 'Microsoft',
    'hotmail.co.uk': 'Microsoft',
    'hotmail.fr': 'Microsoft',
    'hotmail.de': 'Microsoft',
    'hotmail.it': 'Microsoft',
    'hotmail.es': 'Microsoft',
    'hotmail.com.tr': 'Microsoft',
    'hotmail.co.jp': 'Microsoft',
    'hotmail.ca': 'Microsoft',
    'hotmail.com.br': 'Microsoft',
    'hotmail.com.ar': 'Microsoft',
    'hotmail.be': 'Microsoft',
    'hotmail.nl': 'Microsoft',
    'live.co.uk': 'Microsoft',
    'live.de': 'Microsoft',
    'live.fr': 'Microsoft',
    'live.com.mx': 'Microsoft',
    'live.com.ar': 'Microsoft',
    'live.it': 'Microsoft',
    'live.nl': 'Microsoft',
    'yandex.com': 'Yandex',
    'yandex.ru': 'Yandex',
    'yandex.by': 'Yandex',
    'yandex.kz': 'Yandex',
    'yandex.ua': 'Yandex',
    'yahoo.com': 'Yahoo',
    'yahoo.co.uk': 'Yahoo',
    'yahoo.de': 'Yahoo',
    'yahoo.fr': 'Yahoo',
    'yahoo.it': 'Yahoo',
    'yahoo.es': 'Yahoo',
    'yahoo.com.tr': 'Yahoo',
    'yahoo.co.jp': 'Yahoo',
    'ymail.com': 'Yahoo',
    'icloud.com': 'Apple',
    'me.com': 'Apple',
    'mac.com': 'Apple',
};

export function isManagedConsumerDomain(domain: string): boolean {
    return Object.prototype.hasOwnProperty.call(CONSUMER_DOMAINS, domain.toLowerCase());
}

function consumerProviderName(domain: string): string {
    return CONSUMER_DOMAINS[domain.toLowerCase()] ?? 'unknown';
}

/** Extract the registrable-ish domain part of an email address. Lowercased, trimmed. */
export function domainFromEmail(email: string): string {
    const domain = email.split('@')[1]?.toLowerCase().trim() ?? '';
    return domain;
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

function makeResolver(): Resolver {
    const resolver = new Resolver({ timeout: 4000, tries: 2 });
    return resolver;
}

/** Wrap a resolver call so DNS failures (NXDOMAIN, SERVFAIL, timeout) never throw. */
async function safeResolve<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
        return await fn();
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// MX check
// ---------------------------------------------------------------------------

interface MxRecord { exchange: string; priority: number }

function detectMxProvider(records: MxRecord[]): MxProvider {
    if (records.length === 0) return 'none';
    const hosts = records.map((r) => r.exchange.toLowerCase());
    if (hosts.some((h) => h.endsWith('.mail.protection.outlook.com'))) return 'm365';
    if (hosts.some((h) => h === 'aspmx.l.google.com' || h.endsWith('.googlemail.com') || h === 'smtp.google.com' || h.endsWith('.google.com'))) return 'google';
    if (hosts.some((h) => h === 'mx.yandex.net')) return 'yandex';
    if (hosts.some((h) => h.endsWith('.zoho.com') || h.endsWith('.zoho.eu'))) return 'zoho';
    return 'other';
}

async function checkMx(resolver: Resolver, domain: string): Promise<{ check: DomainCheck; provider: MxProvider }> {
    const records = await safeResolve(() => resolver.resolveMx(domain));
    if (records === null) {
        return {
            provider: 'other',
            check: { status: 'unknown', found: null, notes: ['mx_lookup_failed'] },
        };
    }
    const sorted = [...records].sort((a, b) => a.priority - b.priority);
    const provider = detectMxProvider(sorted);
    if (sorted.length === 0) {
        return { provider: 'none', check: { status: 'fail', found: [], notes: ['mx_none_found'] } };
    }
    return {
        provider,
        check: {
            status: 'pass',
            found: sorted.map((r) => `${r.priority} ${r.exchange}`),
            notes: provider === 'other' ? ['mx_provider_unrecognized'] : [],
        },
    };
}

// ---------------------------------------------------------------------------
// Deliverability MX check — liste doğrulama (emailValidator.ts) için
// ---------------------------------------------------------------------------
//
// Sağlık panelinin checkMx'inden ayrı, çünkü doğrulamanın ihtiyacı farklı:
//   1. A/AAAA fallback (RFC 5321 örtük MX) — MX yoksa alan A kaydına teslim
//      denenir; website-only alanlar "teslim edilebilir" sayılır.
//   2. Hata sınıflandırması — ENODATA/ENOTFOUND (kesin yok) ile
//      timeout/SERVFAIL/refused (geçici/belirsiz) ayrılır; belirsizde FAIL-OPEN.
//   3. Ayrı, uzun ömürlü cache — gönderim-anı tekrar kontrolleri ucuz olsun.
// makeResolver() paylaşılır (resolver ayarı tek yerde; kopya yok).

export type MxDeliverability = 'has_mx' | 'no_mx' | 'unknown';

// Bir DNS hata kodunun "kesin negatif" mi olduğunu ayırır. ENODATA = alan var ama
// o tip kayıt yok; ENOTFOUND = NXDOMAIN (alan hiç yok). Diğer her şey
// (ETIMEOUT, ESERVFAIL, EREFUSED, ...) belirsizdir → fail-open.
function isDefinitiveDnsMiss(code: unknown): boolean {
    return code === 'ENODATA' || code === 'ENOTFOUND';
}

interface MxDelivCacheEntry { result: MxDeliverability; expiresAt: number }
const MX_DELIV_CACHE_TTL_MS = 30 * 60 * 1000; // 30 dk — MX kayıtları seyrek değişir
const mxDelivCache = new Map<string, MxDelivCacheEntry>();

// MX yoksa A/AAAA'ya düş (örtük MX). Kayıt varsa 'has_mx'; kesin-yoksa 'no_mx';
// belirsiz hata → 'unknown' (fail-open).
async function mxAOrAaaaFallback(resolver: Resolver, domain: string): Promise<MxDeliverability> {
    try {
        const a = await resolver.resolve4(domain);
        if (a && a.length > 0) return 'has_mx';
    } catch (err) {
        if (!isDefinitiveDnsMiss((err as NodeJS.ErrnoException)?.code)) return 'unknown';
    }
    try {
        const aaaa = await resolver.resolve6(domain);
        if (aaaa && aaaa.length > 0) return 'has_mx';
    } catch (err) {
        if (!isDefinitiveDnsMiss((err as NodeJS.ErrnoException)?.code)) return 'unknown';
    }
    return 'no_mx';
}

/**
 * Bir alanın mail teslim-edilebilirliğini döner (cache'li). emailValidator.ts
 * bunu kullanır. 'no_mx' = kesin teslim edilemez (NXDOMAIN veya MX+A+AAAA yok);
 * 'has_mx' = teslim edilebilir; 'unknown' = DNS belirsiz (timeout/servfail) →
 * çağıran fail-open davranmalı (engelleme yok).
 */
export async function checkMxDeliverability(
    domain: string,
    opts: { refresh?: boolean } = {},
): Promise<MxDeliverability> {
    const normalized = domain.toLowerCase().trim();
    if (!normalized) return 'no_mx';

    if (!opts.refresh) {
        const cached = mxDelivCache.get(normalized);
        if (cached && cached.expiresAt > Date.now()) return cached.result;
    }

    const resolver = makeResolver();
    let result: MxDeliverability;
    try {
        const mx = await resolver.resolveMx(normalized);
        result = mx && mx.length > 0 ? 'has_mx' : await mxAOrAaaaFallback(resolver, normalized);
    } catch (err) {
        result = isDefinitiveDnsMiss((err as NodeJS.ErrnoException)?.code)
            ? await mxAOrAaaaFallback(resolver, normalized)
            : 'unknown'; // timeout/servfail/refused → fail-open
    }

    mxDelivCache.set(normalized, { result, expiresAt: Date.now() + MX_DELIV_CACHE_TTL_MS });
    return result;
}

// ---------------------------------------------------------------------------
// SPF check
// ---------------------------------------------------------------------------

const SPF_EXPECTED_INCLUDE: Record<Exclude<MxProvider, 'other' | 'none'>, string[]> = {
    m365: ['spf.protection.outlook.com'],
    google: ['_spf.google.com'],
    yandex: ['_spf.yandex.net'],
    zoho: ['zoho.eu', 'zoho.com'],
};

const SPF_SUGGESTED: Record<Exclude<MxProvider, 'other' | 'none'>, string> = {
    m365: 'v=spf1 include:spf.protection.outlook.com -all',
    google: 'v=spf1 include:_spf.google.com -all',
    yandex: 'v=spf1 include:_spf.yandex.net -all',
    zoho: 'v=spf1 include:zoho.eu -all',
};

function joinTxtRecord(chunks: string[]): string {
    return chunks.join('');
}

/**
 * Bounded recursive SPF lookup counter, per RFC 7208's 10-lookup limit.
 * Counts include/a/mx/ptr/exists/redirect mechanisms across the whole
 * evaluation tree. Caps at maxTotal queries / maxDepth recursion so a
 * malicious or misconfigured record can't cause unbounded DNS traffic.
 */
async function countSpfLookups(
    resolver: Resolver,
    domain: string,
    record: string,
    depth: number,
    state: { count: number; hitBound: boolean },
    maxDepth = 3,
    maxTotal = 15,
): Promise<void> {
    if (state.hitBound || depth > maxDepth) return;

    const mechanisms = record.split(/\s+/).filter(Boolean);
    for (const mech of mechanisms) {
        if (state.hitBound || state.count >= maxTotal) { state.hitBound = true; return; }

        const m = mech.replace(/^[+\-~?]/, '');
        if (m.startsWith('include:')) {
            state.count += 1;
            if (state.count >= maxTotal) { state.hitBound = true; return; }
            const target = m.slice('include:'.length);
            const nested = await lookupSpfRecord(resolver, target);
            if (nested) await countSpfLookups(resolver, target, nested, depth + 1, state, maxDepth, maxTotal);
        } else if (m.startsWith('redirect=')) {
            state.count += 1;
            if (state.count >= maxTotal) { state.hitBound = true; return; }
            const target = m.slice('redirect='.length);
            const nested = await lookupSpfRecord(resolver, target);
            if (nested) await countSpfLookups(resolver, target, nested, depth + 1, state, maxDepth, maxTotal);
        } else if (m === 'a' || m.startsWith('a:') || m.startsWith('a/')) {
            state.count += 1;
        } else if (m === 'mx' || m.startsWith('mx:') || m.startsWith('mx/')) {
            state.count += 1;
        } else if (m.startsWith('ptr') ) {
            state.count += 1;
        } else if (m.startsWith('exists:')) {
            state.count += 1;
        }
    }
}

async function lookupSpfRecord(resolver: Resolver, domain: string): Promise<string | null> {
    const txt = await safeResolve(() => resolver.resolveTxt(domain));
    if (!txt) return null;
    const spfRecords = txt.map(joinTxtRecord).filter((r) => /^v=spf1\b/i.test(r.trim()));
    return spfRecords[0] ?? null;
}

async function checkSpf(resolver: Resolver, domain: string, mxProvider: MxProvider): Promise<DomainCheck> {
    const txt = await safeResolve(() => resolver.resolveTxt(domain));
    if (txt === null) {
        return { status: 'unknown', found: null, notes: ['spf_lookup_failed'] };
    }

    const allTxt = txt.map(joinTxtRecord);
    const spfRecords = allTxt.filter((r) => /^v=spf1\b/i.test(r.trim()));

    const notes: string[] = [];
    const suggested = mxProvider !== 'other' && mxProvider !== 'none'
        ? SPF_SUGGESTED[mxProvider as Exclude<MxProvider, 'other' | 'none'>]
        : 'v=spf1 -all';

    if (spfRecords.length === 0) {
        return { status: 'fail', found: null, suggested, notes: ['spf_missing'] };
    }
    if (spfRecords.length > 1) {
        notes.push('spf_multiple_records');
        return { status: 'fail', found: spfRecords, suggested, notes };
    }

    const record = spfRecords[0].trim();

    if (/\+all\b/.test(record)) {
        notes.push('spf_allows_all');
        return { status: 'fail', found: record, suggested, notes };
    }

    const hasHardFail = /-all\b/.test(record);
    const hasSoftFail = /~all\b/.test(record);
    const hasNeutral = /\?all\b/.test(record);

    if (!hasHardFail && !hasSoftFail && !hasNeutral) {
        notes.push('spf_no_all_mechanism');
    } else if (hasNeutral) {
        notes.push('spf_neutral_all');
    } else if (hasSoftFail) {
        notes.push('spf_no_hard_fail');
    }

    // Bounded lookup count
    const state = { count: 0, hitBound: false };
    await countSpfLookups(resolver, domain, record, 0, state);
    const lookupCountText = state.hitBound ? `>= ${state.count}` : String(state.count);
    if (state.count > 10) {
        notes.push('spf_too_many_lookups');
    }

    // Expected include for detected MX provider
    if (mxProvider !== 'other' && mxProvider !== 'none') {
        const expected = SPF_EXPECTED_INCLUDE[mxProvider as Exclude<MxProvider, 'other' | 'none'>];
        const hasExpected = expected.some((inc) => record.toLowerCase().includes(inc.toLowerCase()));
        if (!hasExpected) {
            notes.push('spf_missing_provider_include');
        }
    }

    let status: CheckStatus = 'pass';
    if (notes.includes('spf_missing_provider_include') || notes.includes('spf_no_hard_fail') ||
        notes.includes('spf_too_many_lookups') || notes.includes('spf_neutral_all') || notes.includes('spf_no_all_mechanism')) {
        status = 'warn';
    }

    return {
        status,
        found: `${record} (lookups: ${lookupCountText})`,
        suggested: status !== 'pass' ? suggested : undefined,
        notes,
    };
}

// ---------------------------------------------------------------------------
// DKIM check — provider-aware
// ---------------------------------------------------------------------------

const COMMON_DKIM_SELECTORS = ['default', 'mail', 'smtp', 'dkim', 'k1', 's1', 's2', 'selector1', 'selector2'];

async function checkDkimM365(resolver: Resolver, domain: string): Promise<DomainCheck> {
    const dashDomain = domain.replace(/\./g, '-');
    const [sel1, sel2] = await Promise.all([
        safeResolve(() => resolver.resolveCname(`selector1._domainkey.${domain}`)),
        safeResolve(() => resolver.resolveCname(`selector2._domainkey.${domain}`)),
    ]);
    const found: string[] = [];
    if (sel1?.length) found.push(`selector1._domainkey → ${sel1[0]}`);
    if (sel2?.length) found.push(`selector2._domainkey → ${sel2[0]}`);

    const notes: string[] = [];
    if (!sel1?.length && !sel2?.length) notes.push('dkim_none_found');
    else if (!sel2?.length) notes.push('dkim_selector2_missing');

    return {
        status: sel1?.length ? 'pass' : 'fail',
        found: found.length ? found : null,
        suggested: !sel1?.length
            ? `selector1._domainkey CNAME → selector1-${dashDomain}._domainkey.<your-tenant>.onmicrosoft.com`
            : undefined,
        portalUrl: !sel1?.length ? 'https://security.microsoft.com/authentication?viewid=DKIM' : undefined,
        notes,
    };
}

async function checkDkimTxtSelector(
    resolver: Resolver,
    selectorDomain: string,
    notFoundNote: string,
    portalUrl?: string,
): Promise<DomainCheck> {
    const txt = await safeResolve(() => resolver.resolveTxt(selectorDomain));
    if (txt === null) {
        return { status: 'unknown', found: null, notes: ['dkim_lookup_failed'], portalUrl };
    }
    const joined = txt.map(joinTxtRecord);
    const dkimRecord = joined.find((r) => /v=dkim1/i.test(r));
    if (!dkimRecord) {
        return { status: 'fail', found: null, notes: [notFoundNote], portalUrl };
    }
    return { status: 'pass', found: dkimRecord, notes: [] };
}

async function checkDkimZoho(resolver: Resolver, domain: string): Promise<DomainCheck> {
    const selectors = ['zoho._domainkey', 'zmail._domainkey'];
    for (const sel of selectors) {
        const txt = await safeResolve(() => resolver.resolveTxt(`${sel}.${domain}`));
        if (txt) {
            const joined = txt.map(joinTxtRecord);
            const dkimRecord = joined.find((r) => /v=dkim1/i.test(r));
            if (dkimRecord) {
                return { status: 'pass', found: `${sel} → ${dkimRecord}`, notes: [] };
            }
        }
    }
    return { status: 'fail', found: null, notes: ['dkim_none_found'] };
}

async function checkDkimGeneric(resolver: Resolver, domain: string): Promise<DomainCheck> {
    for (const selector of COMMON_DKIM_SELECTORS) {
        const selectorDomain = `${selector}._domainkey.${domain}`;
        const [txt, cname] = await Promise.all([
            safeResolve(() => resolver.resolveTxt(selectorDomain)),
            safeResolve(() => resolver.resolveCname(selectorDomain)),
        ]);
        if (txt) {
            const joined = txt.map(joinTxtRecord);
            const dkimRecord = joined.find((r) => /v=dkim1/i.test(r)) ?? joined[0];
            if (dkimRecord) {
                return { status: 'pass', found: `${selector} (TXT) → ${dkimRecord}`, notes: ['dkim_selector_found'] };
            }
        }
        if (cname?.length) {
            return { status: 'pass', found: `${selector} (CNAME) → ${cname[0]}`, notes: ['dkim_selector_found'] };
        }
    }
    return { status: 'unknown', found: null, notes: ['dkim_selector_unknown'] };
}

async function checkDkim(resolver: Resolver, domain: string, provider: MxProvider): Promise<DomainCheck> {
    switch (provider) {
        case 'm365':
            return checkDkimM365(resolver, domain);
        case 'google':
            return checkDkimTxtSelector(
                resolver, `google._domainkey.${domain}`, 'dkim_none_found',
                'https://admin.google.com/ac/apps/gmail/authenticateemail',
            );
        case 'yandex':
            return checkDkimTxtSelector(resolver, `mail._domainkey.${domain}`, 'dkim_none_found');
        case 'zoho':
            return checkDkimZoho(resolver, domain);
        case 'other':
        case 'none':
        default:
            return checkDkimGeneric(resolver, domain);
    }
}

// ---------------------------------------------------------------------------
// DMARC check
// ---------------------------------------------------------------------------

async function checkDmarc(resolver: Resolver, domain: string): Promise<DomainCheck> {
    const txt = await safeResolve(() => resolver.resolveTxt(`_dmarc.${domain}`));
    if (txt === null) {
        return { status: 'unknown', found: null, notes: ['dmarc_lookup_failed'] };
    }
    const joined = txt.map(joinTxtRecord);
    const dmarcRecord = joined.find((r) => /^v=dmarc1/i.test(r.trim()));

    const suggested = `v=DMARC1; p=none; rua=mailto:dmarc@${domain}`;

    if (!dmarcRecord) {
        return { status: 'fail', found: null, suggested, notes: ['dmarc_missing'] };
    }

    const pMatch = /p=(\w+)/i.exec(dmarcRecord);
    const policy = pMatch?.[1]?.toLowerCase() ?? null;
    const hasRua = /rua=/i.test(dmarcRecord);

    const notes: string[] = [];
    if (!hasRua) notes.push('dmarc_no_rua');

    let status: CheckStatus = 'pass';
    if (policy === 'none') {
        status = 'warn';
        notes.push('dmarc_policy_none');
    } else if (policy === 'quarantine' || policy === 'reject') {
        status = 'pass';
    } else {
        status = 'warn';
        notes.push('dmarc_policy_unknown');
    }

    return {
        status,
        found: dmarcRecord,
        suggested: status !== 'pass' ? suggested : undefined,
        notes,
    };
}

// ---------------------------------------------------------------------------
// Public entry point + cache
// ---------------------------------------------------------------------------

interface CacheEntry { result: DomainHealthResult; expiresAt: number }
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

export async function getDomainHealth(
    domain: string,
    opts: { refresh?: boolean } = {},
): Promise<DomainHealthResult> {
    const normalized = domain.toLowerCase().trim();

    if (!opts.refresh) {
        const cached = cache.get(normalized);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.result;
        }
    }

    const resolver = makeResolver();

    const [mxSettled, dmarcSettled] = await Promise.allSettled([
        checkMx(resolver, normalized),
        checkDmarc(resolver, normalized),
    ]);

    const mxOutcome = mxSettled.status === 'fulfilled'
        ? mxSettled.value
        : { provider: 'other' as MxProvider, check: { status: 'unknown' as CheckStatus, found: null, notes: ['mx_lookup_failed'] } };

    if (mxSettled.status === 'rejected') {
        log.warn({ domain: normalized, err: mxSettled.reason }, 'MX check threw unexpectedly');
    }

    const dmarcCheck: DomainCheck = dmarcSettled.status === 'fulfilled'
        ? dmarcSettled.value
        : { status: 'unknown', found: null, notes: ['dmarc_lookup_failed'] };

    if (dmarcSettled.status === 'rejected') {
        log.warn({ domain: normalized, err: dmarcSettled.reason }, 'DMARC check threw unexpectedly');
    }

    // SPF and DKIM depend on the detected MX provider, so run them after MX resolves
    // (still in parallel with each other).
    const [spfSettled, dkimSettled] = await Promise.allSettled([
        checkSpf(resolver, normalized, mxOutcome.provider),
        checkDkim(resolver, normalized, mxOutcome.provider),
    ]);

    const spfCheck: DomainCheck = spfSettled.status === 'fulfilled'
        ? spfSettled.value
        : { status: 'unknown', found: null, notes: ['spf_lookup_failed'] };
    if (spfSettled.status === 'rejected') {
        log.warn({ domain: normalized, err: spfSettled.reason }, 'SPF check threw unexpectedly');
    }

    const dkimCheck: DomainCheck = dkimSettled.status === 'fulfilled'
        ? dkimSettled.value
        : { status: 'unknown', found: null, notes: ['dkim_lookup_failed'] };
    if (dkimSettled.status === 'rejected') {
        log.warn({ domain: normalized, err: dkimSettled.reason }, 'DKIM check threw unexpectedly');
    }

    const result: DomainHealthResult = {
        domain: normalized,
        managed: false,
        provider: mxOutcome.provider,
        checkedAt: new Date().toISOString(),
        checks: {
            mx: mxOutcome.check,
            spf: spfCheck,
            dkim: dkimCheck,
            dmarc: dmarcCheck,
        },
    };

    cache.set(normalized, { result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
}

export function getManagedDomainResult(domain: string): ManagedDomainResult {
    return {
        domain: domain.toLowerCase().trim(),
        managed: true,
        provider: consumerProviderName(domain),
        checkedAt: new Date().toISOString(),
    };
}
