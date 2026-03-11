import { useState, useEffect } from 'react';
import { Portal, Paper, Progress, Text, Group, Stack, ActionIcon, Badge, ThemeIcon, Button, Tooltip } from '@mantine/core';
import { IconX, IconCheck, IconUpload, IconAlertCircle, IconPlayerStop, IconMinus, IconChevronUp } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { useImportProgress } from '../contexts/ImportProgressContext';

function useElapsedSeconds(startedAt: number | null, active: boolean): number {
    const [elapsed, setElapsed] = useState(0);

    useEffect(() => {
        if (!startedAt || !active) {
            setElapsed(startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0);
            return;
        }
        setElapsed(Math.round((Date.now() - startedAt) / 1000));
        const id = setInterval(() => {
            setElapsed(Math.round((Date.now() - startedAt) / 1000));
        }, 1000);
        return () => clearInterval(id);
    }, [startedAt, active]);

    return elapsed;
}

function formatElapsed(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${s}s`;
}

export default function ImportProgressBar() {
    const { t } = useTranslation();
    const {
        isImporting, isDone, isCancelling,
        fileName, totalRows, progressCount, startedAt,
        result, dismiss, stopImport,
    } = useImportProgress();

    const [minimized, setMinimized] = useState(false);

    const elapsed = useElapsedSeconds(startedAt, isImporting);

    if (!isImporting && !isDone) return null;

    const processed = isDone && result
        ? result.successCount + result.errorCount
        : progressCount;

    const pct = totalRows > 0
        ? Math.min(Math.round((processed / totalRows) * 100), isDone ? 100 : 99)
        : 0;

    const color = isDone
        ? (result?.errorCount === 0 ? 'green' : 'orange')
        : 'violet';

    const label = isCancelling
        ? t('import.progressCancelling')
        : isDone
        ? t('import.progressDone')
        : t('import.progressImporting');

    // Minimized chip view
    if (minimized) {
        return (
            <Portal>
                <Paper
                    shadow="xl"
                    radius="xl"
                    px="md"
                    py={6}
                    withBorder
                    style={{
                        position: 'fixed',
                        bottom: 24,
                        right: 24,
                        zIndex: 9999,
                        borderLeft: `4px solid var(--mantine-color-${color}-6)`,
                        cursor: 'pointer',
                    }}
                    onClick={() => setMinimized(false)}
                >
                    <Group gap="xs" wrap="nowrap">
                        <ThemeIcon size="xs" radius="xl" variant="light" color={color}>
                            {isDone ? (
                                result?.errorCount === 0 ? <IconCheck size={10} /> : <IconAlertCircle size={10} />
                            ) : (
                                <IconUpload size={10} />
                            )}
                        </ThemeIcon>
                        <Text size="xs" fw={600} style={{ whiteSpace: 'nowrap' }}>
                            {label}
                        </Text>
                        {!isDone && (
                            <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                                %{pct}
                            </Text>
                        )}
                        <Tooltip label={t('import.progressExpand')} withArrow>
                            <ActionIcon
                                variant="subtle"
                                color="gray"
                                size="xs"
                                onClick={(e) => { e.stopPropagation(); setMinimized(false); }}
                            >
                                <IconChevronUp size={12} />
                            </ActionIcon>
                        </Tooltip>
                    </Group>
                </Paper>
            </Portal>
        );
    }

    return (
        <Portal>
            <Paper
                shadow="xl"
                radius="lg"
                p="md"
                withBorder
                style={{
                    position: 'fixed',
                    bottom: 24,
                    right: 24,
                    width: 380,
                    zIndex: 9999,
                    borderLeft: `4px solid var(--mantine-color-${color}-6)`,
                }}
            >
                <Stack gap="xs">
                    {/* Header row */}
                    <Group justify="space-between" wrap="nowrap">
                        <Group gap="xs" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
                            <ThemeIcon size="sm" radius="xl" variant="light" color={color}>
                                {isDone ? (
                                    result?.errorCount === 0 ? <IconCheck size={12} /> : <IconAlertCircle size={12} />
                                ) : (
                                    <IconUpload size={12} />
                                )}
                            </ThemeIcon>
                            <Text size="sm" fw={600} truncate style={{ flex: 1 }}>
                                {label}
                            </Text>
                        </Group>

                        <Group gap={4} wrap="nowrap">
                            {/* Elapsed time */}
                            {(isImporting || isDone) && startedAt && (
                                <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                                    {formatElapsed(elapsed)}
                                </Text>
                            )}
                            {/* Minimize button */}
                            <Tooltip label={t('import.progressMinimize')} withArrow>
                                <ActionIcon variant="subtle" color="gray" size="sm" onClick={() => setMinimized(true)}>
                                    <IconMinus size={14} />
                                </ActionIcon>
                            </Tooltip>
                            {/* Close / Dismiss button */}
                            {isDone ? (
                                <Tooltip label={t('import.progressClose')} withArrow>
                                    <ActionIcon variant="subtle" color="gray" size="sm" onClick={dismiss}>
                                        <IconX size={14} />
                                    </ActionIcon>
                                </Tooltip>
                            ) : (
                                <Tooltip label={t('import.progressHide')} withArrow>
                                    <ActionIcon variant="subtle" color="gray" size="sm" onClick={dismiss}>
                                        <IconX size={14} />
                                    </ActionIcon>
                                </Tooltip>
                            )}
                        </Group>
                    </Group>

                    {/* File name */}
                    <Text size="xs" c="dimmed" truncate>
                        {fileName}
                    </Text>

                    {/* Progress bar */}
                    <Progress
                        value={pct}
                        color={isCancelling ? 'orange' : color}
                        animated={isImporting && !isCancelling}
                        radius="xl"
                        size="md"
                    />

                    {/* Stats row + Stop button */}
                    <Group justify="space-between" wrap="nowrap">
                        <Text size="xs" c="dimmed">
                            {processed.toLocaleString()} / {totalRows.toLocaleString()} {t('import.progressRows')}
                            {' · '}
                            <Text span fw={600} c={isDone ? 'green' : 'violet'}>%{pct}</Text>
                        </Text>

                        {/* Stop button — only while importing and not already cancelling */}
                        {isImporting && !isCancelling && (
                            <Button
                                size="compact-xs"
                                variant="subtle"
                                color="red"
                                leftSection={<IconPlayerStop size={11} />}
                                onClick={stopImport}
                            >
                                {t('import.progressStop')}
                            </Button>
                        )}
                    </Group>

                    {/* Result badges */}
                    {isDone && result && (
                        <Group gap="xs">
                            <Badge color="green" size="sm" variant="light">
                                ✓ {result.successCount.toLocaleString()} {t('import.progressSuccessful')}
                            </Badge>
                            {result.errorCount > 0 && (
                                <Badge color="red" size="sm" variant="light">
                                    ✗ {result.errorCount.toLocaleString()} {t('import.progressErrorsLabel')}
                                </Badge>
                            )}
                            {result.createdCompanies > 0 && (
                                <Badge color="blue" size="sm" variant="light">
                                    +{result.createdCompanies} {t('import.progressCompanies')}
                                </Badge>
                            )}
                            {result.createdContacts > 0 && (
                                <Badge color="violet" size="sm" variant="light">
                                    +{result.createdContacts} {t('import.progressContacts')}
                                </Badge>
                            )}
                        </Group>
                    )}
                </Stack>
            </Paper>
        </Portal>
    );
}
