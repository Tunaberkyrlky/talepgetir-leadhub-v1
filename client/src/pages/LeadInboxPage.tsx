import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
    ActionIcon,
    Anchor,
    Badge,
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
import { IconInbox, IconAlertTriangle, IconSearch, IconExternalLink, IconAlertCircle } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import type { Lead, LeadsResponse } from '../types/lead';

type InboxTab = 'new' | 'review' | 'error';

// Inbox queue → lifecycle_status filter sent to the API.
const TAB_LIFECYCLE: Record<InboxTab, string> = {
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

    const [activeTab, setActiveTab] = useState<InboxTab>('new');
    const [page, setPage] = useState(1);

    // Scope the cache to the active tenant so a tenant switch can't surface stale
    // rows, and don't fetch until a tenant is resolved.
    const { data, isLoading, isError } = useQuery<LeadsResponse>({
        queryKey: ['leads', activeTenantId, activeTab, page],
        enabled: !!activeTenantId,
        queryFn: async () => {
            const res = await api.get('/leads', {
                params: { lifecycle: TAB_LIFECYCLE[activeTab], page, limit: PAGE_LIMIT },
            });
            return res.data as LeadsResponse;
        },
        refetchInterval: 30_000,
    });

    const leads = data?.data ?? [];
    const totalPages = data?.pagination.totalPages ?? 1;

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
                        <Text size="xs" c="dimmed">{lead.review_reason}</Text>
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
                        <Tooltip label={lead.review_reason || t('leadInbox.noLinkedRecord', 'Bağlı kayıt yok')}>
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
                    <Tabs.Tab value="error" leftSection={<IconAlertTriangle size={16} />}>
                        {t('leadInbox.tabs.error', 'Hata')}
                    </Tabs.Tab>
                </Tabs.List>
            </Tabs>

            <Paper withBorder radius="md">
                {isLoading ? (
                    <Center py="xl"><Loader /></Center>
                ) : isError ? (
                    <Center py="xl"><Text c="red">{t('leadInbox.loadError', 'Lead listesi yüklenemedi')}</Text></Center>
                ) : leads.length === 0 ? (
                    <Center py="xl"><Text c="dimmed">{t('leadInbox.empty', 'Bu kuyrukta lead yok')}</Text></Center>
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
