import { Container, Title, Text, Stack } from '@mantine/core';
import { IconChartBar } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';

// Phase 2: Full dashboard with charts and stats will be implemented here
export default function DashboardPage() {
    const { t } = useTranslation();
    return (
        <Container size="xl">
            <Stack align="center" justify="center" h={400} gap="md">
                <IconChartBar size={64} color="var(--mantine-color-violet-5)" stroke={1.5} />
                <Title order={2}>{t('nav.dashboard')}</Title>
                <Text c="dimmed">{t('dashboard.comingSoon', 'Dashboard coming in Phase 2')}</Text>
            </Stack>
        </Container>
    );
}
