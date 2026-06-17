import { Modal, Stack, Group, Text, Badge, Accordion, ScrollArea } from '@mantine/core';
import { IconSparkles, IconRocket } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { changelog, type ChangelogType, type ChangelogEntry } from '../lib/changelog';

const TYPE_META: Record<ChangelogType, { color: string; tr: string; en: string }> = {
    feature:     { color: 'violet', tr: 'Özellik',     en: 'Feature' },
    fix:         { color: 'red',    tr: 'Düzeltme',    en: 'Fix' },
    improvement: { color: 'blue',   tr: 'İyileştirme', en: 'Improvement' },
    security:    { color: 'orange', tr: 'Güvenlik',    en: 'Security' },
};

// New-format section labels (about / usage / notes).
const SECTION_LABELS = {
    about: { tr: 'Ne hakkında', en: 'Overview' },
    usage: { tr: 'Nasıl kullanılır', en: 'How to use' },
    notes: { tr: 'Bilmeniz gerekenler', en: 'Good to know' },
} as const;

// Patch sürümlerini minor (major.minor) başlığı altında grupla. changelog en
// yeniden eskiye sıralı olduğundan aynı minor'a ait entry'ler ardışıktır.
const MINOR_GROUPS: { key: string; entries: ChangelogEntry[] }[] = (() => {
    const out: { key: string; entries: ChangelogEntry[] }[] = [];
    for (const e of changelog) {
        const key = e.version.split('.').slice(0, 2).join('.'); // "1.10.13" → "1.10"
        const last = out[out.length - 1];
        if (last && last.key === key) last.entries.push(e);
        else out.push({ key, entries: [e] });
    }
    return out;
})();

type Lang = 'tr' | 'en';

function ChangelogSection({ label, text }: { label: string; text: string }) {
    return (
        <div>
            <Text size="10px" fw={700} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.05em' }}>{label}</Text>
            <Text size="xs" c="dimmed">{text}</Text>
        </div>
    );
}

function EntryItem({ entry, lang }: { entry: ChangelogEntry; lang: Lang }) {
    const meta = TYPE_META[entry.type ?? 'feature'];
    return (
        <div>
            <Group gap={8} align="center" mb={4}>
                <Text fw={600} size="sm">v{entry.version}</Text>
                <Badge
                    size="xs"
                    variant="dot"
                    color={meta.color}
                    styles={{ root: { fontWeight: 500, textTransform: 'none', borderColor: 'transparent', paddingLeft: 6, paddingRight: 8 } }}
                >
                    {meta[lang]}
                </Badge>
                <Text size="xs" c="dimmed">{entry.date}</Text>
            </Group>
            <Text size="sm" fw={500} c="dark" mb={6}>{entry.title[lang]}</Text>
            {entry.about || entry.usage || entry.notes ? (
                <Stack gap={8}>
                    {entry.about && <ChangelogSection label={SECTION_LABELS.about[lang]} text={entry.about[lang]} />}
                    {entry.usage && <ChangelogSection label={SECTION_LABELS.usage[lang]} text={entry.usage[lang]} />}
                    {entry.notes && <ChangelogSection label={SECTION_LABELS.notes[lang]} text={entry.notes[lang]} />}
                </Stack>
            ) : (
                <Stack gap={2}>
                    {entry.features?.map((f, fi) => (
                        <Text key={fi} size="xs" c="dimmed">• {f[lang]}</Text>
                    ))}
                </Stack>
            )}
        </div>
    );
}

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
    const lang: Lang = i18n.language === 'tr' ? 'tr' : 'en';

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
            size={528}
            radius="lg"
        >
            <ScrollArea.Autosize mah="70vh" offsetScrollbars>
                <Accordion
                    defaultValue={MINOR_GROUPS[0]?.key}
                    variant="separated"
                    radius="md"
                    chevronPosition="right"
                >
                    {MINOR_GROUPS.map((g, gi) => (
                        <Accordion.Item key={g.key} value={g.key}>
                            <Accordion.Control icon={<IconSparkles size={16} color="var(--mantine-color-violet-5)" />}>
                                <Group gap={8} align="center">
                                    <Text fw={700} size="sm">v{g.key}</Text>
                                    <Badge size="xs" variant="light" color="gray">
                                        {g.entries.length} {lang === 'tr' ? 'güncelleme' : (g.entries.length === 1 ? 'update' : 'updates')}
                                    </Badge>
                                    {gi === 0 && (
                                        <Badge size="xs" variant="filled" color="violet">
                                            {lang === 'tr' ? 'Güncel' : 'Latest'}
                                        </Badge>
                                    )}
                                </Group>
                            </Accordion.Control>
                            <Accordion.Panel>
                                <Stack gap="lg">
                                    {g.entries.map((entry) => (
                                        <EntryItem key={entry.version} entry={entry} lang={lang} />
                                    ))}
                                </Stack>
                            </Accordion.Panel>
                        </Accordion.Item>
                    ))}
                </Accordion>
            </ScrollArea.Autosize>
        </Modal>
    );
}
