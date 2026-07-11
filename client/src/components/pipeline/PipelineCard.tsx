import { Paper, Text, Group, Badge, Stack, Avatar, Tooltip, ThemeIcon } from '@mantine/core';
import { IconUsers, IconUser, IconAlertTriangle, IconClock, IconChecklist, IconHistory } from '@tabler/icons-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { isTaskOverdue, getContactAgeDays, getOwnerInitials } from '../../lib/pipelineSignals';

export interface ClosingReport {
    summary: string;
    detail: string | null;
    outcome: string;
    occurred_at: string;
}

export interface PipelineNextTask {
    id: string;
    title: string;
    due_at: string;
    // Request-time hint from the server; the client recomputes overdue from due_at for freshness.
    is_overdue: boolean;
}

export interface PipelineOwner {
    id: string;
    name: string | null;
    email: string;
}

export interface PipelineCompany {
    id: string;
    name: string;
    industry: string | null;
    stage: string;
    next_step: string | null;
    company_summary: string | null;
    updated_at: string;
    stage_changed_at: string | null;
    contact_count: number;
    closing_report?: ClosingReport | null;
    // Working signals (A3)
    next_task?: PipelineNextTask | null;
    last_contact_at?: string | null;
    assigned_user?: PipelineOwner | null;
}

interface PipelineCardProps {
    company: PipelineCompany;
    isDragEnabled: boolean;
    /** Work signals (next task, last contact, owner) are only enriched server-side for
     *  active-pipeline companies. Terminal/outcomes cards leave them unenriched, so showing
     *  them there renders false "no task / never contacted / unassigned" states — pass false
     *  to hide the whole signal row. Defaults to true. */
    showWorkSignals?: boolean;
}

function getDaysInStage(stageChangedAt: string | null): number | null {
    if (!stageChangedAt) return null;
    const diff = Date.now() - new Date(stageChangedAt).getTime();
    return Math.floor(diff / (1000 * 60 * 60 * 24));
}

/** Short "12 Jul"-style due date; overdue is shown as a text label instead. */
function formatDueShort(iso: string): string {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function PipelineCard({ company, isDragEnabled, showWorkSignals = true }: PipelineCardProps) {
    const { t } = useTranslation();
    const navigate = useNavigate();

    const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
        id: company.id,
        data: { company },
        disabled: !isDragEnabled,
    });

    const style = {
        transform: CSS.Translate.toString(transform),
        opacity: isDragging ? 0.5 : 1,
        cursor: isDragEnabled ? 'grab' : 'pointer',
    };

    const daysInStage = getDaysInStage(company.stage_changed_at);
    const nextTask = company.next_task;
    const taskOverdue = nextTask ? isTaskOverdue(nextTask.due_at) : false;
    const contactAge = getContactAgeDays(company.last_contact_at);
    const owner = company.assigned_user;

    return (
        <Paper
            ref={setNodeRef}
            style={style}
            {...(isDragEnabled ? { ...listeners, ...attributes } : {})}
            shadow="xs"
            radius="md"
            p="sm"
            withBorder
            onClick={() => {
                if (!isDragging) navigate(`/companies/${company.id}`);
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
                        {company.name}
                    </Text>
                    <Badge size="xs" variant="light" color={company.contact_count > 0 ? 'violet' : 'gray'} leftSection={<IconUsers size={10} />}>
                        {company.contact_count ?? 0}
                    </Badge>
                </Group>

                {company.industry && (
                    <Text size="xs" c="dimmed" lineClamp={1}>
                        {company.industry}
                    </Text>
                )}

                {company.next_step && (
                    <Text size="xs" lineClamp={2} c="dark.3">
                        {company.next_step}
                    </Text>
                )}

                {/* Next pending task — one dense line; overdue pairs colour with an icon + label */}
                {showWorkSignals && (nextTask ? (
                    <Group gap={4} wrap="nowrap">
                        <ThemeIcon size={16} radius="sm" variant="light" color={taskOverdue ? 'red' : 'gray'}>
                            {taskOverdue ? <IconAlertTriangle size={11} /> : <IconChecklist size={11} />}
                        </ThemeIcon>
                        <Text size="xs" lineClamp={1} style={{ flex: 1 }} c={taskOverdue ? undefined : 'dark.3'}>
                            {nextTask.title}
                        </Text>
                        <Tooltip
                            label={`${t('pipeline.nextTask')}: ${new Date(nextTask.due_at).toLocaleString()}`}
                            withArrow
                        >
                            <Badge
                                size="xs"
                                variant={taskOverdue ? 'filled' : 'light'}
                                color={taskOverdue ? 'red' : 'gray'}
                                leftSection={taskOverdue ? <IconAlertTriangle size={9} /> : <IconClock size={9} />}
                            >
                                {taskOverdue ? t('pipeline.overdue') : formatDueShort(nextTask.due_at)}
                            </Badge>
                        </Tooltip>
                    </Group>
                ) : (
                    <Group gap={4} wrap="nowrap">
                        <ThemeIcon size={16} radius="sm" variant="light" color="gray">
                            <IconChecklist size={11} />
                        </ThemeIcon>
                        <Text size="xs" c="dimmed">{t('pipeline.noTask')}</Text>
                    </Group>
                ))}

                {/* Owner + last-contact age on the left, stage age on the right.
                    Owner + contact age are work signals (hidden on terminal cards); the
                    stage-age badge stays because stage_changed_at is always present. */}
                <Group justify={showWorkSignals ? 'space-between' : 'flex-end'} gap={4} wrap="nowrap">
                    {showWorkSignals && (
                    <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                        <Tooltip label={owner ? (owner.name || owner.email) : t('pipeline.unassigned')} withArrow>
                            <Avatar size={20} radius="xl" variant="light" color={owner ? 'violet' : 'gray'}>
                                {owner ? (
                                    <Text size="9px" fw={700}>{getOwnerInitials(owner.name, owner.email)}</Text>
                                ) : (
                                    <IconUser size={11} />
                                )}
                            </Avatar>
                        </Tooltip>
                        {contactAge === null ? (
                            <Tooltip label={t('pipeline.neverContacted')} withArrow>
                                <Group gap={2} wrap="nowrap">
                                    <IconHistory size={11} color="var(--mantine-color-dimmed)" />
                                    <Text size="xs" c="dimmed">—</Text>
                                </Group>
                            </Tooltip>
                        ) : (
                            <Tooltip
                                label={`${t('pipeline.lastContact')}: ${new Date(company.last_contact_at!).toLocaleDateString()}`}
                                withArrow
                            >
                                <Group gap={2} wrap="nowrap">
                                    <IconHistory size={11} color="var(--mantine-color-dimmed)" />
                                    <Text size="xs" c="dimmed">
                                        {contactAge === 0 ? t('pipeline.contactToday') : `${contactAge}${t('pipeline.ageDaysShort')}`}
                                    </Text>
                                </Group>
                            </Tooltip>
                        )}
                    </Group>
                    )}
                    {daysInStage !== null && (
                        <Badge
                            size="xs"
                            variant="light"
                            color={daysInStage > 14 ? 'red' : daysInStage > 7 ? 'orange' : 'gray'}
                        >
                            {daysInStage}{t('pipeline.days', 'd')}
                        </Badge>
                    )}
                </Group>
            </Stack>
        </Paper>
    );
}
