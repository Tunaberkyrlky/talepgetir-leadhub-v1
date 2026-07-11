/**
 * WizardShell — reusable Typeform-style chrome (WP6).
 * One screen, one task (tg-research-ana-akis.md ilke 0.1): a progress indicator, a single
 * primary CTA, a "Geri" (back) button, and a children slot for the step content. Purely
 * presentational — no business logic, no data fetching — so WP7-WP10 steps can all mount
 * inside it without re-deriving the chrome.
 */
import type { ReactNode } from 'react';
import { Container, Paper, Stack, Group, Title, Text, Button, Progress } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';

export interface WizardShellProps {
    /** 1-indexed current step. */
    step: number;
    /** Total steps in the flow (used for the "Adım X / N" label and progress bar). */
    totalSteps: number;
    title: string;
    subtitle?: string;
    /** Omit to hide the back button (e.g. on the very first step). */
    onBack?: () => void;
    /** Omit to hide the primary CTA (e.g. a pure informational screen). */
    primaryLabel?: string;
    onPrimary?: () => void;
    primaryLoading?: boolean;
    primaryDisabled?: boolean;
    /** Extra controls next to the primary CTA (e.g. a secondary "advanced view" link). */
    secondaryActions?: ReactNode;
    /** WP10: steps that embed an existing full-page panel (a data table + its own launcher
     *  chrome, e.g. CompaniesPanel/EnrichmentPanel) need more than the default single-column
     *  "sm" width — those panels were built for a full page, not a Typeform card, and crowd
     *  badly at ~510px. Every other step (a form, one card, one wait screen) keeps the default
     *  narrow width, which is the whole point of the one-screen-one-task chrome. */
    wide?: boolean;
    children: ReactNode;
}

export default function WizardShell({
    step,
    totalSteps,
    title,
    subtitle,
    onBack,
    primaryLabel,
    onPrimary,
    primaryLoading,
    primaryDisabled,
    secondaryActions,
    wide,
    children,
}: WizardShellProps) {
    const { t } = useTranslation();
    const progressValue = totalSteps > 0 ? Math.min(100, Math.max(0, (step / totalSteps) * 100)) : 0;

    return (
        <Container size={wide ? 'lg' : 'sm'} py="xl">
            <Stack gap="lg">
                <Stack gap={6}>
                    <Text size="sm" c="dimmed" fw={500}>
                        {t('research.wizard.stepOf', 'Step {{step}} / {{total}}', { step, total: totalSteps })}
                    </Text>
                    <Progress value={progressValue} size="sm" radius="xl" />
                </Stack>

                <Paper withBorder radius="md" p="xl">
                    <Stack gap="md">
                        <div>
                            <Title order={3}>{title}</Title>
                            {subtitle && (
                                <Text c="dimmed" size="sm" mt={4}>
                                    {subtitle}
                                </Text>
                            )}
                        </div>
                        {children}
                    </Stack>
                </Paper>

                <Group justify="space-between">
                    <div>
                        {onBack && (
                            <Button variant="subtle" color="gray" leftSection={<IconArrowLeft size={16} />} onClick={onBack}>
                                {t('research.wizard.back', 'Back')}
                            </Button>
                        )}
                    </div>
                    <Group gap="sm">
                        {secondaryActions}
                        {primaryLabel && onPrimary && (
                            <Button onClick={onPrimary} loading={primaryLoading} disabled={primaryDisabled}>
                                {primaryLabel}
                            </Button>
                        )}
                    </Group>
                </Group>
            </Stack>
        </Container>
    );
}
