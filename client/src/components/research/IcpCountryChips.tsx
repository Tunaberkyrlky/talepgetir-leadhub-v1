/**
 * IcpCountryChips — WP8a wizard step 8's "which countries does this sub-ICP target" control.
 * Shows the ICP's already-added geography cells as status-colored chips; each non-rejected chip
 * now carries a remove affordance (soft-reject via POST /research/geographies/:id/reject, which
 * flips status to 'rejected' — the cell stops scoping new harvests but keeps any companies
 * already found), and a small add-country form that mirrors
 * GeographiesPanel's own (create-or-reuse via POST /research/geographies, which also
 * auto-enqueues geo:analyze — the wizard's step 9 picks up any cell still missing a spec).
 * No AI-suggested countries here: the ICP schema doesn't carry them, and icp:generate's
 * output is untouched by this WP — this is customer-driven add only.
 */
import { useEffect, useState, type CSSProperties } from 'react';
import { Badge, Button, CloseButton, Group, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { useReducedMotion } from '@mantine/hooks';
import { IconSparkles, IconWorldPin } from '@tabler/icons-react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showError, showErrorFromApi, showWarning } from '../../lib/notifications';

interface GeoCellSummary {
    id: string;
    country: string;
    status: 'draft' | 'approved' | 'rejected';
    spec: unknown;
}

// Duplicated, not shared (react-refresh wants component-only exports — same convention as
// GeographiesPanel.tsx's own copy of this map).
const STATUS_COLOR: Record<GeoCellSummary['status'], string> = {
    draft: 'gray',
    approved: 'green',
    rejected: 'red',
};

function httpInfo(err: unknown) {
    const resp = (err as { response?: { status?: number; data?: { job_id?: string } } }).response;
    return { status: resp?.status, jobId: resp?.data?.job_id };
}

function formatUsdCompact(n: number): string {
    return new Intl.NumberFormat('en-US', {
        notation: 'compact', style: 'currency', currency: 'USD', maximumFractionDigits: 1,
    }).format(n);
}

interface MarketEvidenceRow {
    country: string;
    import_value: number;
    rank: number | null;
    kind: 'world_import' | 'bilateral_export';
}

export default function IcpCountryChips({ icpId }: { icpId: string }) {
    const { t } = useTranslation();
    const qc = useQueryClient();
    const [country, setCountry] = useState('');
    const reduceMotion = useReducedMotion();

    // Drives ONLY the per-chip stagger below (each already-added country chip settles in
    // left-to-right once cells are known) — NOT a container-level mount fade. WizardShell
    // already animates each step's content swap (fade+slide) at the shell level, so a second
    // local entrance on this whole Stack double-stacked the animation (step 8).
    const [entered, setEntered] = useState(reduceMotion ?? false);
    useEffect(() => {
        if (reduceMotion) return;
        const frame = requestAnimationFrame(() => setEntered(true));
        return () => cancelAnimationFrame(frame);
    }, [reduceMotion]);

    const cellsQuery = useQuery<{ data: GeoCellSummary[] }>({
        queryKey: ['research', 'geographies', icpId],
        queryFn: async () => (await api.get(`/research/geographies?icp_id=${icpId}`)).data,
    });
    const cells = cellsQuery.data?.data ?? [];

    // Per-cell evidence (WP11) — each geography's own /markets route resolves the reporter/
    // partner country name and approved-HS filtering server-side (loadMarketEvidenceForGeoCountry),
    // so this must query per cell.id rather than the raw project-wide route: a naive string match
    // against the customer-typed country label can silently miss rows keyed under Comtrade's
    // canonical reference name.
    const marketQueries = useQueries({
        queries: cells.map((c) => ({
            queryKey: ['research', 'geo-markets', c.id],
            queryFn: async () => (await api.get(`/research/geographies/${c.id}/markets`)).data as { data: MarketEvidenceRow[] },
        })),
    });

    const addMut = useMutation({
        mutationFn: async () =>
            (await api.post('/research/geographies', { icp_id: icpId, country: country.trim() })).data as {
                geography: GeoCellSummary;
                job: { id: string } | null;
                reused?: boolean;
            },
        onSuccess: (resp) => {
            setCountry('');
            qc.invalidateQueries({ queryKey: ['research', 'geographies', icpId] });
            // Deliberate correctness fix, not a style change: POST /research/geographies only
            // ever omits `job` in lockstep with `reused: true` (see the route's `geography.spec
            // != null` branch — every other branch always returns a job), so the previous
            // `!resp.job && !resp.reused` guard could never be true and this warning never
            // actually fired. `resp.reused` alone is the real "already added and analyzed"
            // signal the route promises.
            if (resp.reused) {
                // Reused-with-existing-spec case — geo:analyze deliberately did NOT re-fire
                // (same "never silently overwrite an analyzed cell" rule as GeographiesPanel).
                showWarning(t('research.wizard.step8.reusedExisting', 'This country was already added and analyzed.'));
            }
        },
        onError: (err: unknown) => {
            const { status } = httpInfo(err);
            if (status === 402) {
                showError(t('research.geographies.noCredits', 'You do not have research credits — top up before analyzing geographies.'));
                return;
            }
            showErrorFromApi(err);
        },
    });

    // Soft-reject a chip: flips the cell to 'rejected' (kept, red, non-removable) — the shared
    // ['research','geographies', icpId] key refreshes both this control and GeographiesPanel.
    const rejectMut = useMutation({
        mutationFn: async (geoId: string) => (await api.post(`/research/geographies/${geoId}/reject`, {})).data as GeoCellSummary,
        onSuccess: () => qc.invalidateQueries({ queryKey: ['research', 'geographies', icpId] }),
        onError: (err: unknown) => showErrorFromApi(err),
    });

    const canAdd = country.trim().length >= 2 && !addMut.isPending;

    return (
        <Stack gap="xs">
            <Text size="sm" fw={600}>{t('research.wizard.step8.countries', 'Target countries')}</Text>
            {cellsQuery.isLoading ? null : cells.length === 0 ? (
                <Text size="xs" c="dimmed">{t('research.wizard.step8.noCountries', 'No countries added yet.')}</Text>
            ) : (
                <Group gap="xs" wrap="wrap">
                    {cells.map((c, i) => {
                        const rows = marketQueries[i]?.data?.data ?? [];
                        const matches = rows.filter((row) => row.kind === 'world_import');
                        const rankedMatches = matches.filter((row) => row.rank != null);
                        const market = rankedMatches.length > 0
                            ? rankedMatches.reduce((best, row) => row.rank! < best.rank! ? row : best)
                            : matches[0];
                        // Light per-chip stagger riding the same `entered` flip (no separate effect) —
                        // each chip's own opacity/scale delays by 25ms per index, so the row settles
                        // in left-to-right rather than as one block. This is the ONLY local motion left
                        // in this file — the outer container's own mount fade was removed since
                        // WizardShell already animates the whole step's content swap at the shell level.
                        const chipStyle: CSSProperties = {
                            opacity: reduceMotion || entered ? 1 : 0,
                            transform: reduceMotion || entered ? 'scale(1)' : 'scale(0.92)',
                            transition: reduceMotion
                                ? 'none'
                                : `opacity 220ms ease-out ${i * 25}ms, transform 220ms ease-out ${i * 25}ms`,
                        };
                        // Rejected chips stay red and non-removable; every other status carries a
                        // small remove (soft-reject) affordance.
                        const removeSection = c.status !== 'rejected' ? (
                            <CloseButton
                                size="xs"
                                aria-label={t('research.geographies.reject', 'Remove')}
                                disabled={rejectMut.isPending && rejectMut.variables === c.id}
                                onClick={() => {
                                    if (!window.confirm(t('research.geographies.rejectConfirm', 'Remove this country from the ICP? Approved cells stop scoping new harvests; already-found companies are kept.'))) return;
                                    rejectMut.mutate(c.id);
                                }}
                            />
                        ) : undefined;
                        const badge = (
                            <Badge variant="light" color={STATUS_COLOR[c.status] ?? 'gray'} style={chipStyle} rightSection={removeSection}>
                                {c.country}
                            </Badge>
                        );
                        return market ? (
                            <Tooltip
                                key={c.id}
                                label={`${t('research.markets.source', 'UN Comtrade')} · ${[
                                    market.rank != null
                                        ? t('research.markets.worldImportRank', 'World import rank #{{rank}}', { rank: market.rank })
                                        : null,
                                    t('research.markets.worldImportValue', '{{value}}', { value: formatUsdCompact(market.import_value) }),
                                ].filter(Boolean).join(', ')}`}
                            >
                                {badge}
                            </Tooltip>
                        ) : (
                            <Badge key={c.id} variant="light" color={STATUS_COLOR[c.status] ?? 'gray'} style={chipStyle} rightSection={removeSection}>
                                {c.country}
                            </Badge>
                        );
                    })}
                </Group>
            )}
            <Group align="flex-end" gap="sm" wrap="wrap">
                <TextInput
                    placeholder={t('research.geographies.countryPh', 'e.g. Germany')}
                    leftSection={<IconWorldPin size={16} />}
                    value={country}
                    onChange={(e) => setCountry(e.currentTarget.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && canAdd) addMut.mutate();
                    }}
                    w={240}
                />
                <Button
                    leftSection={<IconSparkles size={16} />}
                    onClick={() => addMut.mutate()}
                    disabled={!canAdd}
                    loading={addMut.isPending}
                    size="sm"
                >
                    {t('research.wizard.step8.addCountry', 'Add country')}
                </Button>
            </Group>
        </Stack>
    );
}
