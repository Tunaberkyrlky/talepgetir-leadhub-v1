import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    Paper, Group, Text, Badge, ActionIcon, Menu, Collapse, Box,
} from '@mantine/core';
import {
    IconChevronRight, IconDotsVertical, IconPencil, IconTrash, IconUser,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { ACTIVITY_ICONS, ACTIVITY_COLORS } from '../lib/activityConstants';
import { useStages } from '../contexts/StagesContext';
import type { Activity, ActivityType } from '../types/activity';

// ─── ActivityNode ────────────────────────────────────────────────────────────

interface ActivityNodeProps {
    activity: Activity;
    locale: string;
    canEdit: boolean;
    canDeleteItem: boolean;
    onEdit: (activity: Activity) => void;
    onDelete: (id: string) => void;
}

function formatNodeDate(iso: string, locale: string): string {
    const date = new Date(iso);
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);

    const dStr = date.toLocaleDateString(locale, { day: '2-digit', month: '2-digit' });
    const tStr = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });

    const isToday = date.toDateString() === now.toDateString();
    const isYesterday = date.toDateString() === yesterday.toDateString();

    if (isToday) return tStr;
    if (isYesterday) return `dün ${tStr}`;
    return `${dStr} ${tStr}`;
}

function ActivityNode({ activity, locale, canEdit, canDeleteItem, onEdit, onDelete }: ActivityNodeProps) {
    const { t } = useTranslation();
    const color = ACTIVITY_COLORS[activity.type] || 'gray';
    const isStatusChange = activity.type === 'status_change';
    const isClosingReport = activity.type === 'sonlandirma_raporu';
    const isCampaignEmail = activity.type === 'campaign_email';
    const showMenu = (canEdit && !isStatusChange && !isClosingReport && !isCampaignEmail) || canDeleteItem;

    return (
        <div className={`tl-node tl-node--${color}`}>
            <Paper p="xs" radius="sm" withBorder className="tl-card"
                style={{
                    background: isStatusChange ? 'var(--mantine-color-gray-0)' : undefined,
                }}
            >
                <Group justify="space-between" wrap="nowrap" gap="xs">
                    <Group gap={6} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
                        <Badge size="xs" variant="light" color={color} leftSection={ACTIVITY_ICONS[activity.type]}>
                            {t(`activity.types.${activity.type}`)}
                        </Badge>
                        <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                            {formatNodeDate(activity.occurred_at, locale)}
                        </Text>
                        {activity.visibility === 'internal' && (
                            <Badge size="xs" variant="outline" color="gray">
                                {t('activity.visibility_options.internal')}
                            </Badge>
                        )}
                    </Group>
                    <Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
                        {activity.contact_name && (
                            <Badge size="xs" variant="light" color="gray" leftSection={<IconUser size={10} />}>
                                {activity.contact_name}
                            </Badge>
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
                <Text size="sm" fw={500} mt={4}>{activity.summary}</Text>
                {activity.detail && (
                    <Text size="xs" c="dimmed" mt={2} lineClamp={2}>{activity.detail}</Text>
                )}
            </Paper>
        </div>
    );
}

// ─── CompanyTimelineGroup ────────────────────────────────────────────────────

interface CompanyTimelineGroupProps {
    companyId: string;
    companyName: string;
    activities: Activity[];
    canEdit: boolean;
    canDeleteItem: boolean;
    onEdit: (activity: Activity) => void;
    onDelete: (id: string) => void;
    defaultExpanded?: boolean;
}

export default function CompanyTimelineGroup({
    companyId, companyName, activities, canEdit, canDeleteItem,
    onEdit, onDelete, defaultExpanded = false,
}: CompanyTimelineGroupProps) {
    const { t, i18n } = useTranslation();
    const navigate = useNavigate();
    const { getStageLabel, getStageColor } = useStages();
    const locale = i18n.language === 'en' ? 'en-US' : 'tr-TR';
    const [expanded, setExpanded] = useState(defaultExpanded);
    const companyStage = activities[0]?.company_stage;

    const latest = activities[0];
    const peek = activities[1];
    const hiddenCount = activities.length - 1;

    if (!latest) return null;

    // Type counts for hidden activities (everything except the first visible one)
    const restTypeCounts = (() => {
        const rest = activities.slice(1);
        const counts: Record<string, number> = {};
        for (const a of rest) {
            counts[a.type] = (counts[a.type] || 0) + 1;
        }
        return Object.entries(counts).sort((a, b) => b[1] - a[1]);
    })();

    const nodeProps = { locale, canEdit, canDeleteItem, onEdit, onDelete };

    return (
        <Paper radius="md" withBorder style={{ overflow: 'hidden' }}>
            {/* ── Header ── */}
            <Group
                justify="space-between"
                p="sm"
                onClick={() => setExpanded(!expanded)}
                style={{
                    cursor: 'pointer',
                    background: expanded ? 'var(--mantine-color-blue-0)' : undefined,
                    transition: 'background 0.15s',
                }}
                className="company-tl-header"
            >
                <Group gap="xs">
                    <IconChevronRight
                        size={14}
                        color="var(--mantine-color-dimmed)"
                        style={{
                            transform: expanded ? 'rotate(90deg)' : 'none',
                            transition: 'transform 0.2s',
                        }}
                    />
                    <Text
                        fw={700} size="sm" c="blue"
                        onClick={(e) => { e.stopPropagation(); navigate(`/companies/${companyId}`); }}
                        style={{ cursor: 'pointer' }}
                    >
                        {companyName}
                    </Text>
                </Group>
                {companyStage && (
                    <Badge size="xs" variant="light" color={getStageColor(companyStage)}>
                        {t(`stages.${companyStage}`, getStageLabel(companyStage))}
                    </Badge>
                )}
            </Group>

            {/* ── Timeline Body ── */}
            <Box px="sm" pb="sm">
                <div className="timeline-track">
                    {/* First activity — always visible */}
                    <ActivityNode activity={latest} {...nodeProps} />

                    {/* Second activity — peek when collapsed, full when expanded */}
                    {peek && (
                        <div className={`peek-wrap ${expanded ? 'peek-wrap--open' : ''}`}>
                            <ActivityNode activity={peek} {...nodeProps} />
                        </div>
                    )}

                    {/* Remaining activities (3rd+) — animated expand */}
                    {activities.length > 2 && (
                        <Collapse in={expanded} transitionDuration={250}>
                            {activities.slice(2).map((a) => (
                                <ActivityNode key={a.id} activity={a} {...nodeProps} />
                            ))}
                        </Collapse>
                    )}
                </div>

                {/* Footer badges — only when collapsed */}
                {!expanded && hiddenCount > 0 && (
                    <Group gap={6} mt={2} style={{ cursor: 'pointer' }}
                        onClick={() => setExpanded(true)}>
                        {restTypeCounts.map(([type, count]) => (
                            <Badge key={type} size="xs" variant="light"
                                color={ACTIVITY_COLORS[type as ActivityType] || 'gray'}
                                leftSection={ACTIVITY_ICONS[type as ActivityType]}>
                                {count}
                            </Badge>
                        ))}
                    </Group>
                )}
            </Box>
        </Paper>
    );
}
