import { SimpleGrid, Center, Loader, Alert, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import TenantOverviewCard, { type OpsTenantOverview } from './TenantOverviewCard';

interface OpsOverviewResponse {
    tenants: OpsTenantOverview[];
    generatedAt: string;
}

export default function OpsOverviewTab() {
    const { t } = useTranslation();
    const { data, isLoading, error } = useQuery<OpsOverviewResponse>({
        queryKey: ['ops', 'overview'],
        queryFn: async () => (await api.get('/ops/overview')).data,
        refetchInterval: 60_000,
    });

    if (isLoading) {
        return (
            <Center py="xl">
                <Loader />
            </Center>
        );
    }
    if (error || !data) {
        return (
            <Alert color="red" mt="md">
                {t('ops.loadError')}
            </Alert>
        );
    }
    if (data.tenants.length === 0) {
        return (
            <Text c="dimmed" mt="md">
                {t('ops.overview.empty')}
            </Text>
        );
    }

    return (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} mt="md">
            {data.tenants.map((tenant) => (
                <TenantOverviewCard key={tenant.id} tenant={tenant} />
            ))}
        </SimpleGrid>
    );
}
