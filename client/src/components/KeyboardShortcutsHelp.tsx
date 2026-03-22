import { Modal, Table, Text, Kbd, Group, Stack, Divider } from '@mantine/core';
import { useTranslation } from 'react-i18next';

interface ShortcutGroup {
    title: string;
    shortcuts: { keys: string[]; description: string }[];
}

interface KeyboardShortcutsHelpProps {
    opened: boolean;
    onClose: () => void;
}

const isMac = navigator.platform.toUpperCase().includes('MAC');
const mod = isMac ? 'Cmd' : 'Ctrl';

export default function KeyboardShortcutsHelp({ opened, onClose }: KeyboardShortcutsHelpProps) {
    const { t } = useTranslation();

    const groups: ShortcutGroup[] = [
        {
            title: t('shortcuts.global', 'Genel'),
            shortcuts: [
                { keys: ['F1'], description: t('shortcuts.help', 'Klavye kısayollarını göster') },
                { keys: [mod, 'K'], description: t('shortcuts.search', 'Arama kutusuna odaklan') },
                { keys: ['Escape'], description: t('shortcuts.close', 'Kapat / Geri dön') },
                { keys: [mod, 'Z'], description: t('shortcuts.undo', 'Son işlemi geri al') },
            ],
        },
        {
            title: t('shortcuts.tables', 'Tablolar'),
            shortcuts: [
                { keys: ['Shift', 'Click'], description: t('shortcuts.rangeSelect', 'Aralık seçimi') },
                { keys: [mod, 'A'], description: t('shortcuts.selectAll', 'Tümünü seç / seçimi kaldır') },
                { keys: ['N'], description: t('shortcuts.new', 'Yeni kayıt ekle') },
                { keys: ['Delete'], description: t('shortcuts.delete', 'Seçili kaydı sil') },
            ],
        },
        {
            title: t('shortcuts.pipeline', 'Pipeline'),
            shortcuts: [
                { keys: ['1'], description: t('shortcuts.boardView', 'Board görünümü') },
                { keys: ['2'], description: t('shortcuts.tableView', 'Tablo görünümü') },
                { keys: ['S'], description: t('shortcuts.settings', 'Pipeline ayarları') },
                { keys: ['Escape'], description: t('shortcuts.exitSpotlight', 'Odak modundan çık') },
            ],
        },
        {
            title: t('shortcuts.forms', 'Formlar'),
            shortcuts: [
                { keys: ['Enter'], description: t('shortcuts.submit', 'Formu gönder') },
                { keys: ['Escape'], description: t('shortcuts.cancel', 'İptal') },
            ],
        },
    ];

    return (
        <Modal
            opened={opened}
            onClose={onClose}
            title={
                <Group gap="xs">
                    <Text fw={600}>{t('shortcuts.title', 'Klavye Kısayolları')}</Text>
                </Group>
            }
            size="md"
            radius="lg"
        >
            <Stack gap="lg">
                {groups.map((group, gi) => (
                    <div key={gi}>
                        {gi > 0 && <Divider mb="sm" />}
                        <Text size="xs" fw={700} tt="uppercase" c="dimmed" mb="xs" style={{ letterSpacing: '0.5px' }}>
                            {group.title}
                        </Text>
                        <Table verticalSpacing={4} horizontalSpacing="sm">
                            <Table.Tbody>
                                {group.shortcuts.map((s, si) => (
                                    <Table.Tr key={si}>
                                        <Table.Td style={{ width: 160 }}>
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
                                            <Text size="sm">{s.description}</Text>
                                        </Table.Td>
                                    </Table.Tr>
                                ))}
                            </Table.Tbody>
                        </Table>
                    </div>
                ))}
            </Stack>
        </Modal>
    );
}
