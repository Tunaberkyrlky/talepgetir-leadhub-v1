import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
    Stack, Group, Text, Title, Button, Table, TextInput, Badge, ActionIcon,
    Loader, Center, Tooltip,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconShieldOff, IconSearch, IconTrash, IconPlus } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showSuccess, showInfo, showErrorFromApi } from '../../lib/notifications';

interface Suppression {
    id: string;
    email: string;
    reason: 'hard_bounce' | 'unsubscribe' | 'manual' | 'complaint';
    source_campaign_id: string | null;
    created_at: string;
}

const REASON_COLORS: Record<string, string> = {
    hard_bounce: 'red',
    unsubscribe: 'gray',
    manual: 'blue',
    complaint: 'orange',
};

export default function SuppressionsPanel() {
    const { t, i18n } = useTranslation();
    const qc = useQueryClient();
    const [search, setSearch] = useState('');
    const [debounced] = useDebouncedValue(search, 300);
    const [newEmail, setNewEmail] = useState('');

    const { data, isLoading } = useQuery<Suppression[]>({
        queryKey: ['suppressions', debounced],
        queryFn: async () => {
            const r = await api.get('/settings/suppressions', {
                params: debounced ? { search: debounced } : undefined,
            });
            return r.data.data;
        },
    });

    const addMut = useMutation<{ added: boolean }, unknown, string>({
        mutationFn: async (email: string) => {
            const r = await api.post('/settings/suppressions', { email, reason: 'manual' });
            return r.data.data;
        },
        onSuccess: (res) => {
            if (res.added) showSuccess(t('suppression.added', 'Adres bastırma listesine eklendi'));
            else showInfo(t('suppression.alreadyExists', 'Bu adres zaten listede'));
            setNewEmail('');
            qc.invalidateQueries({ queryKey: ['suppressions'] });
        },
        onError: (err) => showErrorFromApi(err),
    });

    const removeMut = useMutation<unknown, unknown, string>({
        mutationFn: async (id: string) => { await api.delete(`/settings/suppressions/${id}`); },
        onSuccess: () => {
            showSuccess(t('suppression.removed', 'Adres listeden kaldırıldı'));
            qc.invalidateQueries({ queryKey: ['suppressions'] });
        },
        onError: (err) => showErrorFromApi(err),
    });

    const reasonLabel = (r: string) => t(`suppression.reason.${r}`, r);
    const fmtDate = (iso: string) =>
        new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' }).format(new Date(iso));

    const rows = data || [];

    return (
        <Stack gap="md">
            <Group gap="xs">
                <IconShieldOff size={20} color="var(--mantine-color-red-6)" />
                <Title order={5} fw={600}>{t('suppression.title', 'Bastırma Listesi')}</Title>
            </Group>

            <Text size="xs" c="dimmed">
                {t('suppression.desc', 'Bu adreslere kampanya gönderimi yapılmaz. Sert sekme (hard bounce), abonelikten çıkma ve şikayetler otomatik eklenir; buradan manuel de ekleyebilir veya kaldırabilirsiniz.')}
            </Text>

            {/* Manuel ekleme */}
            <Group gap="xs" align="flex-end">
                <TextInput
                    flex={1}
                    label={t('suppression.addLabel', 'Adres ekle')}
                    placeholder="ornek@firma.com"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.currentTarget.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && newEmail.trim()) addMut.mutate(newEmail.trim()); }}
                />
                <Button
                    leftSection={<IconPlus size={16} />}
                    color="red"
                    variant="light"
                    onClick={() => addMut.mutate(newEmail.trim())}
                    disabled={!newEmail.trim()}
                    loading={addMut.isPending}
                >
                    {t('common.add', 'Ekle')}
                </Button>
            </Group>

            {/* Arama */}
            <TextInput
                leftSection={<IconSearch size={16} />}
                placeholder={t('suppression.searchPlaceholder', 'Adrese göre ara')}
                value={search}
                onChange={(e) => setSearch(e.currentTarget.value)}
            />

            {isLoading ? (
                <Center py="md"><Loader size="sm" color="red" /></Center>
            ) : rows.length === 0 ? (
                <Text size="sm" c="dimmed" ta="center" py="md">
                    {t('suppression.empty', 'Bastırma listesi boş.')}
                </Text>
            ) : (
                <Table.ScrollContainer minWidth={420}>
                    <Table verticalSpacing="xs" horizontalSpacing="sm" highlightOnHover>
                        <Table.Thead>
                            <Table.Tr>
                                <Table.Th>{t('suppression.colEmail', 'Adres')}</Table.Th>
                                <Table.Th>{t('suppression.colReason', 'Neden')}</Table.Th>
                                <Table.Th>{t('suppression.colDate', 'Eklendi')}</Table.Th>
                                <Table.Th />
                            </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                            {rows.map((s) => (
                                <Table.Tr key={s.id}>
                                    <Table.Td><Text size="sm">{s.email}</Text></Table.Td>
                                    <Table.Td>
                                        <Badge size="xs" variant="light" color={REASON_COLORS[s.reason] || 'gray'}>
                                            {reasonLabel(s.reason)}
                                        </Badge>
                                    </Table.Td>
                                    <Table.Td><Text size="xs" c="dimmed">{fmtDate(s.created_at)}</Text></Table.Td>
                                    <Table.Td>
                                        <Tooltip label={t('suppression.remove', 'Kaldır')} withArrow>
                                            <ActionIcon
                                                variant="subtle" color="gray" size="sm"
                                                onClick={() => removeMut.mutate(s.id)}
                                                loading={removeMut.isPending && removeMut.variables === s.id}
                                                aria-label={t('suppression.remove', 'Kaldır')}
                                            >
                                                <IconTrash size={16} />
                                            </ActionIcon>
                                        </Tooltip>
                                    </Table.Td>
                                </Table.Tr>
                            ))}
                        </Table.Tbody>
                    </Table>
                </Table.ScrollContainer>
            )}
        </Stack>
    );
}
