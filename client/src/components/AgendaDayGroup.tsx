import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    Paper, Group, Text, Badge, Stack, ActionIcon, Menu, Collapse,
} from '@mantine/core';
import { IconChevronRight } from '@tabler/icons-react';
import {
    IconDotsVertical, IconPencil, IconTrash,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { ACTIVITY_ICONS, ACTIVITY_COLORS } from '../lib/activityConstants';
import { formatCountdown, getUrgency, URGENCY_COLORS } from '../lib/dateUtils';
import type { Activity } from '../types/activity';

interface AgendaCardProps {
    activity: Activity;
    locale: string;
    canEdit: boolean;
    canDeleteItem: boolean;
    onEdit: (a: Activity) => void;
    onDelete: (id: string) => void;
    compact?: boolean;
}

function AgendaCard({ activity, locale, canEdit, canDeleteItem, onEdit, onDelete, compact }: AgendaCardProps) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const color = ACTIVITY_COLORS[activity.type] || 'gray';
    const urgency = getUrgency(activity.occurred_at);
    const urgencyColor = URGENCY_COLORS[urgency];
    const countdown = formatCountdown(activity.occurred_at, locale);
    const isOverdue = urgency === 'overdue';

    const timeStr = new Date(activity.occurred_at).toLocaleTimeString(locale, {
        hour: '2-digit', minute: '2-digit',
    });

    const isStatusChange = activity.type === 'status_change';
    const isClosingReport = activity.type === 'sonlandirma_raporu';
    const isCampaignEmail = activity.type === 'campaign_email';
    const showMenu = !compact && ((canEdit && !isStatusChange && !isClosingReport && !isCampaignEmail) || canDeleteItem);

    return (
        <Paper
            p={compact ? 'xs' : 'sm'}
            radius="sm"
            withBorder
            className={`agenda-card ${isOverdue ? 'agenda-card--overdue' : ''}`}
            style={{ borderLeftColor: `var(--mantine-color-${urgencyColor}-5)` }}
        >
            <Group justify="space-between" wrap="nowrap" gap="xs">
                <Group gap={6} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
                    <Badge size="xs" variant="light" color={color} leftSection={ACTIVITY_ICONS[activity.type]}>
                        {t(`activity.types.${activity.type}`)}
                    </Badge>
                    <Text size="xs" fw={600} c={urgencyColor} style={{ whiteSpace: 'nowrap' }}>
                        {timeStr}
                    </Text>
                    <Text size="xs" fw={600} c={urgencyColor} style={{
                        whiteSpace: 'nowrap',
                        textDecoration: isOverdue ? 'line-through' : undefined,
                        opacity: isOverdue ? 0.7 : 1,
                    }}>
                        {countdown}
                    </Text>
                </Group>
                <Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
                    {activity.company_name && (
                        <Text
                            size="xs" c="blue" fw={500}
                            style={{ cursor: 'pointer', whiteSpace: 'nowrap' }}
                            onClick={() => navigate(`/companies/${activity.company_id}`)}
                        >
                            {activity.company_name}
                        </Text>
                    )}
                    {showMenu && (
                        <Menu withinPortal position="bottom-end" shadow="sm">
                            <Menu.Target>
                                <ActionIcon variant="subtle" size="sm" color="gray">
                                    <IconDotsVertical size={14} />
                                </ActionIcon>
                            </Menu.Target>
                            <Menu.Dropdown>
                                {canEdit && !isStatusChange && !isClosingReport && !isCampaignEmail && (
                                    <Menu.Item leftSection={<IconPencil size={14} />}
                                        onClick={() => onEdit(activity)}>
                                        {t('activity.editActivity')}
                                    </Menu.Item>
                                )}
                                {canDeleteItem && (
                                    <Menu.Item color="red" leftSection={<IconTrash size={14} />}
                                        onClick={() => onDelete(activity.id)}>
                                        {t('company.delete')}
                                    </Menu.Item>
                                )}
                            </Menu.Dropdown>
                        </Menu>
                    )}
                </Group>
            </Group>
            <Text size={compact ? 'xs' : 'sm'} fw={500} mt={3} lineClamp={compact ? 1 : 2}>
                {activity.summary}
            </Text>
        </Paper>
    );
}

// ─── AgendaDayGroup ──────────────────────────────────────────────────────────

export interface AgendaDayGroupProps {
    label: string;
    dateStr: string;
    countdown: string;
    urgencyColor: string;
    activities: Activity[];
    locale: string;
    canEdit: boolean;
    canDeleteItem: boolean;
    onEdit: (a: Activity) => void;
    onDelete: (id: string) => void;
    compact?: boolean;
    collapsible?: boolean;
    defaultCollapsed?: boolean;
}

export default function AgendaDayGroup({
    label, dateStr, countdown, urgencyColor, activities,
    locale, canEdit, canDeleteItem, onEdit, onDelete, compact,
    collapsible, defaultCollapsed = true,
}: AgendaDayGroupProps) {
    const [collapsed, setCollapsed] = useState(defaultCollapsed);
    const isCollapsible = collapsible === true;

    const body = (
        <div className="agenda-day-body">
            {dateStr && (
                <div className="agenda-day-label">
                    <Text size="xs" fw={600} c={urgencyColor}>{dateStr}</Text>
                </div>
            )}
            <Stack gap={compact ? 4 : 6} style={{ flex: 1 }}>
                {activities.map((a) => (
                    <AgendaCard
                        key={a.id}
                        activity={a}
                        locale={locale}
                        canEdit={canEdit}
                        canDeleteItem={canDeleteItem}
                        onEdit={onEdit}
                        onDelete={onDelete}
                        compact={compact}
                    />
                ))}
            </Stack>
        </div>
    );

    return (
        <div className="agenda-day">
            {/* Day header */}
            <Group
                gap="xs" mb={6}
                onClick={isCollapsible ? () => setCollapsed(c => !c) : undefined}
                style={isCollapsible ? { cursor: 'pointer' } : undefined}
            >
                {isCollapsible && (
                    <IconChevronRight
                        size={12}
                        color={`var(--mantine-color-${urgencyColor}-5)`}
                        style={{
                            transform: collapsed ? 'none' : 'rotate(90deg)',
                            transition: 'transform 0.2s',
                        }}
                    />
                )}
                <div
                    className="agenda-day-dot"
                    style={{ background: `var(--mantine-color-${urgencyColor}-5)` }}
                />
                <Text
                    size="xs" fw={700} tt="uppercase"
                    style={{ letterSpacing: '.04em' }}
                    c={urgencyColor}
                >
                    {label}
                </Text>
                <Badge size="xs" variant="light" color={urgencyColor} circle>
                    {activities.length}
                </Badge>
            </Group>

            {isCollapsible ? (
                <Collapse in={!collapsed} transitionDuration={200}>
                    {body}
                </Collapse>
            ) : body}
        </div>
    );
}
