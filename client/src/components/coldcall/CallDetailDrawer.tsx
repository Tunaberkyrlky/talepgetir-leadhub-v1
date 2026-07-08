/**
 * Çağrı detayı — ses kaydı player'ı, AI özeti (aksiyon maddeleri + duygu) ve
 * konuşma balonlu transkript. Transkript hazır değilken poll'lar.
 */
import { Alert, Badge, Box, Button, Drawer, Group, Loader, Paper, Stack, Text, Title } from '@mantine/core';
import { IconRefresh, IconSparkles } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { coldcallApi } from './api';
import { CallStatusBadge, SentimentBadge } from './badges';
import { dispositionLabel } from './labels';
import { TERMINAL_CALL_STATUSES } from './types';

interface Props {
    callId: string | null;
    onClose: () => void;
}

export default function CallDetailDrawer({ callId, onClose }: Props) {
    const { t } = useTranslation();
    const qc = useQueryClient();

    const detailQuery = useQuery({
        queryKey: ['coldcall', 'call', callId],
        queryFn: () => coldcallApi.callDetail(callId!),
        enabled: !!callId,
        refetchInterval: (query) => {
            const d = query.state.data;
            if (!d) return 2000;
            const callDone = TERMINAL_CALL_STATUSES.includes(d.call.status);
            const pipelineDone =
                (!d.recording || d.recording.status !== 'processing') &&
                (!d.transcript || d.transcript.status !== 'pending');
            return callDone && pipelineDone ? false : 2000;
        },
    });

    const retryMutation = useMutation({
        mutationFn: () => coldcallApi.retrySummary(callId!),
        onSuccess: () => qc.invalidateQueries({ queryKey: ['coldcall', 'call', callId] }),
    });

    const d = detailQuery.data;

    return (
        <Drawer opened={!!callId} onClose={onClose} position="right" size="lg" title={t('coldcall.callDetail', 'Call detail')}>
            {!d ? (
                <Group justify="center" p="xl"><Loader /></Group>
            ) : (
                <Stack gap="md">
                    <Group justify="space-between">
                        <div>
                            <Title order={4}>{d.call.company?.name ?? d.call.to_e164}</Title>
                            <Text size="sm" c="dimmed">
                                {d.call.from_e164} → {d.call.to_e164}
                                {d.call.to_country ? ` (${d.call.to_country})` : ''}
                            </Text>
                        </div>
                        <CallStatusBadge status={d.call.status} />
                    </Group>

                    <Group gap="lg">
                        <Text size="sm">
                            {t('coldcall.duration', 'Duration')}: <b>{d.call.duration_sec ?? 0} sn</b>
                        </Text>
                        <Text size="sm">
                            {t('coldcall.billedMinutes', 'Quota minutes')}: <b>{d.call.billed_minutes ?? 0}</b>
                            {Number(d.call.rate_multiplier) > 1 && (
                                <Badge ml={6} size="xs" color="orange" variant="light">{Number(d.call.rate_multiplier)}x</Badge>
                            )}
                        </Text>
                        <Text size="sm">
                            {t('coldcall.disposition', 'Call outcome')}: <b>{dispositionLabel(t, d.call.disposition)}</b>
                        </Text>
                    </Group>

                    {/* Ses kaydı */}
                    <Paper withBorder p="md" radius="md">
                        <Text fw={600} size="sm" mb="xs">{t('coldcall.recording', 'Recording')}</Text>
                        {d.recording?.status === 'stored' && d.recording.url ? (
                            <audio controls src={d.recording.url} style={{ width: '100%' }} />
                        ) : d.recording?.status === 'processing' ? (
                            <Group gap="xs"><Loader size="xs" /><Text size="sm" c="dimmed">{t('coldcall.recordingProcessing', 'Recording is being processed…')}</Text></Group>
                        ) : (
                            <Text size="sm" c="dimmed">{t('coldcall.noRecording', 'No recording for this call.')}</Text>
                        )}
                    </Paper>

                    {/* AI özeti */}
                    <Paper withBorder p="md" radius="md">
                        <Group justify="space-between" mb="xs">
                            <Group gap={6}>
                                <IconSparkles size={16} />
                                <Text fw={600} size="sm">{t('coldcall.aiSummary', 'AI summary')}</Text>
                                <SentimentBadge sentiment={d.transcript?.sentiment} />
                            </Group>
                            {d.transcript && (
                                <Button
                                    size="compact-xs"
                                    variant="subtle"
                                    leftSection={<IconRefresh size={14} />}
                                    loading={retryMutation.isPending}
                                    onClick={() => retryMutation.mutate()}
                                >
                                    {t('coldcall.regenerate', 'Regenerate')}
                                </Button>
                            )}
                        </Group>
                        {d.transcript?.status === 'done' && d.transcript.summary ? (
                            <Stack gap="xs">
                                <Text size="sm">{d.transcript.summary}</Text>
                                {(d.transcript.action_items?.length ?? 0) > 0 && (
                                    <Box>
                                        <Text size="xs" fw={600} c="dimmed" mb={4}>{t('coldcall.actionItems', 'Action items')}</Text>
                                        <Stack gap={4}>
                                            {d.transcript.action_items!.map((a, i) => (
                                                <Text key={i} size="sm">• {a}</Text>
                                            ))}
                                        </Stack>
                                    </Box>
                                )}
                            </Stack>
                        ) : d.transcript?.status === 'pending' || (d.recording?.status === 'processing') ? (
                            <Group gap="xs"><Loader size="xs" /><Text size="sm" c="dimmed">{t('coldcall.summaryPending', 'AI summary is being generated…')}</Text></Group>
                        ) : d.transcript?.status === 'failed' ? (
                            <Alert color="yellow" variant="light">{t('coldcall.summaryFailed', 'Transcript/summary could not be generated.')}</Alert>
                        ) : (
                            <Text size="sm" c="dimmed">{t('coldcall.noTranscript', 'No transcript for this call.')}</Text>
                        )}
                    </Paper>

                    {/* Transkript */}
                    {(d.transcript?.segments?.length ?? 0) > 0 && (
                        <Paper withBorder p="md" radius="md">
                            <Text fw={600} size="sm" mb="sm">{t('coldcall.transcript', 'Transcript')}</Text>
                            <Stack gap="xs">
                                {d.transcript!.segments!.map((s, i) => (
                                    <Group key={i} justify={s.speaker === 'agent' ? 'flex-end' : 'flex-start'} wrap="nowrap">
                                        <Paper
                                            p="xs"
                                            radius="md"
                                            maw="85%"
                                            bg={s.speaker === 'agent' ? 'violet.0' : 'gray.1'}
                                        >
                                            <Text size="xs" c="dimmed" mb={2}>
                                                {s.speaker === 'agent' ? t('coldcall.speakerAgent', 'You') : t('coldcall.speakerLead', 'Lead')}
                                                {' · '}{Math.floor(s.start_sec / 60)}:{String(Math.floor(s.start_sec % 60)).padStart(2, '0')}
                                            </Text>
                                            <Text size="sm">{s.text}</Text>
                                        </Paper>
                                    </Group>
                                ))}
                            </Stack>
                        </Paper>
                    )}
                </Stack>
            )}
        </Drawer>
    );
}
