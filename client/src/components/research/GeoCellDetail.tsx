/**
 * GeoCellDetail — the "one geography cell" editor: spec form + human score + approve, plus
 * (once approved) the WP3 channel-coverage panel. Extracted from GeographiesPanel's detail
 * Drawer (WP8a) so the EXACT same body can be reused by the wizard's step 10 (no Drawer
 * chrome there — the wizard is already a single-card-per-screen shell) without touching
 * GeographiesPanel's existing Drawer-based behavior at /research/full. GeographiesPanel's
 * `GeoDetailDrawer` is now a thin wrapper: `<Drawer><GeoCellDetail .../></Drawer>`.
 */
import { useState } from 'react';
import {
    Alert, Badge, Button, Collapse, Divider, Group, NumberInput, Rating, Stack, TagsInput, Table, Text, Textarea, Tooltip, UnstyledButton,
} from '@mantine/core';
import { useReducedMotion } from '@mantine/hooks';
import { IconChevronDown, IconInfoCircle, IconRefresh, IconSparkles } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showError, showErrorFromApi, showSuccess, showWarning } from '../../lib/notifications';

export interface GeoChannel { type: string; name: string; url?: string }
export interface GeoDirectory { name: string; url?: string }

/** Mirror of the server's geoAnalysisSchema (the editable final, stored in spec JSONB). */
export interface GeoSpec {
    local_terms: string[];
    localized_signals: string[];
    localized_negative_signals: string[];
    directories: GeoDirectory[];
    channels: GeoChannel[];
    certifications: string[];
    buyer_titles: string[];
    market_notes: string;
    estimate: number | null;
    confidence: number | null;
    estimate_basis: string;
}

export interface GeoCell {
    id: string;
    icp_id: string | null;
    country: string;
    region: string | null;
    status: 'draft' | 'approved' | 'rejected';
    estimate: number | null;
    confidence: number | null;
    rationale: string | null;
    human_score: number | null;
    note: string | null;
    spec: GeoSpec | null;
    generated_by_job_id?: string | null;
    updated_at: string;
}

// Not exported (react-refresh wants component-only exports from a file — same convention as
// IcpCard.tsx/CalibrationDrawer.tsx's duplicated STATUS_COLOR/CALIBRATION_COLOR):
// GeographiesPanel.tsx keeps its own copy of httpInfo() (its status-color map lives only
// there — this file's own JSX never needs it, only the Drawer title wrapper does).
function httpInfo(err: unknown) {
    const resp = (err as { response?: { status?: number; data?: { job_id?: string } } }).response;
    return { status: resp?.status, jobId: resp?.data?.job_id };
}

function externalHref(url: string) {
    return /^https?:\/\//.test(url) ? url : `https://${url}`;
}

function formatUsdCompact(n: number): string {
    return new Intl.NumberFormat('en-US', {
        notation: 'compact', style: 'currency', currency: 'USD', maximumFractionDigits: 1,
    }).format(n);
}

/** Sign-aware growth percentage: a negative growth_pct already carries its own '-', a
 *  hardcoded '+' prefix would otherwise render e.g. '+-5% YoY' for a real, expected decline. */
function formatSignedPct(n: number): string {
    return n > 0 ? `+${n}` : `${n}`;
}

interface MarketEvidenceRow {
    hs_code: string;
    country: string;
    import_value: number;
    growth_pct: number | null;
    rank: number | null;
    kind: 'world_import' | 'bilateral_export';
    reporter_country: string | null;
    // bilateral_export rows only — set when getBilateralTrade fell back to the prior year
    // because the primary year had no data yet, so the UI can flag the fallback (bug 2).
    raw: { actualYear?: number } | null;
}

interface ChannelRow {
    id: string;
    type: string;
    name: string;
    url: string | null;
    member_list_url: string | null;
    discovery_round: number;
    harvest_status: 'pending' | 'harvested' | 'unreachable';
    harvested_at: string | null;
    companies_found: number | null;
    harvest_error: string | null;
    note: string | null;
}

interface CoverageRow {
    found_count: number;
    estimate: number | null;
    queries_total: number;
    channels_found: number;
    channels_harvested: number;
    saturation_a: boolean;
    saturation_b: boolean;
    fully_covered: boolean;
    discovery_rounds_no_new: number;
    status: string;
    updated_at: string;
}

const HARVEST_STATUS_COLOR: Record<ChannelRow['harvest_status'], string> = {
    pending: 'gray',
    harvested: 'green',
    unreachable: 'red',
};

/** WP3 coverage panel — the cell's channel table + cumulative saturation state.
 *  Polls while mounted (worker jobs land asynchronously); all money stays server-side. */
function CellCoveragePanel({ geoId }: { geoId: string }) {
    const { t } = useTranslation();
    const qc = useQueryClient();

    const coverageQuery = useQuery<{ data: CoverageRow | null }>({
        queryKey: ['research', 'coverage', geoId],
        queryFn: async () => (await api.get(`/research/channels/coverage?geo_id=${geoId}`)).data,
        refetchInterval: 7000,
    });
    const channelsQuery = useQuery<{ data: ChannelRow[] }>({
        queryKey: ['research', 'channels', geoId],
        queryFn: async () => (await api.get(`/research/channels?geo_id=${geoId}`)).data,
        refetchInterval: 7000,
    });
    const coverage = coverageQuery.data?.data ?? null;
    const channels = channelsQuery.data?.data ?? [];

    const refresh = () => {
        void qc.invalidateQueries({ queryKey: ['research', 'coverage', geoId] });
        void qc.invalidateQueries({ queryKey: ['research', 'channels', geoId] });
    };

    const onJobError = (err: unknown) => {
        const { status } = httpInfo(err);
        if (status === 402) {
            showError(t('research.geographies.noCredits', 'You do not have research credits — top up before analyzing geographies.'));
            return;
        }
        showErrorFromApi(err);
    };

    const discoverMut = useMutation({
        mutationFn: async () => (await api.post('/research/channels/discover', { geo_id: geoId })).data,
        onSuccess: () => {
            showSuccess(t('research.channels.discoverStarted', 'Channel discovery started — new channels appear here as the round completes.'));
            refresh();
        },
        onError: onJobError,
    });

    const harvestMut = useMutation({
        mutationFn: async (channelId: string) => (await api.post(`/research/channels/${channelId}/harvest`, {})).data,
        onSuccess: () => {
            showSuccess(t('research.channels.harvestStarted', 'Harvest started — members flow into Companies as they validate.'));
            refresh();
        },
        onError: onJobError,
    });

    return (
        <Stack gap="sm">
            <Group justify="space-between" align="center">
                <Text fw={600}>{t('research.channels.title', 'Channels & coverage')}</Text>
                <Button
                    size="xs" variant="light" leftSection={<IconSparkles size={14} />}
                    onClick={() => discoverMut.mutate()} loading={discoverMut.isPending}
                >
                    {t('research.channels.discover', 'Discover channels')}
                </Button>
            </Group>

            {coverage ? (
                <Group gap="xs" wrap="wrap">
                    <Badge variant="light" color="blue">
                        {t('research.channels.found', 'Found')}: {coverage.found_count}{coverage.estimate != null ? ` / E ${coverage.estimate}` : ''}
                    </Badge>
                    <Badge variant="light" color="grape">
                        {t('research.channels.queries', 'Queries')}: {coverage.queries_total}
                    </Badge>
                    <Badge variant="light" color={coverage.saturation_a ? 'green' : 'gray'}>
                        {t('research.channels.ruleA', 'Lists')}: {coverage.saturation_a ? t('research.channels.saturated', 'saturated') : t('research.channels.open', 'in progress')}
                    </Badge>
                    <Badge variant="light" color={coverage.saturation_b ? 'green' : 'gray'}>
                        {t('research.channels.ruleB', 'Open web')}: {coverage.saturation_b ? t('research.channels.saturated', 'saturated') : t('research.channels.open', 'in progress')}
                    </Badge>
                    {coverage.fully_covered && (
                        <Badge color="teal">{t('research.channels.fullyCovered', 'Fully covered')}</Badge>
                    )}
                </Group>
            ) : (
                <Text size="xs" c="dimmed">
                    {t('research.channels.noCoverage', 'No coverage yet — run a discovery round or a harvest to start tracking this cell.')}
                </Text>
            )}

            {channels.length > 0 && (
                <Table withTableBorder={false} verticalSpacing={4} fz="xs">
                    <Table.Thead>
                        <Table.Tr>
                            <Table.Th>{t('research.channels.colName', 'Channel')}</Table.Th>
                            <Table.Th>{t('research.channels.colType', 'Type')}</Table.Th>
                            <Table.Th>{t('research.channels.colStatus', 'Status')}</Table.Th>
                            <Table.Th>{t('research.channels.colFound', 'Members')}</Table.Th>
                            <Table.Th />
                        </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                        {channels.map((c) => (
                            <Table.Tr key={c.id}>
                                <Table.Td>
                                    {c.url ? (
                                        <Text size="xs" c="blue" component="a" href={externalHref(c.url)} target="_blank" rel="noreferrer">
                                            {c.name}
                                        </Text>
                                    ) : (
                                        <Text size="xs">{c.name}</Text>
                                    )}
                                </Table.Td>
                                <Table.Td>
                                    <Badge size="xs" variant="light" color="violet">
                                        {t(`research.geographies.channelType.${c.type}`, c.type)}
                                    </Badge>
                                </Table.Td>
                                <Table.Td>
                                    <Tooltip label={c.harvest_error ?? ''} disabled={!c.harvest_error}>
                                        <Badge size="xs" variant="light" color={HARVEST_STATUS_COLOR[c.harvest_status] ?? 'gray'}>
                                            {t(`research.channels.status.${c.harvest_status}`, c.harvest_status)}
                                        </Badge>
                                    </Tooltip>
                                </Table.Td>
                                <Table.Td>{c.companies_found ?? '—'}</Table.Td>
                                <Table.Td>
                                    <Button
                                        size="compact-xs" variant="subtle"
                                        onClick={() => harvestMut.mutate(c.id)}
                                        loading={harvestMut.isPending && harvestMut.variables === c.id}
                                    >
                                        {c.harvest_status === 'pending'
                                            ? t('research.channels.harvest', 'Harvest')
                                            : t('research.channels.reharvest', 'Re-harvest')}
                                    </Button>
                                </Table.Td>
                            </Table.Tr>
                        ))}
                    </Table.Tbody>
                </Table>
            )}
        </Stack>
    );
}

/** The "one cell" editor body — spec form + score + approve + (if approved) coverage. Used
 *  standalone by the wizard (WP8a step 10) and wrapped in a Drawer by GeographiesPanel. */
export function GeoCellDetail({
    cell, analyzing, onReanalyze, onChanged,
}: {
    cell: GeoCell | null;
    analyzing: boolean;
    onReanalyze: (geoId: string) => void;
    // Pass the mutation's returned row so the parent can seed the cache with the fresh
    // updated_at (CAS token) without waiting for the refetch.
    onChanged: (row?: GeoCell) => void;
}) {
    const { t } = useTranslation();
    const reduceMotion = useReducedMotion();
    const spec = cell?.spec ?? null;

    // No local mount-entrance here — WizardShell already animates each step's content swap
    // (fade+slide) at the shell level; a second local fade on top of that double-stacked the
    // animation (step 10). GeoCellDetail is also rendered inside a Drawer by GeographiesPanel,
    // which has no shell-level transition of its own, so this component intentionally owns none.

    // Seeded from the current spec; the parent remounts this component (key) when a
    // re-analysis lands.
    const [localTerms, setLocalTerms] = useState<string[]>(spec?.local_terms ?? []);
    const [signals, setSignals] = useState<string[]>(spec?.localized_signals ?? []);
    const [negatives, setNegatives] = useState<string[]>(spec?.localized_negative_signals ?? []);
    const [buyerTitles, setBuyerTitles] = useState<string[]>(spec?.buyer_titles ?? []);
    const [certifications, setCertifications] = useState<string[]>(spec?.certifications ?? []);
    const [marketNotes, setMarketNotes] = useState(spec?.market_notes ?? '');
    const [estimate, setEstimate] = useState<number | null>(spec?.estimate ?? null);
    const [score, setScore] = useState<number>(cell?.human_score ?? 0);
    // Closed by default (Tg-Research-v2/06_WIZARD_TASARIM.md, Karar 5): the raw signal/rule
    // chip editors are config, not a decision — the estimate, score and trade evidence below
    // are what this screen is actually for, so they stay in the primary, non-collapsed view.
    const [detailsOpen, setDetailsOpen] = useState(false);

    // A spec write validates the FULL schema server-side and demotes the cell to draft.
    const saveMut = useMutation({
        mutationFn: async () => {
            const body: { spec: GeoSpec } = {
                spec: {
                    local_terms: localTerms,
                    localized_signals: signals,
                    localized_negative_signals: negatives,
                    directories: spec?.directories ?? [],
                    channels: spec?.channels ?? [],
                    certifications,
                    buyer_titles: buyerTitles,
                    market_notes: marketNotes,
                    estimate,
                    confidence: spec?.confidence ?? null,
                    estimate_basis: spec?.estimate_basis ?? '',
                },
            };
            return (await api.patch(`/research/geographies/${cell!.id}`, body)).data as GeoCell;
        },
        onSuccess: (row) => {
            showSuccess(t('research.geographies.saved', 'Geography saved — the cell is back in draft.'));
            onChanged(row);
        },
        onError: (err: unknown) => showErrorFromApi(err),
    });

    const approveMut = useMutation({
        // updated_at is the CAS token: approval binds to the exact spec this drawer loaded —
        // if a re-analysis or another tab rewrote it meanwhile, the server 409s instead of
        // approving a spec the human never saw.
        mutationFn: async () =>
            (await api.post(`/research/geographies/${cell!.id}/approve`, { human_score: score, updated_at: cell!.updated_at })).data as GeoCell,
        onSuccess: (row) => {
            showSuccess(t('research.geographies.approvedToast', 'Geography approved.'));
            onChanged(row);
        },
        onError: (err: unknown) => {
            if (httpInfo(err).status === 409) {
                const stale = (err as { response?: { data?: { current_updated_at?: string } } }).response?.data?.current_updated_at;
                if (stale) {
                    // Refetch so the caller remounts this with the spec that actually exists now.
                    showWarning(t('research.geographies.staleApprove', 'This geography changed since you opened it — review the latest spec and approve again.'));
                    onChanged();
                    return;
                }
                showWarning(t('research.geographies.needSpec', 'Run the analysis first — the cell needs a spec before approval.'));
                return;
            }
            showErrorFromApi(err);
        },
    });

    // Geography-scoped evidence (WP11) — resolved reporter/partner country names + approved-HS
    // filtering happen server-side (loadMarketEvidenceForGeoCountry), so this must go through
    // the geography's own /markets route rather than the raw project-wide one: a naive string
    // match against the customer-typed country label (e.g. "USA") can silently miss rows keyed
    // under Comtrade's canonical reference name (e.g. "United States of America").
    const marketsQuery = useQuery<{ data: MarketEvidenceRow[] }>({
        queryKey: ['research', 'geo-markets', cell?.id],
        queryFn: async () => (await api.get(`/research/geographies/${cell!.id}/markets`)).data,
        enabled: !!cell,
    });

    if (!cell) return null;

    const marketRows = marketsQuery.data?.data ?? [];
    const worldImports = marketRows.filter((row) => row.kind === 'world_import');
    const rankedWorldImports = worldImports.filter((row) => row.rank != null);
    const worldImport = rankedWorldImports.length > 0
        ? rankedWorldImports.reduce((best, row) => row.rank! < best.rank! ? row : best)
        : worldImports[0];
    const bilateralExports = marketRows.filter((row) => row.kind === 'bilateral_export');
    const bilateralExport = bilateralExports.length > 0
        ? bilateralExports.reduce((best, row) => row.import_value > best.import_value ? row : best)
        : undefined;

    const reanalyze = () => {
        // Overwrites the current draft when it completes — confirm only if there is one to lose.
        if (spec && !window.confirm(t('research.geographies.reanalyzeConfirm', 'Re-analysis overwrites the current draft when it finishes. Continue?'))) return;
        onReanalyze(cell.id);
    };

    return (
        <Stack gap="md">
            <Group justify="flex-end">
                <Button
                    variant="light" leftSection={<IconRefresh size={16} />}
                    onClick={reanalyze} disabled={analyzing} loading={analyzing}
                >
                    {t('research.geographies.reanalyze', 'Re-analyze')}
                </Button>
            </Group>

            {!spec ? (
                <Alert color="gray" icon={<IconInfoCircle size={16} />}>
                    {t('research.geographies.noSpec', 'No analyzed spec yet — run the analysis to draft this cell.')}
                </Alert>
            ) : (
                <Stack gap="sm">
                    <Group align="flex-end" gap="sm">
                        <NumberInput
                            label={t('research.geographies.estimateLabel', 'Estimated target firms')}
                            min={0} max={1000000} w={200}
                            value={estimate ?? ''}
                            onChange={(v) => setEstimate(typeof v === 'number' ? v : null)}
                        />
                        <Text size="sm" c="dimmed" pb={8}>
                            {t('research.geographies.confidence', 'Confidence')}: {spec.confidence != null ? `${Math.round(spec.confidence * 100)}%` : '—'}
                        </Text>
                    </Group>
                    {spec.estimate_basis && (
                        <Text size="xs" c="dimmed">
                            {t('research.geographies.estimateBasis', 'Estimate basis')}: {spec.estimate_basis}
                        </Text>
                    )}

                    <UnstyledButton
                        onClick={() => setDetailsOpen((v) => !v)}
                        style={{ alignSelf: 'flex-start' }}
                        aria-expanded={detailsOpen}
                        aria-controls={`geo-details-${cell.id}`}
                    >
                        <Group gap={4} c="dimmed" wrap="nowrap">
                            <Text size="xs" fw={600}>
                                {detailsOpen ? t('research.geographies.hideDetails', 'Hide details') : t('research.geographies.showDetails', 'Details')}
                            </Text>
                            <IconChevronDown
                                size={13}
                                style={{
                                    transition: reduceMotion ? 'none' : 'transform 160ms ease',
                                    transform: detailsOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                                }}
                            />
                        </Group>
                    </UnstyledButton>

                    <Collapse id={`geo-details-${cell.id}`} in={detailsOpen} transitionDuration={reduceMotion ? 0 : 200} transitionTimingFunction="ease">
                        <Stack gap="sm" pt={2}>
                            <TagsInput
                                label={t('research.geographies.localTerms', 'Local search terms')}
                                value={localTerms} onChange={setLocalTerms}
                            />
                            <TagsInput
                                label={t('research.geographies.localizedSignals', 'Localized signals')}
                                value={signals} onChange={setSignals}
                            />
                            <TagsInput
                                label={t('research.geographies.localizedNegativeSignals', 'Localized negative signals')}
                                value={negatives} onChange={setNegatives}
                            />
                            <TagsInput
                                label={t('research.geographies.buyerTitles', 'Buyer titles')}
                                value={buyerTitles} onChange={setBuyerTitles}
                            />
                            <TagsInput
                                label={t('research.geographies.certifications', 'Certifications')}
                                value={certifications} onChange={setCertifications}
                            />
                            <Textarea
                                label={t('research.geographies.marketNotes', 'Market structure notes')}
                                autosize minRows={3}
                                value={marketNotes}
                                onChange={(e) => setMarketNotes(e.currentTarget.value)}
                            />

                            {spec.channels.length > 0 && (
                                <div>
                                    <Text size="sm" fw={600}>{t('research.geographies.channels', 'Key channels')}</Text>
                                    <Stack gap={4} mt={4}>
                                        {spec.channels.map((ch, i) => (
                                            <Group key={i} gap="xs" wrap="nowrap">
                                                <Badge size="xs" variant="light" color="violet">
                                                    {t(`research.geographies.channelType.${ch.type}`, ch.type)}
                                                </Badge>
                                                {ch.url ? (
                                                    <Text size="xs" c="blue" component="a" href={externalHref(ch.url)} target="_blank" rel="noreferrer">
                                                        {ch.name}
                                                    </Text>
                                                ) : (
                                                    <Text size="xs">{ch.name}</Text>
                                                )}
                                            </Group>
                                        ))}
                                    </Stack>
                                </div>
                            )}

                            {spec.directories.length > 0 && (
                                <div>
                                    <Text size="sm" fw={600}>{t('research.geographies.directories', 'Directories')}</Text>
                                    <Stack gap={4} mt={4}>
                                        {spec.directories.map((d, i) => (
                                            d.url ? (
                                                <Text key={i} size="xs" c="blue" component="a" href={externalHref(d.url)} target="_blank" rel="noreferrer">
                                                    {d.name}
                                                </Text>
                                            ) : (
                                                <Text key={i} size="xs">{d.name}</Text>
                                            )
                                        ))}
                                    </Stack>
                                </div>
                            )}
                        </Stack>
                    </Collapse>

                    <Group justify="space-between" align="center">
                        <Text size="xs" c="dimmed">
                            {t('research.geographies.saveHint', 'Saving returns the cell to draft; approve it again afterwards.')}
                        </Text>
                        <Button variant="default" onClick={() => saveMut.mutate()} loading={saveMut.isPending}>
                            {t('research.geographies.save', 'Save')}
                        </Button>
                    </Group>

                    <Divider />

                    {/* Approve — human score /10, mirrors the ICP gate */}
                    <Group justify="space-between" align="center">
                        <div>
                            <Text size="sm" fw={600}>{t('research.geographies.yourScore', 'Your score')}: {score}/10</Text>
                            <Rating count={10} value={score} onChange={setScore} />
                        </div>
                        <Tooltip label={t('research.geographies.approveHint', 'Approved cells become selectable in the harvest launcher.')}>
                            <Button
                                color="teal"
                                onClick={() => approveMut.mutate()}
                                loading={approveMut.isPending}
                                disabled={cell.status === 'approved'}
                            >
                                {t('research.geographies.approve', 'Approve')}
                            </Button>
                        </Tooltip>
                    </Group>
                </Stack>
            )}

            {(worldImport || bilateralExport) && (
                <Group gap="xs" wrap="wrap">
                    <Badge variant="outline" size="xs">
                        {t('research.markets.source', 'UN Comtrade')}
                    </Badge>
                    {worldImport && (
                        <Text size="xs">
                            {[
                                worldImport.rank != null
                                    ? t('research.markets.worldImportRank', 'World import rank #{{rank}}', { rank: worldImport.rank })
                                    : null,
                                t('research.markets.worldImportValue', '{{value}}', { value: formatUsdCompact(worldImport.import_value) }),
                                worldImport.growth_pct != null
                                    ? t('research.markets.growth', '{{pct}}% YoY', { pct: formatSignedPct(worldImport.growth_pct) })
                                    : null,
                            ].filter(Boolean).join(' · ')}
                        </Text>
                    )}
                    {bilateralExport && (
                        <Text size="xs">
                            {[
                                t('research.markets.bilateralExport', '{{country}} exports here', { country: bilateralExport.reporter_country ?? '' }),
                                t('research.markets.worldImportValue', '{{value}}', { value: formatUsdCompact(bilateralExport.import_value) }),
                                bilateralExport.growth_pct != null
                                    ? t('research.markets.growth', '{{pct}}% YoY', { pct: formatSignedPct(bilateralExport.growth_pct) })
                                    : null,
                                bilateralExport.raw?.actualYear != null
                                    ? t('research.markets.actualYear', '({{year}} data)', { year: bilateralExport.raw.actualYear })
                                    : null,
                            ].filter(Boolean).join(' · ')}
                        </Text>
                    )}
                </Group>
            )}

            {/* WP3 — Y1 channel discovery + list harvest + cumulative coverage. Gated on an
                APPROVED cell (discovery consumes the approved spec; harvest bills money). */}
            {cell.status === 'approved' ? (
                <>
                    <Divider />
                    <CellCoveragePanel geoId={cell.id} />
                </>
            ) : (
                <Text size="xs" c="dimmed">
                    {t('research.channels.approveFirst', 'Approve the cell to unlock channel discovery and coverage.')}
                </Text>
            )}
        </Stack>
    );
}
