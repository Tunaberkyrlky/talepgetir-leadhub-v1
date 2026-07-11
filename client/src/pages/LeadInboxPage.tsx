import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
    ActionIcon,
    Anchor,
    Badge,
    Button,
    Center,
    Container,
    Group,
    Loader,
    Pagination,
    Paper,
    Stack,
    Table,
    Tabs,
    Text,
    Title,
    Tooltip,
} from '@mantine/core';
import { IconInbox, IconAlertTriangle, IconSearch, IconExternalLink, IconAlertCircle, IconShieldX, IconSparkles, IconThumbUp, IconThumbDown } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { showSuccess, showErrorFromApi } from '../lib/notifications';
import type { Lead, LeadsResponse, SpamSubmissionsResponse, ReviewQueueResponse, ReviewQueueItem, Verdict } from '../types/lead';

type InboxTab = 'new' | 'review' | 'qualify' | 'error' | 'spam';

// Lead queues → lifecycle_status filter sent to the API. The Spam queue is NOT a
// lifecycle (those submissions never became leads); it has its own endpoint.
const TAB_LIFECYCLE: Record<'new' | 'review' | 'error', string> = {
    new: 'captured,identity_pending',
    review: 'needs_review',
    error: 'processing_error',
};

const LIFECYCLE_COLOR: Record<string, string> = {
    captured: 'green',
    identity_pending: 'yellow',
    needs_review: 'orange',
    processing_error: 'red',
};

const PAGE_LIMIT = 25;

// Localized relative age (e.g. "5 min. ago" / "5 dk. önce") via Intl — no i18n keys.
function ageLabel(iso: string, language: string): string {
    const rtf = new Intl.RelativeTimeFormat(language, { numeric: 'auto', style: 'narrow' });
    const elapsedMin = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
    if (elapsedMin < 1) return rtf.format(0, 'second');        // "now" / "şimdi"
    if (elapsedMin < 60) return rtf.format(-elapsedMin, 'minute');
    const elapsedHr = Math.floor(elapsedMin / 60);
    if (elapsedHr < 24) return rtf.format(-elapsedHr, 'hour');
    return rtf.format(-Math.floor(elapsedHr / 24), 'day');
}

export default function LeadInboxPage() {
    const { t, i18n } = useTranslation();
    const { activeTenantId } = useAuth();
    const queryClient = useQueryClient();

    const [activeTab, setActiveTab] = useState<InboxTab>('new');
    const [page, setPage] = useState(1);

    const isSpam = activeTab === 'spam';
    // Qualification review queue (enrichment verdict=review) — DISTINCT from the
    // 'review' lifecycle tab (identity/deliverability needs_review).
    const isQualify = activeTab === 'qualify';

    // review_reason is a machine string that may carry several reasons joined by ';'
    // or ',' (e.g. "name_only_match; mx_missing"). Localize each known snake_case
    // token via leadInbox.reviewReason.*; free-form values (e.g. processing-error
    // messages) fall through to their raw text.
    const formatReason = (reason: string): string =>
        reason
            .split(/[;,]/)
            .map((r) => r.trim())
            .filter(Boolean)
            .map((token) => (/^[a-z][a-z0-9_]*$/.test(token) ? t(`leadInbox.reviewReason.${token}`, token) : token))
            .join(', ');

    // Scope the cache to the active tenant so a tenant switch can't surface stale
    // rows, and don't fetch until a tenant is resolved.
    const { data, isLoading, isError } = useQuery<LeadsResponse>({
        queryKey: ['leads', activeTenantId, activeTab, page],
        enabled: !!activeTenantId && !isSpam && !isQualify,
        queryFn: async () => {
            const res = await api.get('/leads', {
                params: { lifecycle: TAB_LIFECYCLE[activeTab as 'new' | 'review' | 'error'], page, limit: PAGE_LIMIT },
            });
            return res.data as LeadsResponse;
        },
        refetchInterval: 30_000,
    });

    // Spam queue: honeypot/Turnstile-flagged submissions that never became leads.
    const { data: spamData, isLoading: spamLoading, isError: spamError } = useQuery<SpamSubmissionsResponse>({
        queryKey: ['leads-spam', activeTenantId, page],
        enabled: !!activeTenantId && isSpam,
        queryFn: async () => {
            const res = await api.get('/leads/spam', { params: { page, limit: PAGE_LIMIT } });
            return res.data as SpamSubmissionsResponse;
        },
        refetchInterval: 30_000,
    });

    // Qualification review queue: enrichment runs whose verdict is low-confidence
    // 'review' and not yet human-resolved.
    const { data: reviewData, isLoading: reviewLoading, isError: reviewError } = useQuery<ReviewQueueResponse>({
        queryKey: ['leads-review', activeTenantId, page],
        enabled: !!activeTenantId && isQualify,
        queryFn: async () => {
            const res = await api.get('/leads/review', { params: { page, limit: PAGE_LIMIT } });
            return res.data as ReviewQueueResponse;
        },
        refetchInterval: 30_000,
    });

    // Resolve a qualification verdict (qualify / disqualify) — never triggers outbound.
    // runId pins the exact review run so a concurrent re-enrichment can't move the target.
    const resolveMutation = useMutation({
        mutationFn: async ({ leadId, runId, verdict }: { leadId: string; runId: string; verdict: Verdict }) => {
            await api.post(`/leads/${leadId}/resolve`, { run_id: runId, verdict });
        },
        onSuccess: () => {
            showSuccess(t('leadInbox.resolveSuccess', 'Karar kaydedildi'));
            // The row leaves the review queue AND the lead's qualification_status
            // changed, so refresh both the review queue and the lead lists.
            queryClient.invalidateQueries({ queryKey: ['leads-review', activeTenantId] });
            queryClient.invalidateQueries({ queryKey: ['leads', activeTenantId] });
        },
        onError: (err) => showErrorFromApi(err, t('leadInbox.resolveError', 'Karar kaydedilemedi')),
    });

    const leads = data?.data ?? [];
    const spamRows = spamData?.data ?? [];
    const reviewRows = reviewData?.data ?? [];
    const loading = isSpam ? spamLoading : isQualify ? reviewLoading : isLoading;
    const errored = isSpam ? spamError : isQualify ? reviewError : isError;
    const empty = isSpam ? spamRows.length === 0 : isQualify ? reviewRows.length === 0 : leads.length === 0;
    const totalPages = (isSpam ? spamData?.pagination.totalPages : isQualify ? reviewData?.pagination.totalPages : data?.pagination.totalPages) ?? 1;

    const handleTab = (value: string | null) => {
        if (!value) return;
        setActiveTab(value as InboxTab);
        setPage(1);
    };

    const rows = leads.map((lead: Lead) => {
        const who = lead.contact_name || lead.company_name || (
            <Text component="span" c="dimmed" fs="italic">{t('leadInbox.identityPending', 'Kimlik bekliyor')}</Text>
        );
        return (
            <Table.Tr key={lead.id}>
                <Table.Td>
                    {lead.company_id ? (
                        <Anchor component={Link} to={`/companies/${lead.company_id}`} fw={500}>
                            {who}
                        </Anchor>
                    ) : (
                        <Text fw={500}>{who}</Text>
                    )}
                    {lead.company_name && lead.contact_name && (
                        <Text size="xs" c="dimmed">{lead.company_name}</Text>
                    )}
                </Table.Td>
                <Table.Td>
                    <Badge variant="light" color="gray" size="sm">
                        {t(`leadInbox.sourceType.${lead.source_type}`, lead.source_name || lead.source_type)}
                    </Badge>
                </Table.Td>
                <Table.Td>
                    <Badge variant="light" color={LIFECYCLE_COLOR[lead.lifecycle_status] || 'gray'} size="sm">
                        {t(`leadInbox.status.${lead.lifecycle_status}`, lead.lifecycle_status)}
                    </Badge>
                    {lead.review_reason && activeTab !== 'new' && (
                        <Text size="xs" c="dimmed">{formatReason(lead.review_reason)}</Text>
                    )}
                </Table.Td>
                <Table.Td>
                    <Text size="sm" c="dimmed">{lead.score ?? '—'}</Text>
                </Table.Td>
                <Table.Td>
                    <Tooltip label={new Date(lead.captured_at).toLocaleString()}>
                        <Text size="sm" c="dimmed">{ageLabel(lead.captured_at, i18n.language)}</Text>
                    </Tooltip>
                </Table.Td>
                <Table.Td>
                    {lead.company_id ? (
                        <Tooltip label={t('leadInbox.openCompany', 'Firmayı aç')}>
                            <ActionIcon component={Link} to={`/companies/${lead.company_id}`} variant="subtle" color="blue" aria-label={t('leadInbox.openCompany', 'Firmayı aç')}>
                                <IconExternalLink size={16} />
                            </ActionIcon>
                        </Tooltip>
                    ) : lead.contact_id ? (
                        <Tooltip label={t('leadInbox.openPerson', 'Kişiyi aç')}>
                            <ActionIcon component={Link} to={`/people/${lead.contact_id}`} variant="subtle" color="blue" aria-label={t('leadInbox.openPerson', 'Kişiyi aç')}>
                                <IconExternalLink size={16} />
                            </ActionIcon>
                        </Tooltip>
                    ) : (
                        <Tooltip label={lead.review_reason ? formatReason(lead.review_reason) : t('leadInbox.noLinkedRecord', 'Bağlı kayıt yok')}>
                            <span style={{ display: 'inline-flex' }}>
                                <ActionIcon variant="subtle" color="gray" disabled aria-label={t('leadInbox.noLinkedRecord', 'Bağlı kayıt yok')}>
                                    <IconAlertCircle size={16} />
                                </ActionIcon>
                            </span>
                        </Tooltip>
                    )}
                </Table.Td>
            </Table.Tr>
        );
    });

    const spamTableRows = spamRows.map((s) => (
        <Table.Tr key={s.id}>
            <Table.Td>
                <Text fw={500}>{s.email || s.name || <Text component="span" c="dimmed" fs="italic">—</Text>}</Text>
                {s.email && s.name && <Text size="xs" c="dimmed">{s.name}</Text>}
            </Table.Td>
            <Table.Td>
                <Text size="sm" c="dimmed">{s.form_name || '—'}</Text>
            </Table.Td>
            <Table.Td>
                <Badge variant="light" color="red" size="sm">
                    {t(`leadInbox.spamReason.${s.reason}`, s.reason || 'spam')}
                </Badge>
            </Table.Td>
            <Table.Td>
                <Tooltip label={new Date(s.submitted_at).toLocaleString()}>
                    <Text size="sm" c="dimmed">{ageLabel(s.submitted_at, i18n.language)}</Text>
                </Tooltip>
            </Table.Td>
        </Table.Tr>
    ));

    // Localize reason codes (snake_case tokens) via leadInbox.reasonCode.*; unknown
    // tokens fall through to their raw text.
    const formatReasonCodes = (codes: string[]): string =>
        codes.map((c) => t(`leadInbox.reasonCode.${c}`, c)).join(', ');

    const reviewTableRows = reviewRows.map((r: ReviewQueueItem) => {
        const who = r.contact_name || r.company_name || (
            <Text component="span" c="dimmed" fs="italic">{t('leadInbox.identityPending', 'Kimlik bekliyor')}</Text>
        );
        const resolving = resolveMutation.isPending && resolveMutation.variables?.leadId === r.lead_id;
        return (
            <Table.Tr key={r.id}>
                <Table.Td>
                    {r.company_id ? (
                        <Anchor component={Link} to={`/companies/${r.company_id}`} fw={500}>{who}</Anchor>
                    ) : (
                        <Text fw={500}>{who}</Text>
                    )}
                    {r.company_name && r.contact_name && (
                        <Text size="xs" c="dimmed">{r.company_name}</Text>
                    )}
                </Table.Td>
                <Table.Td>
                    <Badge variant="light" color="gray" size="sm">
                        {r.source_type ? t(`leadInbox.sourceType.${r.source_type}`, r.source_name || r.source_type) : (r.source_name || '—')}
                    </Badge>
                </Table.Td>
                <Table.Td>
                    <Text size="sm" c="dimmed">{r.score ?? '—'}</Text>
                </Table.Td>
                <Table.Td>
                    <Text size="xs" c="dimmed">
                        {r.reason_codes.length ? formatReasonCodes(r.reason_codes) : t('leadInbox.noReasons', 'Sinyal yok')}
                    </Text>
                </Table.Td>
                <Table.Td>
                    <Tooltip label={r.captured_at ? new Date(r.captured_at).toLocaleString() : ''}>
                        <Text size="sm" c="dimmed">{r.captured_at ? ageLabel(r.captured_at, i18n.language) : '—'}</Text>
                    </Tooltip>
                </Table.Td>
                <Table.Td>
                    <Group gap="xs" wrap="nowrap">
                        <Button
                            size="compact-xs" variant="light" color="green" leftSection={<IconThumbUp size={14} />}
                            loading={resolving} disabled={resolveMutation.isPending}
                            onClick={() => resolveMutation.mutate({ leadId: r.lead_id, runId: r.id, verdict: 'qualified' })}
                        >
                            {t('leadInbox.actions.qualify', 'Nitelikli')}
                        </Button>
                        <Button
                            size="compact-xs" variant="light" color="red" leftSection={<IconThumbDown size={14} />}
                            loading={resolving} disabled={resolveMutation.isPending}
                            onClick={() => resolveMutation.mutate({ leadId: r.lead_id, runId: r.id, verdict: 'disqualified' })}
                        >
                            {t('leadInbox.actions.disqualify', 'Elenmiş')}
                        </Button>
                    </Group>
                </Table.Td>
            </Table.Tr>
        );
    });

    return (
        <Container size="xl" py="md">
            <Group gap="xs" mb="md">
                <IconInbox size={26} />
                <Title order={2}>{t('leadInbox.title', 'Lead Gelen Kutusu')}</Title>
            </Group>

            <Tabs value={activeTab} onChange={handleTab}>
                <Tabs.List mb="md">
                    <Tabs.Tab value="new" leftSection={<IconInbox size={16} />}>
                        {t('leadInbox.tabs.new', 'Yeni')}
                    </Tabs.Tab>
                    <Tabs.Tab value="review" leftSection={<IconSearch size={16} />}>
                        {t('leadInbox.tabs.review', 'İnceleme')}
                    </Tabs.Tab>
                    <Tabs.Tab value="qualify" leftSection={<IconSparkles size={16} />}>
                        {t('leadInbox.tabs.qualify', 'Nitelendirme')}
                    </Tabs.Tab>
                    <Tabs.Tab value="error" leftSection={<IconAlertTriangle size={16} />}>
                        {t('leadInbox.tabs.error', 'Hata')}
                    </Tabs.Tab>
                    <Tabs.Tab value="spam" leftSection={<IconShieldX size={16} />}>
                        {t('leadInbox.tabs.spam', 'Spam')}
                    </Tabs.Tab>
                </Tabs.List>
            </Tabs>

            <Paper withBorder radius="md">
                {loading ? (
                    <Center py="xl"><Loader /></Center>
                ) : errored ? (
                    <Center py="xl"><Text c="red">{t('leadInbox.loadError', 'Lead listesi yüklenemedi')}</Text></Center>
                ) : empty ? (
                    <Center py="xl"><Text c="dimmed">{isSpam ? t('leadInbox.spamEmpty', 'Spam olarak işaretlenmiş gönderim yok') : isQualify ? t('leadInbox.qualifyEmpty', 'İncelenecek nitelendirme yok') : t('leadInbox.empty', 'Bu kuyrukta lead yok')}</Text></Center>
                ) : isQualify ? (
                    <Table.ScrollContainer minWidth={820}>
                        <Table verticalSpacing="sm" highlightOnHover>
                            <Table.Thead>
                                <Table.Tr>
                                    <Table.Th>{t('leadInbox.col.who', 'Firma / Kişi')}</Table.Th>
                                    <Table.Th>{t('leadInbox.col.source', 'Kaynak')}</Table.Th>
                                    <Table.Th>{t('leadInbox.col.score', 'Skor')}</Table.Th>
                                    <Table.Th>{t('leadInbox.col.signals', 'Sinyaller')}</Table.Th>
                                    <Table.Th>{t('leadInbox.col.age', 'Yaş')}</Table.Th>
                                    <Table.Th>{t('leadInbox.col.action', 'İşlem')}</Table.Th>
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>{reviewTableRows}</Table.Tbody>
                        </Table>
                    </Table.ScrollContainer>
                ) : isSpam ? (
                    <Table.ScrollContainer minWidth={640}>
                        <Table verticalSpacing="sm" highlightOnHover>
                            <Table.Thead>
                                <Table.Tr>
                                    <Table.Th>{t('leadInbox.col.contact', 'İletişim')}</Table.Th>
                                    <Table.Th>{t('leadInbox.col.form', 'Form')}</Table.Th>
                                    <Table.Th>{t('leadInbox.col.reason', 'Neden')}</Table.Th>
                                    <Table.Th>{t('leadInbox.col.age', 'Yaş')}</Table.Th>
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>{spamTableRows}</Table.Tbody>
                        </Table>
                    </Table.ScrollContainer>
                ) : (
                    <Table.ScrollContainer minWidth={720}>
                        <Table verticalSpacing="sm" highlightOnHover>
                            <Table.Thead>
                                <Table.Tr>
                                    <Table.Th>{t('leadInbox.col.who', 'Firma / Kişi')}</Table.Th>
                                    <Table.Th>{t('leadInbox.col.source', 'Kaynak')}</Table.Th>
                                    <Table.Th>{t('leadInbox.col.status', 'Durum')}</Table.Th>
                                    <Table.Th>{t('leadInbox.col.score', 'Skor')}</Table.Th>
                                    <Table.Th>{t('leadInbox.col.age', 'Yaş')}</Table.Th>
                                    <Table.Th>{t('leadInbox.col.action', 'İşlem')}</Table.Th>
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>{rows}</Table.Tbody>
                        </Table>
                    </Table.ScrollContainer>
                )}
            </Paper>

            {totalPages > 1 && (
                <Group justify="center" mt="md">
                    <Pagination value={page} onChange={setPage} total={totalPages} />
                </Group>
            )}

            <Stack gap={4} mt="md">
                <Text size="xs" c="dimmed">
                    {t('leadInbox.hint', 'Formlardan gelen leadler burada birikir. Belirsiz kimlikler İnceleme kuyruğuna düşer.')}
                </Text>
            </Stack>
        </Container>
    );
}
