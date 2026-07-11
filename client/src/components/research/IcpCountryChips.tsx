/**
 * IcpCountryChips — WP8a wizard step 8's "which countries does this sub-ICP target" control.
 * Shows the ICP's already-added geography cells as status-colored chips (read-only — the
 * existing geographies routes have no delete/reject path for a cell, so there is nothing
 * genuine to remove a chip TO; a country the customer no longer wants simply never gets
 * analyzed/approved in step 9/10) and a small add-country form that mirrors
 * GeographiesPanel's own (create-or-reuse via POST /research/geographies, which also
 * auto-enqueues geo:analyze — the wizard's step 9 picks up any cell still missing a spec).
 * No AI-suggested countries here: the ICP schema doesn't carry them, and icp:generate's
 * output is untouched by this WP — this is customer-driven add only.
 */
import { useState } from 'react';
import { Badge, Button, Group, Stack, Text, TextInput, Tooltip } from '@mantine/core';
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
            if (!resp.job && !resp.reused) {
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

    const canAdd = country.trim().length >= 2 && !addMut.isPending;

    return (
        <Stack gap="xs">
            <Text size="sm" fw={500}>{t('research.wizard.step8.countries', 'Target countries')}</Text>
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
                        const badge = (
                            <Badge variant="light" color={STATUS_COLOR[c.status] ?? 'gray'}>
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
                                    t('research.markets.worldImportValue', '${{value}}', { value: formatUsdCompact(market.import_value) }),
                                ].filter(Boolean).join(', ')}`}
                            >
                                {badge}
                            </Tooltip>
                        ) : (
                            <Badge key={c.id} variant="light" color={STATUS_COLOR[c.status] ?? 'gray'}>
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
