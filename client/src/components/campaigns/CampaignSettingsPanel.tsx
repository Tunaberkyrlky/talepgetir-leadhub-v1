import type { ReactNode } from 'react';
import {
    Stack, Paper, Group, Text, Badge, Select, NumberInput, TextInput, Switch,
} from '@mantine/core';
import {
    IconCalendarTime, IconGauge, IconInbox, IconUser, IconEye,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { CampaignSettings } from '../../types/campaign';

interface Props {
    fromName: string;
    onFromNameChange: (v: string) => void;
    settings: CampaignSettings;
    onSettingsChange: (s: CampaignSettings) => void;
    readOnly?: boolean;
}

// IANA timezones — kanonik gönderim penceresi saat dilimi. Genişletilebilir.
const TZ_OPTIONS = [
    'Europe/Istanbul', 'UTC', 'Europe/London', 'Europe/Berlin', 'Europe/Paris',
    'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Asia/Dubai', 'Asia/Singapore',
].map((tz) => ({ value: tz, label: tz.replace(/_/g, ' ') }));

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
                        <Group gap={4} mb={4}>
                            <Text size="xs" fw={500} c="dimmed">{t('campaign.settings.days')}</Text>
                            <Badge size="xs" variant="light" color="gray">{soon}</Badge>
                        </Group>
                        <Group gap={6}>
                            {weekdayLabels.map((d, i) => (
                                <Badge key={i} size="sm" variant="light"
                                    color={i >= 1 && i <= 5 ? 'violet' : 'gray'} style={{ opacity: 0.55 }}>
                                    {d}
                                </Badge>
                            ))}
                        </Group>
                    </div>
                    <Group gap="sm" align="end">
                        <TextInput label={t('campaign.settings.startTime')} placeholder="09:00"
                            rightSection={<Badge size="xs" variant="light" color="gray">{soon}</Badge>}
                            rightSectionWidth={60} radius="md" size="sm" w={150} disabled />
                        <TextInput label={t('campaign.settings.endTime')} placeholder="18:00"
                            rightSection={<Badge size="xs" variant="light" color="gray">{soon}</Badge>}
                            rightSectionWidth={60} radius="md" size="sm" w={150} disabled />
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

            {/* ── Gönderen Kutular (rotasyon) — Faz 1.3 ── */}
            <SettingSection
                icon={<IconInbox size={16} color="var(--mantine-color-violet-6)" />}
                title={t('campaign.settings.accounts')}
                desc={t('campaign.settings.accountsDesc')}
                soonLabel={soon}
            >
                <Text size="xs" c="dimmed">{t('campaign.settings.accountsPlaceholder')}</Text>
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
