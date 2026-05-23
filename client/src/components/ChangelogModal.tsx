import { Modal, Stack, Group, Text, Badge, Timeline, ThemeIcon, ScrollArea } from '@mantine/core';
import { IconSparkles, IconRocket } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { changelog, type ChangelogType } from '../lib/changelog';

const TYPE_META: Record<ChangelogType, { color: string; tr: string; en: string }> = {
    feature:     { color: 'violet', tr: 'Özellik',     en: 'Feature' },
    fix:         { color: 'red',    tr: 'Düzeltme',    en: 'Fix' },
    improvement: { color: 'blue',   tr: 'İyileştirme', en: 'Improvement' },
    security:    { color: 'orange', tr: 'Güvenlik',    en: 'Security' },
};

interface ChangelogModalProps {
    opened: boolean;
    onClose: () => void;
}

const SEEN_KEY = 'changelog_seen_version';

export function getHasNewChangelog(): boolean {
    const seen = localStorage.getItem(SEEN_KEY);
    return !seen || seen !== changelog[0]?.version;
}

export function markChangelogSeen(): void {
    if (changelog[0]) {
        localStorage.setItem(SEEN_KEY, changelog[0].version);
    }
}

export default function ChangelogModal({ opened, onClose }: ChangelogModalProps) {
    const { i18n } = useTranslation();
    const lang = i18n.language === 'tr' ? 'tr' : 'en';

    return (
        <Modal
            opened={opened}
            onClose={onClose}
            title={
                <Group gap="xs">
                    <IconRocket size={20} />
                    <Text fw={600}>{lang === 'tr' ? 'Yenilikler' : "What's New"}</Text>
                </Group>
            }
            size="md"
            radius="lg"
        >
            <ScrollArea.Autosize mah="70vh" offsetScrollbars>
                <Timeline active={0} bulletSize={28} lineWidth={2} color="violet">
                    {changelog.map((entry, idx) => (
                        <Timeline.Item
                            key={entry.version}
                            bullet={
                                <ThemeIcon size={28} radius="xl" color={idx === 0 ? 'violet' : 'gray'} variant={idx === 0 ? 'filled' : 'light'}>
                                    <IconSparkles size={14} />
                                </ThemeIcon>
                            }
                            title={
                                <Group gap={8} align="center">
                                    <Text fw={600} size="sm">v{entry.version}</Text>
                                    {(() => {
                                        const meta = TYPE_META[entry.type ?? 'feature'];
                                        return (
                                            <Badge size="xs" variant="dot" color={meta.color} styles={{ root: { fontWeight: 500, textTransform: 'none', borderColor: 'transparent', paddingLeft: 6, paddingRight: 8 } }}>
                                                {meta[lang]}
                                            </Badge>
                                        );
                                    })()}
                                    <Text size="xs" c="dimmed">{entry.date}</Text>
                                </Group>
                            }
                        >
                            <Text size="sm" fw={500} c="dark" mb={4}>{entry.title[lang]}</Text>
                            <Stack gap={2}>
                                {entry.features.map((f, fi) => (
                                    <Text key={fi} size="xs" c="dimmed">
                                        • {f[lang]}
                                    </Text>
                                ))}
                            </Stack>
                        </Timeline.Item>
                    ))}
                </Timeline>
            </ScrollArea.Autosize>
        </Modal>
    );
}
