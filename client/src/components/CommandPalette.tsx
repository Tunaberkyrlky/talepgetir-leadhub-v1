import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    Modal,
    TextInput,
    ScrollArea,
    UnstyledButton,
    Group,
    Text,
    Box,
    Loader,
    Kbd,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
    IconSearch,
    IconBuilding,
    IconListCheck,
    IconUser,
    IconCornerDownLeft,
} from '@tabler/icons-react';
import api from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import TaskForm from './tasks/TaskForm';
import CompanyForm from './CompanyForm';
import ContactForm from './ContactForm';

// aria-activedescendant / option ids must be valid DOM ids; row keys carry ':' and '/'.
const optionId = (key: string) => `cmdp-opt-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
const LISTBOX_ID = 'command-palette-listbox';

// Layout.tsx navItems ile aynı şekil — gating orada yapılır, palet aynı listeyi tüketir.
export interface CommandPaletteNavItem {
    path: string;
    label: string;
    icon: ReactNode;
}

interface CommandPaletteProps {
    opened: boolean;
    onOpen: () => void;
    onClose: () => void;
    navItems: CommandPaletteNavItem[];
}

// Klavye ile gezilen düz satır listesi: her satır kendi seçildiğinde ne yapacağını taşır.
interface PaletteRow {
    key: string;
    label: string;
    icon: ReactNode;
    onSelect: () => void;
}

export default function CommandPalette({ opened, onOpen, onClose, navItems }: CommandPaletteProps) {
    const { t, i18n } = useTranslation();
    const { activeTenantId } = useAuth();
    const navigate = useNavigate();

    const [search, setSearch] = useState('');
    const [debounced] = useDebouncedValue(search, 250);
    // Aktif seçim satır KEY'i ile tutulur (sayısal index değil): async firma sonuçları gelip
    // satır sırası kayınca aynı index farklı satırı gösterip Enter'ın yanlış aksiyonu tetiklemesini önler.
    const [activeKey, setActiveKey] = useState<string | null>(null);
    const activeRef = useRef<HTMLButtonElement | null>(null);

    // Türkçe 'İ/ı' için doğru küçültme: i18n diline göre locale-aware karşılaştırma.
    const lang = i18n.resolvedLanguage || 'tr';

    // Palet içinden açılan hızlı-oluşturma modalleri (mevcut form bileşenleri reuse edilir).
    const [taskOpen, setTaskOpen] = useState(false);
    const [companyOpen, setCompanyOpen] = useState(false);
    const [contactOpen, setContactOpen] = useState(false);

    const q = debounced.trim();
    const qLower = q.toLocaleLowerCase(lang);

    // Global Cmd/Ctrl+K: bir input/textarea/contentEditable odaktayken tetiklenmesin,
    // aksi halde tarayıcı varsayılanını iptal edip paleti aç.
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if ((e.key !== 'k' && e.key !== 'K') || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) {
                return;
            }
            const el = document.activeElement as HTMLElement | null;
            const tag = el?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
            // Palet kapalıyken başka bir modal (Mantine dialog) açıksa açma — çift modal/focus-trap olmasın.
            if (!opened && document.querySelector('[role="dialog"][aria-modal="true"]')) return;
            e.preventDefault();
            onOpen();
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [onOpen, opened]);

    // Açılışta temiz başla ve arama değişince seçimi başa al. Effect yerine render
    // sırasında önceki değeri kıyaslarız (React'in önerdiği "adjust state during render"
    // deseni) — böylece cascading-render lint kuralına takılmadan senkron güncelleriz.
    const [prevOpened, setPrevOpened] = useState(opened);
    if (opened !== prevOpened) {
        setPrevOpened(opened);
        if (opened) setSearch('');
        setActiveKey(null);
    }
    const [prevDebounced, setPrevDebounced] = useState(debounced);
    if (debounced !== prevDebounced) {
        setPrevDebounced(debounced);
        setActiveKey(null);
    }

    // Firma araması: tenant query KEY'e pinlenir (mutable closure değil) — tenant değişince
    // refetch olur ve önceki tenant'ın firmaları asla yeni tenant'ın key'i altında görünmez.
    const companyQuery = useQuery<{ data: { id: string; name: string }[] }>({
        queryKey: ['command-palette-companies', activeTenantId, q],
        queryFn: async ({ queryKey, signal }) => {
            const tid = queryKey[1] as string;
            return (await api.get('/companies', {
                params: { search: q, limit: 8 },
                headers: { 'X-Tenant-Id': tid },
                signal,
            })).data;
        },
        enabled: opened && q.length > 0 && !!activeTenantId,
        staleTime: 30_000,
    });

    // --- Satırları kur (nav → firma → oluştur sırası; düz index klavye seçimini besler) ---
    const navRows: PaletteRow[] = navItems
        .filter((item) => !qLower || item.label.toLocaleLowerCase(lang).includes(qLower))
        .map((item) => ({
            key: `nav:${item.path}`,
            label: item.label,
            icon: item.icon,
            onSelect: () => {
                onClose();
                navigate(item.path);
            },
        }));

    const companyList = q.length > 0 ? companyQuery.data?.data ?? [] : [];
    const companyRows: PaletteRow[] = companyList.map((c) => ({
        key: `company:${c.id}`,
        label: c.name,
        icon: <IconBuilding size={18} />,
        onSelect: () => {
            onClose();
            navigate(`/companies/${c.id}`);
        },
    }));

    const createDefs = [
        { key: 'create:task', label: t('commandMenu.newTask', 'Yeni görev'), icon: <IconListCheck size={18} />, open: () => setTaskOpen(true) },
        { key: 'create:company', label: t('commandMenu.newCompany', 'Yeni firma'), icon: <IconBuilding size={18} />, open: () => setCompanyOpen(true) },
        { key: 'create:contact', label: t('commandMenu.newContact', 'Yeni kişi'), icon: <IconUser size={18} />, open: () => setContactOpen(true) },
    ];
    const createRows: PaletteRow[] = createDefs
        .filter((a) => !qLower || a.label.toLocaleLowerCase(lang).includes(qLower))
        .map((a) => ({
            key: a.key,
            label: a.label,
            icon: a.icon,
            onSelect: () => {
                onClose();
                a.open();
            },
        }));

    const rows = [...navRows, ...companyRows, ...createRows];
    // Aktif key artık listede yoksa (rows değişti) ilk satıra sıfırla — index kaymasına bağışık.
    const resolvedActiveKey = activeKey && rows.some((r) => r.key === activeKey)
        ? activeKey
        : (rows[0]?.key ?? null);
    const activeIndex = resolvedActiveKey ? rows.findIndex((r) => r.key === resolvedActiveKey) : -1;

    // Seçili satır görünür kalsın (klavyeyle liste dışına kayınca).
    useEffect(() => {
        activeRef.current?.scrollIntoView({ block: 'nearest' });
    }, [resolvedActiveKey, rows.length]);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (rows.length === 0) return;
        const cur = activeIndex >= 0 ? activeIndex : 0;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActiveKey(rows[Math.min(cur + 1, rows.length - 1)].key);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveKey(rows[Math.max(cur - 1, 0)].key);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            rows[cur]?.onSelect();
        }
    };

    const sections = [
        { id: 'navigate', title: t('commandMenu.sections.navigate', 'Git'), rows: navRows, base: 0 },
        { id: 'companies', title: t('commandMenu.sections.companies', 'Firmalar'), rows: companyRows, base: navRows.length },
        { id: 'create', title: t('commandMenu.sections.create', 'Hızlı oluştur'), rows: createRows, base: navRows.length + companyRows.length },
    ].filter((s) => s.rows.length > 0);

    const showCompanyLoader = q.length > 0 && companyQuery.isFetching;

    return (
        <>
            <Modal
                opened={opened}
                onClose={onClose}
                withCloseButton={false}
                size="lg"
                padding={0}
                radius="lg"
                overlayProps={{ backgroundOpacity: 0.4, blur: 4 }}
                styles={{ body: { padding: 0 } }}
                aria-label={t('commandMenu.open', 'Command menu')}
            >
                <Box p="xs" style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}>
                    <TextInput
                        value={search}
                        onChange={(e) => setSearch(e.currentTarget.value)}
                        onKeyDown={handleKeyDown}
                        placeholder={t('commandMenu.placeholder', 'Ara ya da bir komut yaz...')}
                        variant="unstyled"
                        size="md"
                        autoFocus
                        data-autofocus
                        leftSection={<IconSearch size={18} />}
                        role="combobox"
                        aria-expanded={rows.length > 0}
                        aria-controls={LISTBOX_ID}
                        aria-activedescendant={resolvedActiveKey ? optionId(resolvedActiveKey) : undefined}
                        aria-label={t('commandMenu.placeholder', 'Ara ya da bir komut yaz...')}
                    />
                </Box>

                <ScrollArea.Autosize mah={380} type="scroll">
                    <Box p="xs" role="listbox" id={LISTBOX_ID} aria-label={t('commandMenu.open', 'Command menu')}>
                        {rows.length === 0 ? (
                            <Group justify="center" py="lg" gap="xs">
                                {showCompanyLoader ? (
                                    <Loader size="sm" color="violet" />
                                ) : companyQuery.isError ? (
                                    <Text size="sm" c="red">
                                        {t('commandMenu.loadError', 'Firmalar yüklenemedi')}
                                    </Text>
                                ) : (
                                    <Text size="sm" c="dimmed">
                                        {t('commandMenu.noResults', 'Sonuç yok')}
                                    </Text>
                                )}
                            </Group>
                        ) : (
                            <>
                            {sections.map((section) => (
                                <Box key={section.id} mb={4}>
                                    <Text size="xs" fw={600} c="dimmed" tt="uppercase" px="xs" py={4}>
                                        {section.title}
                                    </Text>
                                    {section.rows.map((row) => {
                                        const active = row.key === resolvedActiveKey;
                                        return (
                                            <UnstyledButton
                                                key={row.key}
                                                id={optionId(row.key)}
                                                role="option"
                                                aria-selected={active}
                                                ref={active ? activeRef : undefined}
                                                onMouseMove={() => setActiveKey(row.key)}
                                                onClick={row.onSelect}
                                                style={{
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'space-between',
                                                    width: '100%',
                                                    padding: '8px 10px',
                                                    borderRadius: 8,
                                                    background: active ? 'var(--mantine-color-violet-light)' : 'transparent',
                                                }}
                                            >
                                                <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                                                    <Box style={{ display: 'flex', color: active ? 'var(--mantine-color-violet-filled)' : 'var(--mantine-color-dimmed)' }}>
                                                        {row.icon}
                                                    </Box>
                                                    <Text size="sm" truncate>
                                                        {row.label}
                                                    </Text>
                                                </Group>
                                                {active && <IconCornerDownLeft size={16} style={{ color: 'var(--mantine-color-dimmed)', flexShrink: 0 }} />}
                                            </UnstyledButton>
                                        );
                                    })}
                                </Box>
                            ))}
                            {companyQuery.isError && (
                                <Text size="sm" c="red" px="xs" py={4}>
                                    {t('commandMenu.loadError', 'Firmalar yüklenemedi')}
                                </Text>
                            )}
                            </>
                        )}
                    </Box>
                </ScrollArea.Autosize>

                <Group
                    justify="flex-end"
                    gap="md"
                    px="sm"
                    py={6}
                    style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}
                >
                    <Group gap={4}>
                        <Kbd>↑</Kbd>
                        <Kbd>↓</Kbd>
                        <Text size="xs" c="dimmed">{t('commandMenu.hintNavigate', 'gez')}</Text>
                    </Group>
                    <Group gap={4}>
                        <Kbd>↵</Kbd>
                        <Text size="xs" c="dimmed">{t('commandMenu.hintSelect', 'seç')}</Text>
                    </Group>
                    <Group gap={4}>
                        <Kbd>esc</Kbd>
                        <Text size="xs" c="dimmed">{t('commandMenu.hintClose', 'kapat')}</Text>
                    </Group>
                </Group>
            </Modal>

            {/* Hızlı oluşturma: mevcut form modalleri reuse edilir (çift kayıt üretmez). */}
            <TaskForm opened={taskOpen} onClose={() => setTaskOpen(false)} enableCompanyPicker />
            <CompanyForm opened={companyOpen} onClose={() => setCompanyOpen(false)} company={null} />
            <ContactForm opened={contactOpen} onClose={() => setContactOpen(false)} contact={null} />
        </>
    );
}
