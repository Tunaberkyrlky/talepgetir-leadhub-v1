/**
 * Firma detayındaki "Firsatlar" bölümü — firmanın firsatlarını kompakt satırlarda
 * özetler, satıra tıklayınca DealDrawer açılır. Firsat yoksa firma stage'inden
 * ilk-firsat oluşturma CTA'sı sunar (v2 §8 uyumu). Kendi içinde bağımsız tek blok.
 */
import { useState } from 'react';
import {
    Alert,
    Badge,
    Button,
    Group,
    Paper,
    Skeleton,
    Stack,
    Text,
    ThemeIcon,
    Title,
    UnstyledButton,
} from '@mantine/core';
import { IconChevronRight, IconPlus, IconTargetArrow } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { useAuth } from '../../contexts/AuthContext';
import { useStages } from '../../contexts/StagesContext';
import type { Deal, DealsResponse } from '../../types/deal';
import DealFormModal from './DealFormModal';
import DealDrawer from './DealDrawer';

interface DealsSectionContact {
    id: string;
    first_name: string;
    last_name?: string | null;
}

interface DealsSectionProps {
    companyId: string;
    // Firma stage slug'ı — ilk-firsat CTA'sında ön-doldurulur.
    companyStage: string;
    contacts?: DealsSectionContact[];
    canEdit: boolean;
}

function statusColor(status: Deal['status']): string {
    if (status === 'won') return 'green';
    if (status === 'lost') return 'red';
    return 'blue';
}

export default function DealsSection({ companyId, companyStage, contacts = [], canEdit }: DealsSectionProps) {
    const { t, i18n } = useTranslation();
    const { activeTenantId } = useAuth();
    const { getStageColor, getStageLabel } = useStages();
    const [formOpen, setFormOpen] = useState(false);
    const [prefillStage, setPrefillStage] = useState<string | undefined>(undefined);
    const [selectedDealId, setSelectedDealId] = useState<string | null>(null);

    const { data, isLoading, isError } = useQuery<DealsResponse>({
        // Tenant-scoped key + pinned header so a tenant switch never surfaces another tenant's deals.
        queryKey: ['deals', activeTenantId, 'company', companyId],
        queryFn: async ({ queryKey, signal }) => {
            const tid = queryKey[1] as string;
            return (await api.get('/deals', {
                params: { company_id: companyId, limit: '100' },
                headers: { 'X-Tenant-Id': tid },
                signal,
            })).data;
        },
        enabled: !!companyId && !!activeTenantId,
    });

    const deals = data?.data || [];
    const locale = i18n.language === 'en' ? 'en-US' : 'tr-TR';

    const openCreate = (stageSlug?: string) => {
        setPrefillStage(stageSlug);
        setFormOpen(true);
    };

    return (
        <Paper shadow="sm" radius="lg" p="lg" withBorder mb="lg">
            <Group justify="space-between" align="center" mb={deals.length > 0 || isLoading ? 'md' : 0}>
                <Group gap="sm">
                    <ThemeIcon variant="light" color="violet" radius="md" size="lg">
                        <IconTargetArrow size={20} />
                    </ThemeIcon>
                    <div>
                        <Title order={4} fw={650}>{t('deals.sectionTitle', 'Firsatlar')}</Title>
                        <Text size="xs" c="dimmed">{t('deals.sectionSubtitle', 'Bu firmadaki açık ve kapanmış firsatlar')}</Text>
                    </div>
                    {deals.length > 0 && (
                        <Badge variant="light" color="violet" radius="xl">{deals.length}</Badge>
                    )}
                </Group>

                {canEdit && deals.length > 0 && (
                    <Button
                        size="sm"
                        variant="light"
                        color="violet"
                        leftSection={<IconPlus size={16} />}
                        onClick={() => openCreate()}
                    >
                        {t('deals.add', 'Firsat ekle')}
                    </Button>
                )}
            </Group>

            {isLoading ? (
                <Stack gap="xs">
                    <Skeleton height={52} radius="md" />
                    <Skeleton height={52} radius="md" />
                </Stack>
            ) : isError ? (
                <Alert color="red" variant="light">{t('deals.loadError', 'Firsatlar yüklenemedi')}</Alert>
            ) : deals.length === 0 ? (
                <Stack gap="sm" align="flex-start" mt="md">
                    <div>
                        <Text size="sm" fw={600}>{t('deals.emptyTitle', 'Henüz firsat yok')}</Text>
                        <Text size="sm" c="dimmed">
                            {t('deals.emptyDescription', 'Bu firmanın mevcut aşamasından ilk firsatı oluşturarak satış sürecini başlatın.')}
                        </Text>
                    </div>
                    {canEdit && (
                        <Group gap="xs">
                            <Button
                                size="sm"
                                variant="filled"
                                color="violet"
                                leftSection={<IconPlus size={16} />}
                                onClick={() => openCreate(companyStage)}
                            >
                                {t('deals.createFromStage', 'Firma aşamasından firsat oluştur')}
                            </Button>
                            <Button size="sm" variant="subtle" color="violet" onClick={() => openCreate()}>
                                {t('deals.createBlank', 'Boş firsat')}
                            </Button>
                        </Group>
                    )}
                </Stack>
            ) : (
                <Stack gap="xs">
                    {deals.map((deal) => (
                        <UnstyledButton
                            key={deal.id}
                            onClick={() => setSelectedDealId(deal.id)}
                            style={{ display: 'block', width: '100%' }}
                        >
                            <Paper withBorder p="sm" radius="md" style={{ cursor: 'pointer' }}>
                                <Group justify="space-between" wrap="nowrap" align="center">
                                    <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                                        <Stack gap={4} style={{ minWidth: 0 }}>
                                            <Group gap="xs" wrap="wrap">
                                                <Text size="sm" fw={600} lineClamp={1}>{deal.title}</Text>
                                                <Badge size="xs" variant="light" color={getStageColor(deal.stage)} radius="sm">
                                                    {getStageLabel(deal.stage)}
                                                </Badge>
                                                <Badge size="xs" variant="filled" color={statusColor(deal.status)} radius="sm">
                                                    {t(`deals.status.${deal.status}`, deal.status)}
                                                </Badge>
                                            </Group>
                                            <Group gap="xs" wrap="wrap">
                                                {deal.amount != null && (
                                                    <Text size="xs" c="dimmed">{deal.amount.toLocaleString(locale)} {deal.currency}</Text>
                                                )}
                                                {deal.expected_close && (
                                                    <Text size="xs" c="dimmed">
                                                        · {new Date(`${deal.expected_close}T00:00:00`).toLocaleDateString(locale, { day: '2-digit', month: 'short', year: 'numeric' })}
                                                    </Text>
                                                )}
                                                {deal.owner_user && (
                                                    <Text size="xs" c="dimmed">· {deal.owner_user.name || deal.owner_user.email}</Text>
                                                )}
                                            </Group>
                                        </Stack>
                                    </Group>
                                    <IconChevronRight size={16} color="var(--mantine-color-gray-5)" />
                                </Group>
                            </Paper>
                        </UnstyledButton>
                    ))}
                </Stack>
            )}

            <DealFormModal
                opened={formOpen}
                onClose={() => setFormOpen(false)}
                companyId={companyId}
                contacts={contacts}
                initialStageSlug={prefillStage}
            />

            <DealDrawer
                dealId={selectedDealId}
                onClose={() => setSelectedDealId(null)}
                companyId={companyId}
                contacts={contacts}
                canEdit={canEdit}
            />
        </Paper>
    );
}
