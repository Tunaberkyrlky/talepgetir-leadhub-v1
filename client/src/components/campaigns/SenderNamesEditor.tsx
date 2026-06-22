import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Stack, Group, Text, TextInput, Loader, Center } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showErrorFromApi } from '../../lib/notifications';

// Gönderen adı kutuya aittir ve tüm kampanyalarda ortaktır (tenant.settings.sender_names).
// Bu editör bağlı tüm kutuları listeler; isimler onBlur'da kaydedilir.
export default function SenderNamesEditor({ readOnly }: { readOnly?: boolean }) {
    const { t } = useTranslation();
    const qc = useQueryClient();

    const { data: connData, isLoading } = useQuery<{ connections?: { email_address: string }[] }>({
        queryKey: ['email-connections-status'],
        queryFn: async () => (await api.get('/email-connections/status')).data,
        staleTime: 5 * 60_000,
    });
    const { data: saved } = useQuery<Record<string, string>>({
        queryKey: ['sender-names'],
        queryFn: async () => (await api.get('/settings/sender-names')).data.data,
        staleTime: 5 * 60_000,
    });

    // Kaydedilen değerlerin üzerine yerel düzenlemeleri bindiririz (effect'siz).
    const [edits, setEdits] = useState<Record<string, string>>({});
    const merged = { ...(saved || {}), ...edits };

    const saveMut = useMutation({
        mutationFn: (m: Record<string, string>) => api.put('/settings/sender-names', { names: m }),
        onSuccess: () => qc.invalidateQueries({ queryKey: ['sender-names'] }),
        onError: (err) => showErrorFromApi(err),
    });

    const connections = connData?.connections || [];
    if (isLoading) return <Center py="sm"><Loader size="xs" color="violet" /></Center>;
    if (connections.length === 0) return null;

    return (
        <Stack gap={6} mt="md">
            <Text size="xs" fw={600} c="dimmed">{t('campaign.settings.senderNames', 'Sender name per mailbox')}</Text>
            {connections.map((c) => {
                const key = c.email_address.toLowerCase();
                return (
                    <Group key={key} gap="sm" wrap="nowrap">
                        <Text size="xs" c="dimmed" style={{ flex: '0 0 42%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {c.email_address}
                        </Text>
                        <TextInput size="xs" radius="md" style={{ flex: 1 }}
                            placeholder={t('campaign.settings.senderNamePlaceholder', 'e.g. John Doe')}
                            value={merged[key] || ''}
                            onChange={(e) => { const v = e.currentTarget.value; setEdits((x) => ({ ...x, [key]: v })); }}
                            onBlur={() => saveMut.mutate(merged)}
                            disabled={readOnly}
                        />
                    </Group>
                );
            })}
            <Text size="xs" c="dimmed">{t('campaign.settings.senderNamesHint', 'These names apply across all campaigns.')}</Text>
        </Stack>
    );
}
