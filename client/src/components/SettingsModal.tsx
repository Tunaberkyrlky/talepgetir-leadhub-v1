import { Modal, Switch, Group, Text, useMantineColorScheme, useComputedColorScheme } from '@mantine/core';
import { IconSun, IconMoon } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';

interface SettingsModalProps {
    opened: boolean;
    onClose: () => void;
}

export default function SettingsModal({ opened, onClose }: SettingsModalProps) {
    const { setColorScheme } = useMantineColorScheme();
    const computed = useComputedColorScheme('light');
    const { t } = useTranslation();
    const isDark = computed === 'dark';

    return (
        <Modal opened={opened} onClose={onClose} title={t('settings.title')} size="sm">
            <Group justify="space-between" py="xs">
                <Group gap="xs">
                    {isDark ? <IconMoon size={18} /> : <IconSun size={18} />}
                    <Text size="sm">{t('settings.darkMode')}</Text>
                </Group>
                <Switch
                    checked={isDark}
                    onChange={() => setColorScheme(isDark ? 'light' : 'dark')}
                />
            </Group>
        </Modal>
    );
}
