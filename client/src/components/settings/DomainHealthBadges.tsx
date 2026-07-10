import { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { Group, Badge, Text, ActionIcon, Tooltip, Loader } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { statusColor } from '../../lib/domainHealthUtils';
import type { DomainHealthResponse } from '../../types/campaign';
import DomainHealthModal from './DomainHealthModal';

interface DomainHealthBadgesProps {
    connectionId: string;
}

export default function DomainHealthBadges({ connectionId }: DomainHealthBadgesProps) {
    const { t } = useTranslation();
    const qc = useQueryClient();
    const [modalOpen, setModalOpen] = useState(false);

    const queryKey = ['domain-health', connectionId];

    const { data, isLoading, isFetching } = useQuery<DomainHealthResponse>({
        queryKey,
        queryFn: async () => {
            const r = await api.get(`/email-connections/${connectionId}/domain-health`);
            return r.data;
        },
        staleTime: 5 * 60 * 1000,
        retry: false,
    });

    const refreshMut = useMutation<DomainHealthResponse>({
        mutationFn: async () => {
            const r = await api.get(`/email-connections/${connectionId}/domain-health`, { params: { refresh: 'true' } });
            return r.data;
        },
        onSuccess: (fresh) => qc.setQueryData(queryKey, fresh),
    });

    if (isLoading) {
        return (
            <Group gap={6}>
                <Loader size={12} />
                <Text size="xs" c="dimmed">{t('campaign.domainHealth.checking', 'Domain kontrol ediliyor...')}</Text>
            </Group>
        );
    }

    if (!data) return null;

    if (data.managed) {
        return (
            <Text size="xs" c="dimmed">
                {t('campaign.domainHealth.managedByProvider', 'Bu alan adı sağlayıcı tarafından yönetiliyor')} ({data.provider})
            </Text>
        );
    }

    const { checks } = data;

    return (
        <>
            <Group gap={6} wrap="nowrap">
                <Badge size="xs" variant="light" color={statusColor(checks.mx.status)}>MX</Badge>
                <Badge size="xs" variant="light" color={statusColor(checks.spf.status)}>SPF</Badge>
                <Badge size="xs" variant="light" color={statusColor(checks.dkim.status)}>DKIM</Badge>
                <Badge size="xs" variant="light" color={statusColor(checks.dmarc.status)}>DMARC</Badge>
                <Tooltip label={t('campaign.domainHealth.viewDetails', 'Detayları gör')}>
                    <ActionIcon variant="subtle" color="gray" size="sm" onClick={() => setModalOpen(true)} loading={isFetching}>
                        <IconInfoCircle size={14} />
                    </ActionIcon>
                </Tooltip>
            </Group>

            <DomainHealthModal
                opened={modalOpen}
                onClose={() => setModalOpen(false)}
                result={data}
                onRefresh={() => refreshMut.mutate()}
                refreshing={refreshMut.isPending}
            />
        </>
    );
}
