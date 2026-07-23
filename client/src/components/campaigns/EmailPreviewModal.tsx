import { useQuery } from '@tanstack/react-query';
import { Modal, Stack, Group, Text, Divider, Paper, Loader, Center, Badge } from '@mantine/core';
import { IconMail } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import type { EnrollmentMessagePreview } from '../../types/campaign';

interface Props {
    campaignId: string;
    enrollmentId: string | null; // null = kapalı
    stepId?: string; // hangi adımın maili önizlensin (verilmezse mevcut adım)
    onClose: () => void;
}

// Bir alıcının gönderilecek mailini birebir gösterir (konu + gövde HTML).
// Backend, motorun gönderim mantığıyla aynı çözümlemeyi yapar (custom_body_text
// varsa o, yoksa adım şablonu). Takip pikseli + abonelikten-çık gönderimde eklenir.
export default function EmailPreviewModal({ campaignId, enrollmentId, stepId, onClose }: Props) {
    const { t } = useTranslation();

    const { data, isFetching } = useQuery<EnrollmentMessagePreview>({
        queryKey: ['enrollment-preview', campaignId, enrollmentId, stepId],
        queryFn: async () => (await api.get(`/campaigns/${campaignId}/enrollments/${enrollmentId}/preview`, {
            params: stepId ? { step_id: stepId } : undefined,
        })).data,
        enabled: !!enrollmentId,
    });

    return (
        <Modal
            opened={!!enrollmentId} onClose={onClose} size="lg" radius="lg" centered
            title={
                <Group gap="xs">
                    <IconMail size={18} color="var(--mantine-color-violet-6)" />
                    <Text fw={600}>{t('campaign.audience.previewTitle', 'Email preview')}</Text>
                </Group>
            }
            overlayProps={{ backgroundOpacity: 0.4, blur: 4 }}
        >
            {isFetching || !data ? (
                <Center py="xl"><Loader color="violet" /></Center>
            ) : (
                <Stack gap="sm">
                    <Group gap="xs" wrap="nowrap">
                        <Text size="xs" c="dimmed" w={56}>{t('campaign.audience.previewTo', 'To')}:</Text>
                        <Text size="sm">{data.to}</Text>
                        {data.has_custom
                            ? <Badge size="xs" variant="light" color="grape">{t('campaign.audience.previewCustom', 'From CSV')}</Badge>
                            : <Badge size="xs" variant="light" color="gray">{t('campaign.audience.previewTemplate', 'From template')}</Badge>}
                    </Group>
                    <Group gap="xs" wrap="nowrap" align="flex-start">
                        <Text size="xs" c="dimmed" w={56}>{t('campaign.subject', 'Subject')}:</Text>
                        <Text size="sm" fw={600}>{data.subject || '—'}</Text>
                    </Group>
                    <Divider />
                    <Paper withBorder radius="md" p="md" style={{ maxHeight: 420, overflow: 'auto' }}>
                        {data.body_html
                            ? <div style={{ fontSize: 14, lineHeight: 1.55 }} dangerouslySetInnerHTML={{ __html: data.body_html }} />
                            : <Text size="sm" c="dimmed" fs="italic">{t('campaign.audience.previewEmpty', 'This recipient has no message body.')}</Text>}
                    </Paper>
                    <Text size="xs" c="dimmed">
                        {t('campaign.audience.previewNote', 'Tracking pixel and unsubscribe footer are added automatically when sent.')}
                    </Text>
                </Stack>
            )}
        </Modal>
    );
}
