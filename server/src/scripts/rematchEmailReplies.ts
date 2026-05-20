#!/usr/bin/env tsx
/**
 * One-off backfill: re-evaluate every email_replies row with the v2 layered matcher
 * and upgrade weaker matches to stronger ones.
 *
 * Usage:
 *   npx tsx src/scripts/rematchEmailReplies.ts                  # all tenants, apply changes
 *   npx tsx src/scripts/rematchEmailReplies.ts --dry-run        # report only, no writes
 *   npx tsx src/scripts/rematchEmailReplies.ts --tenant=<uuid>  # single tenant
 *
 * Decision rule (per row):
 *   - newRank < oldRank      → UPDATE (stronger layer matched)
 *   - newRank >= oldRank     → SKIP   (preserve existing match)
 *   - oldMatchMethod == NULL → treat as fuzzy_substring rank (7), so any exact layer wins
 *   - oldMatchMethod == 'manual' (rank 0) → NEVER overwritten
 *
 * Idempotent: re-runs only update rows whose stored match is still weaker than what
 * the matcher now produces.
 */
import { supabaseAdmin } from '../lib/supabase.js';
import {
    matchSenderEmail,
    clearCompanyCache,
    MATCH_METHOD_RANK,
    LEGACY_RANK,
    type MatchMethod,
    type MatchResult,
} from '../lib/emailMatcher.js';

interface Args {
    dryRun: boolean;
    tenantId: string | null;
}

function parseArgs(): Args {
    const args: Args = { dryRun: false, tenantId: null };
    for (const a of process.argv.slice(2)) {
        if (a === '--dry-run') args.dryRun = true;
        else if (a.startsWith('--tenant=')) args.tenantId = a.slice('--tenant='.length);
        else if (a === '-h' || a === '--help') {
            console.log(`Usage: tsx src/scripts/rematchEmailReplies.ts [--dry-run] [--tenant=<uuid>]`);
            process.exit(0);
        } else {
            console.error(`Unknown argument: ${a}`);
            process.exit(1);
        }
    }
    return args;
}

function getEffectiveRank(method: MatchMethod | null): number {
    if (method === null) return LEGACY_RANK;
    return MATCH_METHOD_RANK[method] ?? LEGACY_RANK;
}

interface ReplyRow {
    id: string;
    tenant_id: string;
    sender_email: string;
    company_id: string | null;
    contact_id: string | null;
    match_status: string;
    match_method: MatchMethod | null;
    raw_payload: Record<string, unknown> | null;
}

interface SenderGroup {
    senderEmail: string;
    hints: { company_name?: string | null; company_website?: string | null };
    rows: ReplyRow[];
}

async function fetchTenants(filter: string | null): Promise<{ id: string; slug: string | null }[]> {
    if (filter) {
        const { data, error } = await supabaseAdmin
            .from('tenants').select('id, slug').eq('id', filter).limit(1);
        if (error) throw new Error(`Tenant fetch failed: ${error.message}`);
        return data || [];
    }
    const { data, error } = await supabaseAdmin
        .from('tenants').select('id, slug').order('created_at', { ascending: true });
    if (error) throw new Error(`Tenant list failed: ${error.message}`);
    return data || [];
}

async function fetchReplies(tenantId: string): Promise<ReplyRow[]> {
    const PAGE = 1000;
    const all: ReplyRow[] = [];
    let from = 0;
    while (true) {
        const { data, error } = await supabaseAdmin
            .from('email_replies')
            .select('id, tenant_id, sender_email, company_id, contact_id, match_status, match_method, raw_payload')
            .eq('tenant_id', tenantId)
            .order('id', { ascending: true })
            .range(from, from + PAGE - 1);
        if (error) throw new Error(`Replies fetch failed: ${error.message}`);
        if (!data || data.length === 0) break;
        all.push(...(data as ReplyRow[]));
        if (data.length < PAGE) break;
        from += PAGE;
    }
    return all;
}

/** Group rows by sender; pick representative hints (the first row that has them). */
function groupBySender(rows: ReplyRow[]): SenderGroup[] {
    const map = new Map<string, SenderGroup>();
    for (const r of rows) {
        const key = r.sender_email.toLowerCase().trim();
        let g = map.get(key);
        if (!g) {
            g = { senderEmail: key, hints: {}, rows: [] };
            map.set(key, g);
        }
        g.rows.push(r);
        if (!g.hints.company_name || !g.hints.company_website) {
            const p = r.raw_payload || {};
            if (!g.hints.company_name && typeof p.company_name === 'string') g.hints.company_name = p.company_name;
            if (!g.hints.company_website && typeof p.company_website === 'string') g.hints.company_website = p.company_website;
        }
    }
    return [...map.values()];
}

interface Stats {
    senders: number;
    rowsScanned: number;
    rowsUpgraded: number;
    rowsCompanyChanged: number;
    rowsContactSet: number;
    rowsSkippedManual: number;
    rowsSkippedSameOrWeaker: number;
    rowsSkippedNoChange: number;
    matchErrors: number;
}

async function buildCompanyNameMap(tenantId: string): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const PAGE = 1000;
    let from = 0;
    while (true) {
        const { data, error } = await supabaseAdmin
            .from('companies')
            .select('id, name')
            .eq('tenant_id', tenantId)
            .range(from, from + PAGE - 1);
        if (error || !data || data.length === 0) break;
        for (const r of data) map.set(r.id, r.name || '(no name)');
        if (data.length < PAGE) break;
        from += PAGE;
    }
    return map;
}

async function processTenant(tenant: { id: string; slug: string | null }, dryRun: boolean): Promise<Stats> {
    const stats: Stats = {
        senders: 0, rowsScanned: 0, rowsUpgraded: 0, rowsCompanyChanged: 0,
        rowsContactSet: 0, rowsSkippedManual: 0, rowsSkippedSameOrWeaker: 0,
        rowsSkippedNoChange: 0, matchErrors: 0,
    };

    const rows = await fetchReplies(tenant.id);
    if (rows.length === 0) return stats;
    stats.rowsScanned = rows.length;

    // Clear cache so the new matcher reads fresh company data for this tenant
    clearCompanyCache(tenant.id);

    const nameMap = await buildCompanyNameMap(tenant.id);
    const nameOf = (id: string | null) => (id ? (nameMap.get(id) ?? id.slice(0, 8)) : '∅');

    const groups = groupBySender(rows);
    stats.senders = groups.length;

    for (const g of groups) {
        let result: MatchResult;
        try {
            result = await matchSenderEmail(g.senderEmail, tenant.id, g.hints);
        } catch (err) {
            console.error(`  match error for ${g.senderEmail}:`, (err as Error).message);
            stats.matchErrors += g.rows.length;
            continue;
        }

        const newRank = MATCH_METHOD_RANK[result.match_method];

        for (const row of g.rows) {
            const oldRank = getEffectiveRank(row.match_method);

            // Never touch manual assignments
            if (row.match_method === 'manual') {
                stats.rowsSkippedManual++;
                continue;
            }

            // Only upgrade — never replace with equal or weaker match
            if (newRank >= oldRank) {
                stats.rowsSkippedSameOrWeaker++;
                continue;
            }

            // If the new match wouldn't actually change anything, skip
            const wouldChange =
                row.company_id !== result.company_id ||
                row.contact_id !== result.contact_id ||
                row.match_status !== result.match_status ||
                row.match_method !== result.match_method;
            if (!wouldChange) {
                stats.rowsSkippedNoChange++;
                continue;
            }

            if (row.company_id !== result.company_id) stats.rowsCompanyChanged++;
            if (result.contact_id && row.contact_id !== result.contact_id) stats.rowsContactSet++;

            console.log(
                `  [${tenant.slug ?? tenant.id.slice(0, 8)}] ${g.senderEmail}` +
                ` :: ${row.match_method ?? 'NULL'}(r${oldRank}) → ${result.match_method}(r${newRank})` +
                (row.company_id !== result.company_id
                    ? ` | company "${nameOf(row.company_id)}" → "${nameOf(result.company_id)}"`
                    : ''),
            );

            stats.rowsUpgraded++;

            if (!dryRun) {
                const { error: updErr } = await supabaseAdmin
                    .from('email_replies')
                    .update({
                        company_id: result.company_id,
                        contact_id: result.contact_id,
                        match_status: result.match_status,
                        match_method: result.match_method,
                    })
                    .eq('id', row.id);
                if (updErr) {
                    console.error(`  UPDATE failed for ${row.id}:`, updErr.message);
                    stats.matchErrors++;
                }
            }
        }
    }
    return stats;
}

function fmtStats(s: Stats): string {
    return [
        `scanned=${s.rowsScanned}`,
        `senders=${s.senders}`,
        `upgraded=${s.rowsUpgraded}`,
        `company_changed=${s.rowsCompanyChanged}`,
        `contact_set=${s.rowsContactSet}`,
        `skipped_manual=${s.rowsSkippedManual}`,
        `skipped_same_or_weaker=${s.rowsSkippedSameOrWeaker}`,
        `skipped_no_change=${s.rowsSkippedNoChange}`,
        `errors=${s.matchErrors}`,
    ].join(' ');
}

async function main() {
    const args = parseArgs();
    console.log(`rematch-email-replies — dryRun=${args.dryRun} tenant=${args.tenantId ?? 'ALL'}`);

    const tenants = await fetchTenants(args.tenantId);
    if (tenants.length === 0) {
        console.log('No tenants matched. Nothing to do.');
        return;
    }

    const totals: Stats = {
        senders: 0, rowsScanned: 0, rowsUpgraded: 0, rowsCompanyChanged: 0,
        rowsContactSet: 0, rowsSkippedManual: 0, rowsSkippedSameOrWeaker: 0,
        rowsSkippedNoChange: 0, matchErrors: 0,
    };

    for (const t of tenants) {
        console.log(`\n── tenant ${t.slug ?? t.id} ─────────────────────────`);
        const s = await processTenant(t, args.dryRun);
        console.log(`  → ${fmtStats(s)}`);
        for (const k of Object.keys(totals) as (keyof Stats)[]) {
            totals[k] += s[k];
        }
    }

    console.log(`\n════ totals ════════════════════════════════════`);
    console.log(fmtStats(totals));
    if (args.dryRun) console.log('(DRY-RUN: no rows were updated)');
}

main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
});
