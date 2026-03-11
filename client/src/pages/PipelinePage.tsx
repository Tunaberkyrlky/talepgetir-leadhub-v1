import { Container, Title, Text, Stack } from '@mantine/core';
import { IconColumns } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';

// Phase 4: Kanban board with drag-drop will be implemented here
export default function PipelinePage() {
    const { t } = useTranslation();
    return (
        <Container size="xl">
            <Stack align="center" justify="center" h={400} gap="md">
                <IconColumns size={64} color="var(--mantine-color-violet-5)" stroke={1.5} />
                <Title order={2}>{t('nav.pipeline')}</Title>
                <Text c="dimmed">{t('pipeline.comingSoon', 'Pipeline view coming in Phase 4')}</Text>
            </Stack>
        </Container>
    );
}
