import { useState, useMemo, useImperativeHandle, forwardRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
    Stack,
    Group,
    Text,
    Badge,
    Button,
    ActionIcon,
    Menu,
    Paper,
    Loader,
    Center,
    Divider,
    Select,
    Switch,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { useDisclosure } from '@mantine/hooks';
import {
    IconDotsVertical,
    IconPencil,
    IconTrash,
    IconUser,
    IconFilterOff,
    IconChevronRight,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { CHANNEL_ICONS, CHANNEL_COLORS, OUTCOME_COLORS, parseOwnerChange } from '../lib/activityConstants';
import LossReasonDetail from './LossReasonDetail';
import { useAuth } from '../contexts/AuthContext';
import { hasRolePermission, canDelete } from '../lib/permissions';
import { showSuccess, showErrorFromApi } from '../lib/notifications';
import api from '../lib/api';
import ActivityForm from './ActivityForm';
import type { Activity } from '../types/activity';
import type { TimelineEvent } from '../types/timeline';
import { eventChannel, isImportantEvent } from '../types/timeline';
import type { ActivityTimelineHandle } from './ActivityTimeline';

interface ActivityTimelineUnifiedProps {
    companyId: string;
    /** Opens the source detail for an email event (parent owns the modal) */
    onOpenEmail: (refId: string) => void;
    /** When true, hide the internal add button (parent renders it via the ref) */
    hideActionButton?: boolean;
}

interface TimelineResponse {
    events: TimelineEvent[];
}

function formatEventDate(isoString: string, locale: string): string {
    return new Date(isoString).toLocaleDateString(locale, {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

// Local yyyy-mm-dd (URL-safe, avoids UTC drift from toISOString)
function toDateStr(d: Date | null): string {
    if (!d) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function parseDateStr(s: string | null): Date | null {
    if (!s) return null;
    const d = new Date(`${s}T00:00:00`);
    return isNaN(d.getTime()) ? null : d;
}

const ActivityTimelineUnified = forwardRef<ActivityTimelineHandle, ActivityTimelineUnifiedProps>(
    function ActivityTimelineUnified({ companyId, onOpenEmail, hideActionButton }, ref) {
        const { t, i18n } = useTranslation();
        const locale = i18n.language === 'tr' ? 'tr-TR' : 'en-US';
        const { user } = useAuth();
        const queryClient = useQueryClient();
        const [searchParams, setSearchParams] = useSearchParams();
        const [editingActivity, setEditingActivity] = useState<Activity | null>(null);
        const [formOpened, { open: openForm, close: closeForm }] = useDisclosure(false);

        const canEditActivities = hasRolePermission(user?.role || '', 'activity_write');
        const canDeleteActivities = canDelete(user?.role || '');

        // Filter state lives in the URL so a shared/back-navigated link keeps the view.
        const channel = searchParams.get('tl_ch') || '';
        const actor = searchParams.get('tl_who') || '';
        const dateFrom = searchParams.get('tl_from');
        const dateTo = searchParams.get('tl_to');
        const importantOnly = searchParams.get('tl_imp') === '1';

        const setParam = (key: string, value: string) => {
            setSearchParams((prev) => {
                const next = new URLSearchParams(prev);
                if (value) next.set(key, value);
                else next.delete(key);
                return next;
            }, { replace: true });
        };

        const clearFilters = () => {
            setSearchParams((prev) => {
                const next = new URLSearchParams(prev);
                ['tl_ch', 'tl_who', 'tl_from', 'tl_to', 'tl_imp'].forEach((k) => next.delete(k));
                return next;
            }, { replace: true });
        };

        const { data, isLoading } = useQuery<TimelineResponse>({
            queryKey: ['company-timeline', companyId],
            queryFn: async () => (await api.get(`/companies/${companyId}/timeline`)).data,
            enabled: !!companyId,
            refetchOnWindowFocus: false,
        });

        const events = useMemo(() => data?.events ?? [], [data]);

        const actorOptions = useMemo(() => {
            const names = [...new Set(events.map((e) => e.actor).filter((a): a is string => !!a))];
            return names.sort().map((name) => ({ value: name, label: name }));
        }, [events]);

        const channelOptions = useMemo(() => ([
            { value: '', label: t('timeline.filters.allChannels') },
            { value: 'not', label: t('activity.types.not') },
            { value: 'meeting', label: t('activity.types.meeting') },
            { value: 'call', label: t('activity.types.call') },
            { value: 'follow_up', label: t('activity.types.follow_up') },
            { value: 'campaign_email', label: t('activity.types.campaign_email') },
            { value: 'sonlandirma_raporu', label: t('activity.types.sonlandirma_raporu') },
            { value: 'email_in', label: t('timeline.channels.email_in') },
            { value: 'email_out', label: t('timeline.channels.email_out') },
            { value: 'status_change', label: t('activity.types.status_change') },
        ]), [t]);

        const filtered = useMemo(() => {
            const from = parseDateStr(dateFrom);
            const to = parseDateStr(dateTo);
            const toEnd = to ? new Date(to.getTime() + 24 * 60 * 60 * 1000 - 1) : null;
            return events.filter((e) => {
                if (channel && eventChannel(e) !== channel) return false;
                if (actor && e.actor !== actor) return false;
                if (importantOnly && !isImportantEvent(e)) return false;
                const when = new Date(e.occurred_at);
                if (from && when < from) return false;
                if (toEnd && when > toEnd) return false;
                return true;
            });
        }, [events, channel, actor, importantOnly, dateFrom, dateTo]);

        const deleteMutation = useMutation({
            mutationFn: async (id: string) => { await api.delete(`/activities/${id}`); },
            onSuccess: () => {
                showSuccess(t('activity.deleted'));
                queryClient.invalidateQueries({ queryKey: ['company-timeline', companyId] });
                queryClient.invalidateQueries({ queryKey: ['activities', companyId] });
            },
            onError: (err) => showErrorFromApi(err, t('errors.generic')),
        });

        const handleAddActivity = () => { setEditingActivity(null); openForm(); };
        useImperativeHandle(ref, () => ({ openAddForm: handleAddActivity }));

        const handleFormSuccess = () => {
            queryClient.invalidateQueries({ queryKey: ['company-timeline', companyId] });
            queryClient.invalidateQueries({ queryKey: ['activities', companyId] });
        };

        const hasActiveFilters = !!(channel || actor || dateFrom || dateTo || importantOnly);

        const filterBar = (
            <Group gap="xs" align="flex-end" wrap="wrap" mb="md">
                <Select
                    label={t('timeline.filters.channel')}
                    data={channelOptions}
                    value={channel}
                    onChange={(v) => setParam('tl_ch', v || '')}
                    size="xs"
                    w={160}
                    allowDeselect={false}
                    comboboxProps={{ withinPortal: true }}
                />
                <Select
                    label={t('timeline.filters.user')}
                    data={actorOptions}
                    value={actor || null}
                    onChange={(v) => setParam('tl_who', v || '')}
                    placeholder={t('timeline.filters.allUsers')}
                    size="xs"
                    w={160}
                    clearable
                    disabled={actorOptions.length === 0}
                    comboboxProps={{ withinPortal: true }}
                />
                <DatePickerInput
                    type="range"
                    label={t('timeline.filters.dateRange')}
                    value={[parseDateStr(dateFrom), parseDateStr(dateTo)]}
                    onChange={(v) => {
                        const [d1, d2] = v as [Date | null, Date | null];
                        const from = toDateStr(d1);
                        const to = toDateStr(d2);
                        // Write both bounds in ONE update — two back-to-back setParam
                        // calls each start from the same stale `prev`, so the second
                        // clobbers the first. Other tl_* params are preserved.
                        setSearchParams((prev) => {
                            const next = new URLSearchParams(prev);
                            if (from) next.set('tl_from', from); else next.delete('tl_from');
                            if (to) next.set('tl_to', to); else next.delete('tl_to');
                            return next;
                        }, { replace: true });
                    }}
                    placeholder={t('timeline.filters.dateRange')}
                    size="xs"
                    w={200}
                    clearable
                />
                <Switch
                    label={t('timeline.filters.importantOnly')}
                    checked={importantOnly}
                    onChange={(e) => setParam('tl_imp', e.currentTarget.checked ? '1' : '')}
                    size="sm"
                    mb={6}
                />
                {hasActiveFilters && (
                    <Button
                        variant="subtle"
                        color="gray"
                        size="xs"
                        leftSection={<IconFilterOff size={14} />}
                        onClick={clearFilters}
                        mb={2}
                    >
                        {t('timeline.filters.clear')}
                    </Button>
                )}
            </Group>
        );

        return (
            <>
                {events.length > 0 && filterBar}

                {isLoading ? (
                    <Center py="xl"><Loader size="sm" color="violet" /></Center>
                ) : events.length === 0 ? (
                    <Center py="xl">
                        <Text size="sm" c="dimmed" fs="italic">{t('timeline.empty')}</Text>
                    </Center>
                ) : filtered.length === 0 ? (
                    <Center py="xl">
                        <Stack align="center" gap="xs">
                            <Text size="sm" c="dimmed" fs="italic">{t('timeline.emptyFiltered')}</Text>
                            <Button variant="light" color="gray" size="xs" onClick={clearFilters}>
                                {t('timeline.filters.clear')}
                            </Button>
                        </Stack>
                    </Center>
                ) : (
                    <Stack gap="sm">
                        {filtered.map((e, idx) => {
                            const ch = eventChannel(e);
                            const isEmail = e.source === 'email';
                            const isClosing = e.kind === 'sonlandirma_raporu';
                            const isCampaign = e.kind === 'campaign_email';
                            const outcomeColor = OUTCOME_COLORS[e.outcome || ''] || 'gray';
                            const unreadEmail = isEmail && e.read_status === 'unread';
                            const ownerChange = parseOwnerChange(e.kind, e.detail, t('activity.unassigned'));
                            const title = ownerChange
                                ? t('activity.ownerChanged', ownerChange)
                                : e.summary || e.sender_email || t(`activity.types.${e.kind}`);

                            return (
                                <div key={e.id}>
                                    <Paper
                                        p={e.is_system ? 'xs' : 'sm'}
                                        radius="md"
                                        withBorder
                                        shadow={e.is_system ? undefined : 'xs'}
                                        onClick={isEmail ? () => onOpenEmail(e.ref_id) : undefined}
                                        style={{
                                            cursor: isEmail ? 'pointer' : undefined,
                                            opacity: e.is_system ? 0.7 : unreadEmail ? 1 : undefined,
                                            borderColor: isClosing ? `var(--mantine-color-${outcomeColor}-4)` : undefined,
                                            background: isClosing
                                                ? `var(--mantine-color-${outcomeColor}-0)`
                                                : isCampaign
                                                ? 'var(--mantine-color-indigo-0)'
                                                : e.is_system
                                                ? 'var(--mantine-color-gray-0)'
                                                : undefined,
                                        }}
                                    >
                                        <Group justify="space-between" wrap="nowrap">
                                            <Group gap="xs" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
                                                <Badge
                                                    size="xs"
                                                    variant="light"
                                                    color={CHANNEL_COLORS[ch]}
                                                    leftSection={CHANNEL_ICONS[ch]}
                                                >
                                                    {isEmail ? t(`timeline.channels.${ch}`) : t(`activity.types.${e.kind}`)}
                                                </Badge>
                                                {isCampaign && e.outcome && (
                                                    <Badge size="xs" variant="dot"
                                                        color={e.outcome === 'sent' ? 'green' : e.outcome === 'sending' ? 'blue' : 'red'}
                                                    >
                                                        {e.outcome === 'sent' ? t('campaign.sent', 'sent') : e.outcome}
                                                    </Badge>
                                                )}
                                                {!isCampaign && !isEmail && e.outcome && (
                                                    <Badge size="xs" variant="filled" color={outcomeColor}>
                                                        {t(`activity.closingReport.${e.outcome}`, e.outcome)}
                                                    </Badge>
                                                )}
                                                {isEmail && e.category && (
                                                    <Badge size="xs" variant="outline" color="gray">
                                                        {t(`emailReplies.categories.${e.category}`, e.category)}
                                                    </Badge>
                                                )}
                                                {e.campaign_name && (
                                                    <Badge size="xs" variant="light" color="gray">
                                                        {e.campaign_name}
                                                    </Badge>
                                                )}
                                                {e.visibility === 'internal' && (
                                                    <Badge size="xs" variant="outline" color="gray">
                                                        {t('activity.visibility_options.internal')}
                                                    </Badge>
                                                )}
                                                {e.actor && (
                                                    <Badge size="xs" variant="light" color="gray" leftSection={<IconUser size={10} />}>
                                                        {e.actor}
                                                    </Badge>
                                                )}
                                                {e.contact_name && (
                                                    <Badge size="xs" variant="light" color="gray" leftSection={<IconUser size={10} />}>
                                                        {e.contact_name}
                                                    </Badge>
                                                )}
                                            </Group>

                                            <Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
                                                <Text size="xs" c="dimmed">{formatEventDate(e.occurred_at, locale)}</Text>
                                                {isEmail && <IconChevronRight size={14} color="var(--mantine-color-gray-5)" />}
                                                {!isEmail && canEditActivities && !e.is_system && !isCampaign && e.activity && (
                                                    <Menu withinPortal position="bottom-end" shadow="sm">
                                                        <Menu.Target>
                                                            <ActionIcon variant="subtle" size="sm" color="gray">
                                                                <IconDotsVertical size={14} />
                                                            </ActionIcon>
                                                        </Menu.Target>
                                                        <Menu.Dropdown>
                                                            {!isClosing && (
                                                                <Menu.Item
                                                                    leftSection={<IconPencil size={14} />}
                                                                    onClick={() => { setEditingActivity(e.activity!); openForm(); }}
                                                                >
                                                                    {t('activity.editActivity')}
                                                                </Menu.Item>
                                                            )}
                                                            {canDeleteActivities && (
                                                                <Menu.Item
                                                                    color="red"
                                                                    leftSection={<IconTrash size={14} />}
                                                                    disabled={deleteMutation.isPending}
                                                                    onClick={() => deleteMutation.mutate(e.ref_id)}
                                                                >
                                                                    {t('company.delete')}
                                                                </Menu.Item>
                                                            )}
                                                        </Menu.Dropdown>
                                                    </Menu>
                                                )}
                                            </Group>
                                        </Group>

                                        <Text size="sm" fw={unreadEmail ? 700 : 500} mt="xs">
                                            {title}
                                        </Text>
                                        {e.detail && !ownerChange && (
                                            <LossReasonDetail
                                                detail={e.detail}
                                                textProps={{
                                                    size: 'sm',
                                                    c: 'dimmed',
                                                    mt: 4,
                                                    lineClamp: isEmail ? 2 : undefined,
                                                    style: isEmail ? undefined : { whiteSpace: 'pre-wrap' },
                                                }}
                                            />
                                        )}
                                    </Paper>
                                    {idx < filtered.length - 1 && (
                                        <Divider
                                            variant="dotted"
                                            ml="sm"
                                            style={{ borderColor: 'var(--mantine-color-gray-2)' }}
                                        />
                                    )}
                                </div>
                            );
                        })}
                    </Stack>
                )}

                {!hideActionButton && canEditActivities && (
                    <Group justify="flex-end" mt="md">
                        <Button size="sm" variant="light" color="violet" radius="md" onClick={handleAddActivity}>
                            {t('activity.addActivity')}
                        </Button>
                    </Group>
                )}

                <ActivityForm
                    opened={formOpened}
                    onClose={() => { setEditingActivity(null); closeForm(); }}
                    onSuccess={handleFormSuccess}
                    companyId={companyId}
                    activity={editingActivity}
                />
            </>
        );
    }
);

export default ActivityTimelineUnified;
