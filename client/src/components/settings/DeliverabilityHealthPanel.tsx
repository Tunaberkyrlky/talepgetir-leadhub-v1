import { useQuery } from '@tanstack/react-query';
import { Paper, Group, Stack, Text, Title, Badge, Alert } from '@mantine/core';
import { IconActivity, IconAlertCircle } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { useAuth } from '../../contexts/AuthContext';

// Mirror of the server DeliverabilityHealth DTO (server/src/lib/mail/deliverabilityHealth.ts).
// Kept inline to avoid editing the shared types/campaign.ts.
type TrafficLight = 'green' | 'yellow' | 'red';
type DnsStatus = 'pass' | 'fail' | 'unknown';

interface DeliverabilityHealthItem {
    email: string;
    provider: string;
    is_active: boolean;
    last_verified_at: string | null;
    last_verify_ok: boolean | null;
    last_polled_at: string | null;
    traffic_light: TrafficLight;
    reasons: string[];
    dns: { spf: DnsStatus; dkim: DnsStatus; dmarc: DnsStatus };
    daily_volume: number | null;
    bounce_rate: number | null;
}

interface HealthResponse {
    identities: DeliverabilityHealthItem[];
}

const LIGHT_COLOR: Record<TrafficLight, string> = { green: 'green', yellow: 'yellow', red: 'red' };

export default function DeliverabilityHealthPanel() {
    const { t } = useTranslation();
    const { activeTenantId } = useAuth();

    const { data, isLoading, isError } = useQuery<HealthResponse>({
        // Tenant-scoped key so switching tenants (internal roles switch via X-Tenant-Id) refetches
        // and never shows a previous tenant's cached identities; enabled guards a no-tenant query.
        queryKey: ['deliverability-health', activeTenantId],
        queryFn: async ({ queryKey, signal }) => {
            // Pin the tenant to the KEY being fetched (not the mutable localStorage/closure): a
            // refetch of a stale key after a tenant switch then targets the right tenant, so tenant
            // B's data can never be cached under tenant A's key. The interceptor preserves this header.
            const tid = queryKey[1] as string;
            const r = await api.get('/email-connections/health', { headers: { 'X-Tenant-Id': tid }, signal });
            return r.data;
        },
        enabled: !!activeTenantId,
    });

    const identities = data?.identities ?? [];

    return (
        <Paper shadow="sm" radius="lg" p="xl" withBorder>
            <Stack gap="lg">
                <Group gap="xs">
                    <IconActivity size={20} color="var(--mantine-color-violet-6)" />
                    <Title order={4} fw={600}>{t('deliverability.title', 'Teslim Edilebilirlik Sağlığı')}</Title>
                </Group>

                <Text size="sm" c="dimmed">
                    {t('deliverability.description', 'Bağlı gönderen kutularınızın durumunu tek bakışta görün. Bu panel yalnızca gösterir, değişiklik yapmaz.')}
                </Text>

                {isLoading && (
                    <Text size="xs" c="dimmed">{t('deliverability.loading', 'Yükleniyor…')}</Text>
                )}

                {isError && (
                    <Alert variant="light" color="red" icon={<IconAlertCircle size={16} />}>
                        <Text size="xs">{t('deliverability.loadError', 'Sağlık bilgisi yüklenemedi.')}</Text>
                    </Alert>
                )}

                {!isLoading && !isError && identities.length === 0 && (
                    <Alert variant="light" color="blue" icon={<IconAlertCircle size={16} />}>
                        <Text size="xs">{t('deliverability.emptyState', 'Henüz bağlı gönderen kutusu yok.')}</Text>
                    </Alert>
                )}

                {!isLoading && !isError && identities.length > 0 && (
                    <Stack gap="xs">
                        {identities.map((h) => (
                            <Paper key={h.email} p="sm" radius="md" withBorder bg="gray.0">
                                <Stack gap={6}>
                                    <Group justify="space-between" wrap="nowrap">
                                        <div style={{ minWidth: 0 }}>
                                            <Text size="sm" fw={600} truncate>{h.email}</Text>
                                            <Text size="xs" c="dimmed">{h.provider}</Text>
                                        </div>
                                        <Badge color={LIGHT_COLOR[h.traffic_light]} variant="light" size="sm">
                                            {t(`deliverability.status.${h.traffic_light}`, h.traffic_light)}
                                        </Badge>
                                    </Group>

                                    {/* Reason keys resolved to locale prose here (server sends KEYS only). */}
                                    {h.reasons.length > 0 && (
                                        <Text size="xs" c="dimmed">
                                            {h.reasons.map((r) => t(`deliverability.reason.${r}`, r)).join(' · ')}
                                        </Text>
                                    )}

                                    {/* DNS is an env-gated stub this slice: always 'unknown', shown dimmed. */}
                                    <Group gap={6}>
                                        <Badge size="xs" variant="outline" color="gray">
                                            {t('deliverability.dnsSpf', 'SPF')}: {t(`deliverability.dns.${h.dns.spf}`, h.dns.spf)}
                                        </Badge>
                                        <Badge size="xs" variant="outline" color="gray">
                                            {t('deliverability.dnsDkim', 'DKIM')}: {t(`deliverability.dns.${h.dns.dkim}`, h.dns.dkim)}
                                        </Badge>
                                        <Badge size="xs" variant="outline" color="gray">
                                            {t('deliverability.dnsDmarc', 'DMARC')}: {t(`deliverability.dns.${h.dns.dmarc}`, h.dns.dmarc)}
                                        </Badge>
                                    </Group>
                                </Stack>
                            </Paper>
                        ))}
                    </Stack>
                )}
            </Stack>
        </Paper>
    );
}
