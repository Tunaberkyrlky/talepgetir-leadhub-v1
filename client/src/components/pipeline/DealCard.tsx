import { Paper, Text, Group, Badge, Stack, Avatar, Tooltip } from '@mantine/core';
import { IconUser, IconCalendar, IconBuilding } from '@tabler/icons-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { getOwnerInitials } from '../../lib/pipelineSignals';
import type { Deal } from '../../types/deal';

interface DealCardProps {
    deal: Deal;
    isDragEnabled: boolean;
}

/** Format amount + currency; falls back to a plain "value CUR" if the ISO code
 *  is not one the runtime's Intl can render as a currency. */
function formatAmount(amount: number | null, currency: string): string | null {
    if (amount === null || amount === undefined) return null;
    try {
        return new Intl.NumberFormat(undefined, {
            style: 'currency',
            currency,
            maximumFractionDigits: 0,
        }).format(amount);
    } catch {
        return `${new Intl.NumberFormat().format(amount)} ${currency}`;
    }
}

/** Short "12 Jul 2026"-style expected-close date. */
function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function DealCard({ deal, isDragEnabled }: DealCardProps) {
    const { t } = useTranslation();
    const navigate = useNavigate();

    const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
        id: deal.id,
        data: { deal },
        disabled: !isDragEnabled,
    });

    const style = {
        transform: CSS.Translate.toString(transform),
        opacity: isDragging ? 0.5 : 1,
        cursor: isDragEnabled ? 'grab' : 'pointer',
    };

    const owner = deal.owner_user;
    const amountLabel = formatAmount(deal.amount, deal.currency);

    return (
        <Paper
            ref={setNodeRef}
            style={style}
            {...(isDragEnabled ? { ...listeners, ...attributes } : {})}
            shadow="xs"
            radius="md"
            p="sm"
            withBorder
            // E2 DealDrawer is not merged yet — click navigates to the company detail
            // as a placeholder; rewire to the drawer once E2 lands.
            onClick={() => {
                if (!isDragging) navigate(`/companies/${deal.company_id}`);
            }}
            styles={{
                root: {
                    transition: 'box-shadow 150ms ease',
                    '&:hover': { boxShadow: 'var(--mantine-shadow-md)' },
                    touchAction: isDragEnabled ? 'none' : 'auto',
                },
            }}
        >
            <Stack gap={6}>
                <Group justify="space-between" wrap="nowrap" gap={4}>
                    <Text size="sm" fw={600} lineClamp={1} style={{ flex: 1 }}>
                        {deal.title}
                    </Text>
                    <Badge size="xs" variant="light" color="green">
                        {t('dealPipeline.statusOpen')}
                    </Badge>
                </Group>

                {deal.company_name && (
                    <Group gap={4} wrap="nowrap">
                        <IconBuilding size={12} color="var(--mantine-color-dimmed)" />
                        <Text size="xs" c="dimmed" lineClamp={1}>
                            {deal.company_name}
                        </Text>
                    </Group>
                )}

                {amountLabel && (
                    <Text size="sm" fw={600} c="teal.6">
                        {amountLabel}
                    </Text>
                )}

                <Group justify="space-between" gap={4} wrap="nowrap">
                    <Tooltip label={owner ? (owner.name || owner.email) : t('dealPipeline.unassigned')} withArrow>
                        <Avatar size={20} radius="xl" variant="light" color={owner ? 'violet' : 'gray'}>
                            {owner ? (
                                <Text size="9px" fw={700}>{getOwnerInitials(owner.name, owner.email)}</Text>
                            ) : (
                                <IconUser size={11} />
                            )}
                        </Avatar>
                    </Tooltip>
                    {deal.expected_close && (
                        <Group gap={2} wrap="nowrap">
                            <IconCalendar size={12} color="var(--mantine-color-dimmed)" />
                            <Text size="xs" c="dimmed">{formatDate(deal.expected_close)}</Text>
                        </Group>
                    )}
                </Group>
            </Stack>
        </Paper>
    );
}
