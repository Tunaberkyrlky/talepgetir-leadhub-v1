import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Stack, Group, Text, Badge, Paper, ScrollArea, Loader, Center, TextInput, UnstyledButton } from '@mantine/core';
import { IconSearch, IconMessage2, IconChevronRight, IconFileImport } from '@tabler/icons-react';
import { useDebouncedValue } from '@mantine/hooks';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import EmailPreviewModal from './EmailPreviewModal';
import { EMAIL_STATUS_COLORS } from './emailStatusColors';
import type { Enrollment } from '../../types/campaign';

const STATUS_COLORS: Record<string, string> = {
    active: 'blue', completed: 'green', replied: 'violet', paused: 'yellow', bounced: 'red', unsubscribed: 'gray',
};

interface Props {
    campaignId: string;
}

// Dizi sekmesinde CSV kampanyasının email adımının gövde slotunu doldurur:
// gövde boş çünkü her alıcının mesajı CSV'den geliyor. Bu panel "bu adımda kime
// ne gidecek"i gösterir — alıcı listesi + tıkla-önizle. Yönetim (durdur/çıkar)
// Kitle sekmesinde; burası salt-okunur "gidecek mailler" görünümü.
export default function CampaignStepRecipients({ campaignId }: Props) {
    const { t } = useTranslation();
    const [search, setSearch] = useState('');
    const [debSearch] = useDebouncedValue(search, 250);
    const [previewId, setPreviewId] = useState<string | null>(null);

    const { data: enrollments, isLoading } = useQuery<Enrollment[]>({
        queryKey: ['campaign-enrollments', campaignId],
        queryFn: async () => (await api.get(`/campaigns/${campaignId}/enrollments`)).data.data,
    });

    const rows = (enrollments || []).filter((e) => {
        if (!debSearch) return true;
        const q = debSearch.toLowerCase();
        return `${e.contact_name} ${e.email} ${e.company_name} ${e.message_snippet || ''}`.toLowerCase().includes(q);
    });

    const statusLabel = (s: string) => t(`campaign.audience.status.${s}`, s);

    return (
        <Stack gap="sm">
            <Paper p="xs" radius="md" bg="grape.0">
                <Group gap="xs" wrap="nowrap">
                    <IconFileImport size={16} color="var(--mantine-color-grape-6)" />
                    <Text size="xs" c="grape.9">
                        {t('campaign.editor.csvBodyNote', 'This step\'s body comes per recipient from your CSV import. Click a recipient to preview the exact email.')}
                    </Text>
                </Group>
            </Paper>

            <Group justify="space-between" wrap="wrap" gap="xs">
                <Text size="sm" fw={600}>
                    {t('campaign.editor.csvRecipients', 'Recipient emails')}
                    {enrollments && <Text span c="dimmed" fw={400}> ({rows.length})</Text>}
                </Text>
                {enrollments && enrollments.length > 6 && (
                    <TextInput size="xs" radius="md" w={200} leftSection={<IconSearch size={13} />}
                        placeholder={t('campaign.audience.searchEnrolled', 'Search...')}
                        value={search} onChange={(e) => setSearch(e.currentTarget.value)} />
                )}
            </Group>

            {isLoading ? (
                <Center py="xl"><Loader size="sm" color="violet" /></Center>
            ) : rows.length === 0 ? (
                <Text size="sm" c="dimmed" ta="center" py="md">
                    {debSearch ? t('campaign.audience.noEnrolledMatch', 'No matches.') : t('campaign.audience.noneEnrolled', 'No recipients yet.')}
                </Text>
            ) : (
                <ScrollArea.Autosize mah={440}>
                    <Stack gap={6}>
                        {rows.map((e) => (
                            <UnstyledButton key={e.id} onClick={() => setPreviewId(e.id)} style={{ display: 'block' }}>
                                <Paper withBorder radius="md" p="xs">
                                    <Group justify="space-between" wrap="nowrap" gap="sm">
                                        <div style={{ minWidth: 0, flex: 1 }}>
                                            <Group gap={6} wrap="nowrap">
                                                <Text size="sm" fw={500} truncate>{e.company_name || e.email}</Text>
                                                {e.email_status && (
                                                    <Badge size="xs" variant="light" color={EMAIL_STATUS_COLORS[e.email_status] || 'gray'}>{e.email_status}</Badge>
                                                )}
                                                <Badge size="xs" variant="light" color={STATUS_COLORS[e.status] || 'gray'}>{statusLabel(e.status)}</Badge>
                                            </Group>
                                            <Text size="xs" c="dimmed" truncate>{e.email}</Text>
                                            {e.message_snippet && (
                                                <Group gap={4} wrap="nowrap" mt={2}>
                                                    <IconMessage2 size={12} color="var(--mantine-color-grape-5)" style={{ flexShrink: 0 }} />
                                                    <Text size="xs" c="dimmed" truncate fs="italic">{e.message_snippet}…</Text>
                                                </Group>
                                            )}
                                        </div>
                                        <IconChevronRight size={16} color="var(--mantine-color-gray-5)" style={{ flexShrink: 0 }} />
                                    </Group>
                                </Paper>
                            </UnstyledButton>
                        ))}
                    </Stack>
                </ScrollArea.Autosize>
            )}

            <EmailPreviewModal campaignId={campaignId} enrollmentId={previewId} onClose={() => setPreviewId(null)} />
        </Stack>
    );
}
