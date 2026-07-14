/**
 * LinkedInPage — top-level page shell for the LinkedIn outreach module.
 * LinkedIn is its own outreach channel (alongside Cold Call), not a Research sub-feature —
 * this page just hosts LinkedInPanel, which owns its own accounts/campaigns/inbox/suppression
 * sub-tabs and ?sub= deep-linking.
 */
import { Container, Stack, Text, Title } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import LinkedInPanel from '../../components/linkedin/LinkedInPanel';

export default function LinkedInPage() {
    const { t } = useTranslation();

    return (
        <Container size="xl" py="md">
            <Stack gap="lg">
                <div>
                    <Title order={2}>{t('nav.linkedin', 'LinkedIn')}</Title>
                    <Text c="dimmed" size="sm">
                        {t('research.linkedin.subtitle', 'Reach your leads on LinkedIn — connect accounts, run campaigns and manage replies.')}
                    </Text>
                </div>
                <LinkedInPanel />
            </Stack>
        </Container>
    );
}
