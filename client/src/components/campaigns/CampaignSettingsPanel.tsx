import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
    Stack, Paper, Group, Text, Badge, Select, NumberInput, TextInput, Switch, Chip, MultiSelect,
} from '@mantine/core';
import {
    IconCalendarTime, IconGauge, IconInbox, IconUser, IconEye,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import type { CampaignSettings } from '../../types/campaign';

interface Props {
    fromName: string;
    onFromNameChange: (v: string) => void;
    settings: CampaignSettings;
    onSettingsChange: (s: CampaignSettings) => void;
    readOnly?: boolean;
}

// IANA timezones — gönderim penceresi saat dilimi. Etiketlerde güncel UTC ofseti gösterilir.
const TZ_ZONES = [
    'Pacific/Honolulu', 'America/Anchorage', 'America/Los_Angeles', 'America/Denver',
    'America/Chicago', 'America/New_York', 'America/Sao_Paulo', 'Atlantic/Azores',
    'UTC', 'Europe/London', 'Europe/Lisbon', 'Europe/Paris', 'Europe/Berlin',
    'Europe/Istanbul', 'Europe/Moscow', 'Asia/Tehran', 'Asia/Dubai', 'Asia/Karachi',
    'Asia/Kolkata', 'Asia/Dhaka', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Shanghai',
    'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland',
];

// "GMT+3" → "UTC+3"; UTC bölgesi için "UTC+0".
function tzShortOffset(tz: string, now: Date): string {
    try {
        const raw = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
            .formatToParts(now).find((p) => p.type === 'timeZoneName')?.value || 'GMT';
        const utc = raw.replace('GMT', 'UTC');
        return utc === 'UTC' ? 'UTC+0' : utc;
    } catch {
        return 'UTC+0';
    }
}

function offsetMinutes(short: string): number {
    const m = /UTC([+-])(\d{1,2})(?::(\d{2}))?/.exec(short);
    if (!m) return 0;
    return (m[1] === '-' ? -1 : 1) * (parseInt(m[2], 10) * 60 + (m[3] ? parseInt(m[3], 10) : 0));
}

const TZ_OPTIONS = (() => {
    const now = new Date();
    return TZ_ZONES
        .map((tz) => {
            const off = tzShortOffset(tz, now);
            return { value: tz, label: `(${off}) ${tz.replace(/_/g, ' ')}`, _min: offsetMinutes(off) };
        })
        .sort((a, b) => a._min - b._min)
        .map(({ value, label }) => ({ value, label }));
})();

// ── Bölüm kabuğu — başlık + opsiyonel "Yakında" rozeti + açıklama + içerik ──
// Top-level: her render'da remount olup input focus'unu kaybetmemesi için
// CampaignSettingsPanel içinde tanımlanmadı.
function SettingSection({ icon, title, desc, soonLabel, children }: {
    icon: ReactNode; title: string; desc?: string; soonLabel?: string; children: ReactNode;
}) {
    return (
        <Paper shadow="xs" radius="md" p="md" withBorder>
            <Group gap="xs" mb={4}>
                {icon}
                <Text size="sm" fw={600}>{title}</Text>
                {soonLabel && <Badge size="xs" variant="light" color="gray">{soonLabel}</Badge>}
            </Group>
            {desc && <Text size="xs" c="dimmed" mb="sm">{desc}</Text>}
            {children}
        </Paper>
    );
}

export default function CampaignSettingsPanel({
    fromName, onFromNameChange, settings, onSettingsChange, readOnly,
}: Props) {
    const { t, i18n } = useTranslation();
    const soon = t('campaign.settings.comingSoon', 'Soon');

    // Yerel kısa gün adları — 7 Ocak 2024 = Pazar, indeks 0..6 = Paz..Cmt.
    const weekdayLabels = Array.from({ length: 7 }, (_, i) =>
        new Intl.DateTimeFormat(i18n.language || 'tr', { weekday: 'short' })
            .format(new Date(2024, 0, 7 + i)),
    );

    const patch = (p: Partial<CampaignSettings>) => onSettingsChange({ ...settings, ...p });
    const win = settings.sending_window || {};
    const patchWindow = (p: Partial<NonNullable<CampaignSettings['sending_window']>>) =>
        patch({ sending_window: { ...win, ...p } });

    // Bağlı kutular (rotasyon için) — SMTP hariç (kampanya gönderimi Nango üzerinden).
    const { data: connData } = useQuery<{ connections?: { email_address: string; provider: string }[] }>({
        queryKey: ['email-connections-status'],
        queryFn: async () => (await api.get('/email-connections/status')).data,
        staleTime: 5 * 60_000,
    });
    const inboxOptions = (connData?.connections || [])
        .filter((c) => c.provider !== 'smtp')
        .map((c) => ({ value: c.email_address, label: c.email_address }));

    return (
        <Stack gap="md">
            <Text size="xs" c="dimmed">{t('campaign.settings.savedHint')}</Text>

            {/* ── Gönderim Programı ── */}
            <SettingSection
                icon={<IconCalendarTime size={16} color="var(--mantine-color-violet-6)" />}
                title={t('campaign.settings.schedule')}
                desc={t('campaign.settings.scheduleDesc')}
            >
                <Stack gap="sm">
                    <Select
                        label={t('campaign.settings.timezone')}
                        data={TZ_OPTIONS}
                        value={settings.timezone || null}
                        onChange={(v) => patch({ timezone: v || undefined })}
                        searchable radius="md" size="sm" maw={280}
                        disabled={readOnly}
                    />
                    <div>
                        <Text size="xs" fw={500} c="dimmed" mb={6}>{t('campaign.settings.days')}</Text>
                        <Chip.Group multiple value={(win.days || []).map(String)}
                            onChange={(v) => patchWindow({ days: v.map(Number).sort((a, b) => a - b) })}>
                            <Group gap={6}>
                                {weekdayLabels.map((d, i) => (
                                    <Chip key={i} value={String(i)} size="xs" radius="sm" color="violet" disabled={readOnly}>{d}</Chip>
                                ))}
                            </Group>
                        </Chip.Group>
                    </div>
                    <Group gap="sm" align="end">
                        <TextInput type="time" label={t('campaign.settings.startTime')} value={win.start || ''}
                            onChange={(e) => patchWindow({ start: e.currentTarget.value || undefined })}
                            radius="md" size="sm" w={150} disabled={readOnly} />
                        <TextInput type="time" label={t('campaign.settings.endTime')} value={win.end || ''}
                            onChange={(e) => patchWindow({ end: e.currentTarget.value || undefined })}
                            radius="md" size="sm" w={150} disabled={readOnly} />
                    </Group>
                </Stack>
            </SettingSection>

            {/* ── Limitler ── */}
            <SettingSection
                icon={<IconGauge size={16} color="var(--mantine-color-violet-6)" />}
                title={t('campaign.settings.limits')}
                desc={t('campaign.settings.limitsDesc')}
            >
                <Group gap="md" align="end">
                    <NumberInput
                        label={t('campaign.settings.dailyLimit')}
                        description={t('campaign.settings.dailyLimitNote')}
                        min={1} max={500} radius="md" size="sm" w={220}
                        value={settings.daily_limit ?? ''}
                        onChange={(v) => patch({ daily_limit: typeof v === 'number' ? v : undefined })}
                        disabled={readOnly}
                    />
                    <NumberInput
                        label={t('campaign.settings.perInboxLimit')}
                        rightSection={<Badge size="xs" variant="light" color="gray">{soon}</Badge>}
                        rightSectionWidth={60}
                        min={1} max={500} radius="md" size="sm" w={220} disabled
                    />
                </Group>
            </SettingSection>

            {/* ── Gönderen Kutular (rotasyon) ── */}
            <SettingSection
                icon={<IconInbox size={16} color="var(--mantine-color-violet-6)" />}
                title={t('campaign.settings.accounts')}
                desc={t('campaign.settings.accountsDesc')}
            >
                <MultiSelect
                    data={inboxOptions}
                    value={settings.sending_accounts || []}
                    onChange={(v) => patch({ sending_accounts: v })}
                    placeholder={inboxOptions.length
                        ? t('campaign.settings.accountsSelect', 'Select inboxes (default if empty)')
                        : t('campaign.settings.accountsNone', 'No connected mailbox yet')}
                    searchable clearable radius="md" size="sm"
                    disabled={readOnly || inboxOptions.length === 0}
                />
                <Text size="xs" c="dimmed" mt={4}>{t('campaign.settings.accountsHint', 'Leave empty to use the default mailbox. With multiple, contacts are spread across them and each contact always gets the same inbox.')}</Text>
            </SettingSection>

            {/* ── Gönderen & CC ── */}
            <SettingSection
                icon={<IconUser size={16} color="var(--mantine-color-violet-6)" />}
                title={t('campaign.settings.sender')}
                desc={t('campaign.settings.senderDesc')}
            >
                <Stack gap="sm">
                    <TextInput
                        label={t('campaign.settings.fromName')}
                        placeholder={t('campaign.settings.fromNamePlaceholder')}
                        value={fromName}
                        onChange={(e) => onFromNameChange(e.currentTarget.value)}
                        radius="md" size="sm" maw={280}
                        disabled={readOnly}
                    />
                    <TextInput
                        label={t('campaign.settings.cc')}
                        placeholder={t('campaign.settings.ccPlaceholder')}
                        rightSection={<Badge size="xs" variant="light" color="gray">{soon}</Badge>}
                        rightSectionWidth={60} radius="md" size="sm" disabled
                    />
                </Stack>
            </SettingSection>

            {/* ── Takip ── */}
            <SettingSection
                icon={<IconEye size={16} color="var(--mantine-color-violet-6)" />}
                title={t('campaign.settings.tracking')}
                desc={t('campaign.settings.trackingDesc')}
                soonLabel={soon}
            >
                <Stack gap="xs">
                    <Switch label={t('campaign.settings.openTracking')} defaultChecked disabled size="sm" />
                    <Switch label={t('campaign.settings.clickTracking')} defaultChecked disabled size="sm" />
                </Stack>
            </SettingSection>
        </Stack>
    );
}
