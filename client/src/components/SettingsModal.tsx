import { Modal, Switch, Group, Text, useMantineColorScheme, useComputedColorScheme, Stack } from '@mantine/core';
import { IconSun, IconMoon, IconLanguage } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';

interface SettingsModalProps {
    opened: boolean;
    onClose: () => void;
}

export default function SettingsModal({ opened, onClose }: SettingsModalProps) {
    const { setColorScheme } = useMantineColorScheme();
    const computed = useComputedColorScheme('light');
    const { t, i18n } = useTranslation();
    const isDark = computed === 'dark';
    const isTurkish = i18n.language === 'tr';

    const toggleLanguage = () => {
        const newLang = isTurkish ? 'en' : 'tr';
        i18n.changeLanguage(newLang);
        localStorage.setItem('lang', newLang);
    };

    return (
        <Modal opened={opened} onClose={onClose} title={t('settings.title')}>
            <Stack gap="xs">
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
                <Group justify="space-between" py="xs">
                    <Group gap="xs">
                        <IconLanguage size={18} />
                        <Text size="sm">{t('settings.language')}</Text>
                    </Group>
                    <Switch
                        checked={isTurkish}
                        onChange={toggleLanguage}
                        onLabel="TR"
                        offLabel="EN"
                        size="lg"
                    />
                </Group>
            </Stack>
        </Modal>
    );
}
