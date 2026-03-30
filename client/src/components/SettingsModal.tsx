import { useEffect, useRef, useState, useCallback } from 'react';
import {
    Modal,
    Switch,
    Group,
    Text,
    useMantineColorScheme,
    useComputedColorScheme,
    Stack,
    NavLink,
    Table,
    Kbd,
    Divider,
    Button,
    Box,
    ScrollArea,
    Collapse,
    UnstyledButton,
    TextInput,
    ActionIcon,
    Alert,
    CopyButton,
    Tooltip,
} from '@mantine/core';
import {
    IconSun,
    IconMoon,
    IconLanguage,
    IconSettings,
    IconColumns,
    IconChevronDown,
    IconChevronRight,
    IconWebhook,
    IconCopy,
    IconCheck,
    IconInfoCircle,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import PipelineSettingsEditor, { type PipelineSettingsEditorHandle } from './PipelineSettingsEditor';

interface SettingsModalProps {
    opened: boolean;
    onClose: () => void;
    defaultTab?: string;
}

const isMac = navigator.platform.toUpperCase().includes('MAC');
const mod = isMac ? 'Cmd' : 'Ctrl';

const SHORTCUTS = [
    { keys: ['F1'], desc: 'Ayarları aç' },
    { keys: [mod, 'K'], desc: 'Arama' },
    { keys: [mod, 'Z'], desc: 'Geri al' },
    { keys: ['Shift', 'Click'], desc: 'Aralık seçimi' },
    { keys: [mod, 'A'], desc: 'Tümünü seç' },
    { keys: ['N'], desc: 'Yeni kayıt' },
    { keys: ['1'], desc: 'Pipeline board' },
    { keys: ['2'], desc: 'Pipeline tablo' },
    { keys: ['Escape'], desc: 'Kapat / Geri' },
];

export default function SettingsModal({ opened, onClose, defaultTab = 'general' }: SettingsModalProps) {
    const [activeTab, setActiveTab] = useState(defaultTab);
    const [pipelineDirty, setPipelineDirty] = useState(false);
    const [confirmCloseOpened, setConfirmCloseOpened] = useState(false);
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    const pipelineSaveRef = useRef<PipelineSettingsEditorHandle | null>(null);

    useEffect(() => {
        if (opened) setActiveTab(defaultTab);
    }, [opened, defaultTab]);

    const { setColorScheme } = useMantineColorScheme();
    const computed = useComputedColorScheme('light');
    const { t, i18n } = useTranslation();
    const { activeTenantId } = useAuth();
    const isDark = computed === 'dark';
    const isTurkish = i18n.language === 'tr';

    const toggleLanguage = () => {
        const newLang = isTurkish ? 'en' : 'tr';
        i18n.changeLanguage(newLang);
        localStorage.setItem('lang', newLang);
    };

    const handleClose = useCallback(() => {
        if (pipelineDirty) {
            setConfirmCloseOpened(true);
        } else {
            onClose();
        }
    }, [pipelineDirty, onClose]);

    const handleConfirmDiscard = useCallback(() => {
        setConfirmCloseOpened(false);
        setPipelineDirty(false);
        onClose();
    }, [onClose]);

    const handleConfirmSave = useCallback(() => {
        pipelineSaveRef.current?.save();
        setConfirmCloseOpened(false);
    }, []);

    const webhookUrl = activeTenantId
        ? `${window.location.origin}/api/webhooks/plusvibe/${activeTenantId}`
        : '';

    const tabs = [
        { value: 'general', label: t('settings.general', 'Genel'), icon: <IconSettings size={18} /> },
        { value: 'pipeline', label: t('settings.pipelineTab', 'Pipeline'), icon: <IconColumns size={18} /> },
        { value: 'integrations', label: t('settings.integrationsTab', 'Entegrasyonlar'), icon: <IconWebhook size={18} /> },
    ];

    return (
        <>
            <Modal
                opened={opened}
                onClose={handleClose}
                title={t('settings.title')}
                size="xl"
                radius="lg"
                styles={{
                    body: { padding: 0 },
                    header: { paddingBottom: 0, borderBottom: '1px solid var(--mantine-color-default-border)' },
                }}
            >
                <Box style={{ display: 'flex', minHeight: 420 }}>
                    {/* Sidebar */}
                    <Box
                        style={{
                            width: 180,
                            flexShrink: 0,
                            borderRight: '1px solid var(--mantine-color-default-border)',
                            paddingTop: 8,
                        }}
                    >
                        <Stack gap={2} px={6}>
                            {tabs.map((tab) => (
                                <NavLink
                                    key={tab.value}
                                    active={activeTab === tab.value}
                                    label={tab.label}
                                    leftSection={tab.icon}
                                    onClick={() => setActiveTab(tab.value)}
                                    styles={{ root: { borderRadius: 8 } }}
                                    variant="light"
                                />
                            ))}
                        </Stack>
                    </Box>

                    {/* Content */}
                    <ScrollArea style={{ flex: 1 }} mah={520} offsetScrollbars>
                        <Box p="lg">
                            {activeTab === 'general' && (
                                <Stack gap="md">
                                    {/* Appearance */}
                                    <Text size="sm" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.5px' }}>
                                        {t('settings.appearance', 'Görünüm')}
                                    </Text>
                                    <Group justify="space-between" py="xs" px="sm"
                                        style={{ borderRadius: 8, background: 'var(--mantine-color-default-hover)' }}>
                                        <Group gap="sm">
                                            {isDark ? <IconMoon size={18} /> : <IconSun size={18} />}
                                            <div>
                                                <Text size="sm" fw={500}>{t('settings.darkMode')}</Text>
                                                <Text size="xs" c="dimmed">{isDark ? t('settings.darkOn', 'Koyu tema aktif') : t('settings.darkOff', 'Açık tema aktif')}</Text>
                                            </div>
                                        </Group>
                                        <Switch
                                            checked={isDark}
                                            onChange={() => setColorScheme(isDark ? 'light' : 'dark')}
                                        />
                                    </Group>

                                    <Group justify="space-between" py="xs" px="sm"
                                        style={{ borderRadius: 8, background: 'var(--mantine-color-default-hover)' }}>
                                        <Group gap="sm">
                                            <IconLanguage size={18} />
                                            <div>
                                                <Text size="sm" fw={500}>{t('settings.language')}</Text>
                                                <Text size="xs" c="dimmed">{isTurkish ? 'Türkçe' : 'English'}</Text>
                                            </div>
                                        </Group>
                                        <Switch
                                            checked={isTurkish}
                                            onChange={toggleLanguage}
                                            onLabel="TR"
                                            offLabel="EN"
                                            size="lg"
                                        />
                                    </Group>

                                    {/* Keyboard shortcuts — collapsible */}
                                    <Divider mt="sm" />
                                    <UnstyledButton onClick={() => setShortcutsOpen(v => !v)}>
                                        <Group gap="xs">
                                            {shortcutsOpen ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
                                            <Text size="sm" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.5px' }}>
                                                {t('shortcuts.title', 'Klavye Kısayolları')}
                                            </Text>
                                        </Group>
                                    </UnstyledButton>
                                    <Collapse in={shortcutsOpen}>
                                        <Table verticalSpacing={4} horizontalSpacing="sm">
                                            <Table.Tbody>
                                                {SHORTCUTS.map((s, i) => (
                                                    <Table.Tr key={i}>
                                                        <Table.Td style={{ width: 140 }}>
                                                            <Group gap={4}>
                                                                {s.keys.map((k, ki) => (
                                                                    <span key={ki}>
                                                                        {ki > 0 && <Text span size="xs" c="dimmed" mx={2}>+</Text>}
                                                                        <Kbd size="xs">{k}</Kbd>
                                                                    </span>
                                                                ))}
                                                            </Group>
                                                        </Table.Td>
                                                        <Table.Td>
                                                            <Text size="sm">{s.desc}</Text>
                                                        </Table.Td>
                                                    </Table.Tr>
                                                ))}
                                            </Table.Tbody>
                                        </Table>
                                    </Collapse>
                                </Stack>
                            )}

                            {activeTab === 'pipeline' && opened && (
                                <PipelineSettingsEditor
                                    onDirtyChange={setPipelineDirty}
                                    saveRef={pipelineSaveRef}
                                    onSaveSuccess={() => { setPipelineDirty(false); }}
                                />
                            )}

                            {activeTab === 'integrations' && (
                                <Stack gap="md">
                                    <Text size="sm" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.5px' }}>
                                        PlusVibe
                                    </Text>
                                    <Text size="sm" fw={500}>{t('settings.webhookTitle')}</Text>
                                    <Text size="xs" c="dimmed">{t('settings.webhookDesc')}</Text>
                                    <CopyButton value={webhookUrl} timeout={2000}>
                                        {({ copied, copy }) => (
                                            <TextInput
                                                value={webhookUrl}
                                                readOnly
                                                styles={{ input: { fontFamily: 'monospace', fontSize: 12 } }}
                                                rightSection={
                                                    <Tooltip label={copied ? t('settings.webhookCopied') : t('common.copy', 'Kopyala')} withArrow>
                                                        <ActionIcon variant="subtle" color={copied ? 'teal' : 'gray'} onClick={copy}>
                                                            {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                                                        </ActionIcon>
                                                    </Tooltip>
                                                }
                                            />
                                        )}
                                    </CopyButton>
                                    <Alert icon={<IconInfoCircle size={16} />} color="blue" variant="light" radius="md">
                                        <Text size="xs">{t('settings.webhookSecretHint')}</Text>
                                    </Alert>
                                </Stack>
                            )}
                        </Box>
                    </ScrollArea>
                </Box>
            </Modal>

            {/* Unsaved changes confirmation */}
            <Modal
                opened={confirmCloseOpened}
                onClose={() => setConfirmCloseOpened(false)}
                title={t('pipelineSettings.unsavedTitle')}
                size="sm"
                centered
                radius="lg"
            >
                <Text size="sm" mb="lg">{t('pipelineSettings.unsavedDesc')}</Text>
                <Group justify="flex-end">
                    <Button variant="subtle" color="gray" onClick={handleConfirmDiscard}>
                        {t('pipelineSettings.discard')}
                    </Button>
                    <Button onClick={handleConfirmSave}>
                        {t('common.save')}
                    </Button>
                </Group>
            </Modal>
        </>
    );
}
