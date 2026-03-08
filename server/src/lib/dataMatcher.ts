/**
 * Data Matcher — Matches people to companies from two separate files
 * Strategy: ID/Key column matching → Website domain matching → None
 */

import { sanitizeCell } from './importMapper.js';

// --- Types ---

export interface MatchStrategy {
    type: 'id_key' | 'website' | 'none';
    companyCol: string;
    peopleCol: string;
}

export interface MatchResult {
    mergedRows: Record<string, string>[];
    mergedHeaders: string[];
    matchedCount: number;
    unmatchedPeople: Record<string, string>[];
    strategy: MatchStrategy;
    totalCompanyRows: number;
    totalPeopleRows: number;
}

// --- Strategy Detection ---

// Substring match — any header containing these strings is a website column
const WEBSITE_SUBSTRINGS = ['website', 'web sitesi', 'web site'];
// Exact match — only these exact (normalized) values count as website columns
const WEBSITE_EXACT = ['web', 'url', 'site', 'domain'];

/**
 * Detect matching strategy by scanning headers for ID/Key or Website columns
 */
export function detectMatchStrategy(
    companyHeaders: string[],
    peopleHeaders: string[],
): MatchStrategy {
    const normalize = (s: string) => s.toLowerCase().trim().replace(/[_\-\.]/g, ' ');

    const isWebsiteCol = (h: string) => {
        const n = normalize(h);
        return WEBSITE_SUBSTRINGS.some((kw) => n.includes(kw)) || WEBSITE_EXACT.some((alias) => n === alias);
    };

    // 1. Look for website columns first (priority)
    const companyWebCol = companyHeaders.find(isWebsiteCol);
    const peopleWebCol = peopleHeaders.find(isWebsiteCol);

    if (companyWebCol && peopleWebCol) {
        return { type: 'website', companyCol: companyWebCol, peopleCol: peopleWebCol };
    }

    // 2. Fallback: look for ID/Key columns in both files
    const idKeyPattern = /\b(id|key)\b/i;

    const companyIdCol = companyHeaders.find((h) => idKeyPattern.test(h));
    const peopleIdCol = peopleHeaders.find((h) => idKeyPattern.test(h));

    if (companyIdCol && peopleIdCol) {
        return { type: 'id_key', companyCol: companyIdCol, peopleCol: peopleIdCol };
    }

    return { type: 'none', companyCol: '', peopleCol: '' };
}

/**
 * Clean a website URL for comparison: remove protocol, www., trailing slash, lowercase
 */
export function cleanWebsite(raw: string): string {
    if (!raw) return '';
    return raw
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '')
        .replace(/\/+$/, '');
}

// --- File Matching ---

/**
 * Resolve header collisions between two files by prefixing duplicates
 */
function resolveHeaders(
    companyHeaders: string[],
    peopleHeaders: string[],
    strategy: MatchStrategy,
): { mergedHeaders: string[]; companyMap: Record<string, string>; peopleMap: Record<string, string> } {
    const companySet = new Set(companyHeaders.map((h) => h.toLowerCase()));
    const companyMap: Record<string, string> = {};
    const peopleMap: Record<string, string> = {};

    // Map company headers (keep original names unless collision)
    for (const h of companyHeaders) {
        companyMap[h] = h;
    }

    // Map people headers — prefix if collision
    for (const h of peopleHeaders) {
        // Skip the matching key column from people file (already represented via company)
        if (h === strategy.peopleCol) {
            peopleMap[h] = h; // keep for lookup but won't add to merged headers
            continue;
        }
        if (companySet.has(h.toLowerCase())) {
            peopleMap[h] = `people_${h}`;
        } else {
            peopleMap[h] = h;
        }
    }

    // Build merged header list: all company headers + non-duplicate people headers (excluding match key)
    const mergedHeaders = [
        ...companyHeaders,
        ...peopleHeaders
            .filter((h) => h !== strategy.peopleCol)
            .map((h) => peopleMap[h]),
    ];

    return { mergedHeaders, companyMap, peopleMap };
}

/**
 * Match people rows to company rows and produce merged flat rows
 */
export function matchFiles(
    companyHeaders: string[],
    companyRows: Record<string, string>[],
    peopleHeaders: string[],
    peopleRows: Record<string, string>[],
    strategy: MatchStrategy,
): MatchResult {
    if (strategy.type === 'none') {
        return {
            mergedRows: [],
            mergedHeaders: [],
            matchedCount: 0,
            unmatchedPeople: peopleRows,
            strategy,
            totalCompanyRows: companyRows.length,
            totalPeopleRows: peopleRows.length,
        };
    }

    const { mergedHeaders, companyMap, peopleMap } = resolveHeaders(companyHeaders, peopleHeaders, strategy);
    const isWebsite = strategy.type === 'website';

    // Build company lookup: matchKey → company row(s)
    // Use Map to preserve first occurrence for dedup
    const companyLookup = new Map<string, Record<string, string>>();
    for (const row of companyRows) {
        let key = sanitizeCell(row[strategy.companyCol] || '');
        if (isWebsite) key = cleanWebsite(key);
        if (key) {
            // First company wins (dedup)
            if (!companyLookup.has(key)) {
                companyLookup.set(key, row);
            }
        }
    }

    // Group people by match key
    const peopleByKey = new Map<string, Record<string, string>[]>();
    const unmatchedPeople: Record<string, string>[] = [];

    for (const row of peopleRows) {
        let key = sanitizeCell(row[strategy.peopleCol] || '');
        if (isWebsite) key = cleanWebsite(key);

        if (key && companyLookup.has(key)) {
            if (!peopleByKey.has(key)) {
                peopleByKey.set(key, []);
            }
            peopleByKey.get(key)!.push(row);
        } else {
            unmatchedPeople.push(row);
        }
    }

    const matchedCount = peopleRows.length - unmatchedPeople.length;

    // Build merged rows
    const mergedRows: Record<string, string>[] = [];

    // Helper to create a merged flat row
    const mergeRow = (companyRow: Record<string, string>, peopleRow?: Record<string, string>): Record<string, string> => {
        const merged: Record<string, string> = {};

        // Add company fields
        for (const h of companyHeaders) {
            merged[companyMap[h]] = companyRow[h] || '';
        }

        // Add people fields (if present)
        for (const h of peopleHeaders) {
            if (h === strategy.peopleCol) continue; // skip match key
            const mergedKey = peopleMap[h];
            merged[mergedKey] = peopleRow ? (peopleRow[h] || '') : '';
        }

        return merged;
    };

    // Process all companies
    for (const companyRow of companyRows) {
        let key = sanitizeCell(companyRow[strategy.companyCol] || '');
        if (isWebsite) key = cleanWebsite(key);

        const matchedPeople = key ? peopleByKey.get(key) : undefined;

        if (matchedPeople && matchedPeople.length > 0) {
            // One row per person matched to this company
            for (const personRow of matchedPeople) {
                mergedRows.push(mergeRow(companyRow, personRow));
            }
        } else {
            // Company without matched people — still include
            mergedRows.push(mergeRow(companyRow));
        }
    }

    return {
        mergedRows,
        mergedHeaders,
        matchedCount,
        unmatchedPeople,
        strategy,
        totalCompanyRows: companyRows.length,
        totalPeopleRows: peopleRows.length,
    };
}
