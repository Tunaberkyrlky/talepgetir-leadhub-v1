import { useState, useMemo } from 'react';
import { Modal, Stack, Group, Text, Badge, Accordion, ScrollArea, SegmentedControl } from '@mantine/core';
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

// İlgili ekran/sayfa etiketleri (başlıkta rozet olarak gösterilir).
const AREA_META = {
    campaigns:  { tr: 'Kampanyalar', en: 'Campaigns' },
    mail:       { tr: 'Mail', en: 'Mail' },
    settings:   { tr: 'Ayarlar', en: 'Settings' },
    import:     { tr: 'İçe Aktarma', en: 'Import' },
    companies:  { tr: 'Şirketler', en: 'Companies' },
    activities: { tr: 'Aktiviteler', en: 'Activities' },
    dashboard:  { tr: 'Dashboard', en: 'Dashboard' },
    pipeline:   { tr: 'Pipeline', en: 'Pipeline' },
    general:    { tr: 'Genel', en: 'General' },
} as const;
type AreaKey = keyof typeof AREA_META;

// entry.area verilmemişse başlıktan çıkarsa — ilk eşleşen kural kazanır (öncelik sırası).
const AREA_RULES: { area: AreaKey; kw: RegExp }[] = [
    { area: 'campaigns',  kw: /kampanya|drip|dizi|spintax|dallanma|node|tuval|görsel akış|görsel kampanya|kitle|adım|campaign|gönderim programı|günlük limit|çoklu kutu|gönderen kutu|test gönder|gönderim kontrol|kutu başına/i },
    { area: 'import',     kw: /içe aktar|import|eşleşme denetimi/i },
    { area: 'settings',   kw: /gmail|outlook|smtp|imap|microsoft|mail sunucu|bağlantısı|ayarlar|connection/i },
    { area: 'pipeline',   kw: /pipeline|kanban/i },
    { area: 'dashboard',  kw: /dashboard|aşama dağılımı/i },
    { area: 'activities', kw: /aktivite/i },
    { area: 'companies',  kw: /şirket|ürün alan|arama sıralaması|company/i },
    { area: 'mail',       kw: /mail|e-posta|yanıt|\bek\b|ekler|eklenti|okundu|gelen|yönlendir|geçmiş|reply|attachment/i },
];

function resolveArea(entry: ChangelogEntry): AreaKey {
    if (entry.area && entry.area in AREA_META) return entry.area as AreaKey;
    const hay = `${entry.title.tr} ${entry.title.en}`;
    for (const r of AREA_RULES) if (r.kw.test(hay)) return r.area;
    return 'general';
}

// Patch sürümlerini minor (major.minor) başlığı altında grupla. changelog en
// yeniden eskiye sıralı olduğundan aynı minor'a ait entry'ler ardışıktır.
function groupByMinor(entries: ChangelogEntry[]): { key: string; entries: ChangelogEntry[] }[] {
    const out: { key: string; entries: ChangelogEntry[] }[] = [];
    for (const e of entries) {
        const key = e.version.split('.').slice(0, 2).join('.'); // "1.10.13" → "1.10"
        const last = out[out.length - 1];
        if (last && last.key === key) last.entries.push(e);
        else out.push({ key, entries: [e] });
    }
    return out;
}

// Default view hides fixes/improvements (feature + security stay) so users notice new
// capabilities without the noise; the "All" toggle reveals everything.
function isHighlightType(t: ChangelogType | undefined): boolean {
    const type = t ?? 'feature';
    return type !== 'fix' && type !== 'improvement';
}

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
    const area = AREA_META[resolveArea(entry)];
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
            <Group gap={6} align="center" mb={6}>
                <Text size="sm" fw={500} c="dark">{entry.title[lang]}</Text>
                <Text size="sm" c="dimmed">—</Text>
                <Badge
                    size="sm"
                    variant="light"
                    color="violet"
                    styles={{ root: { fontWeight: 700, textTransform: 'none' } }}
                >
                    {area[lang]}
                </Badge>
            </Group>
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

    // Default: show only new features (+ security); toggle to also see fixes/improvements.
    const [showAll, setShowAll] = useState(false);
    const groups = useMemo(
        () => groupByMinor(showAll ? changelog : changelog.filter((e) => isHighlightType(e.type))),
        [showAll],
    );

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
            <SegmentedControl
                fullWidth
                size="xs"
                mb="sm"
                value={showAll ? 'all' : 'features'}
                onChange={(v) => setShowAll(v === 'all')}
                data={[
                    { value: 'features', label: lang === 'tr' ? 'Yeni Özellikler' : 'New Features' },
                    { value: 'all', label: lang === 'tr' ? 'Tümü' : 'All' },
                ]}
            />
            <ScrollArea.Autosize mah="70vh" offsetScrollbars>
                <Accordion
                    key={showAll ? 'all' : 'features'}
                    defaultValue={groups[0]?.key}
                    variant="separated"
                    radius="md"
                    chevronPosition="right"
                >
                    {groups.map((g, gi) => (
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
