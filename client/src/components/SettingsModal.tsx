import { Modal, Switch, Group, Text, useMantineColorScheme, useComputedColorScheme, Tabs, Stack } from '@mantine/core';
import { IconSun, IconMoon, IconAdjustments, IconArrowsShuffle } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import PipelineSettingsEditor from './PipelineSettingsEditor';

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
        <Modal opened={opened} onClose={onClose} title={t('settings.title')} size="lg">
            <Tabs defaultValue="general">
                <Tabs.List mb="md">
                    <Tabs.Tab value="general" leftSection={<IconAdjustments size={14} />}>
                        {t('settings.general')}
                    </Tabs.Tab>
                    <Tabs.Tab value="pipeline" leftSection={<IconArrowsShuffle size={14} />}>
                        {t('settings.pipelineTab')}
                    </Tabs.Tab>
                </Tabs.List>

                <Tabs.Panel value="general">
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
                    </Stack>
                </Tabs.Panel>

                <Tabs.Panel value="pipeline">
                    <PipelineSettingsEditor />
                </Tabs.Panel>
            </Tabs>
        </Modal>
    );
}
