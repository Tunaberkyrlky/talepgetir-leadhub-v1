import { Badge, Button, Card, Group, Stack, Text } from '@mantine/core';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showErrorFromApi, showSuccess } from '../../lib/notifications';

export interface HsCodeCandidateRow {
    id: string;
    code: string;
    description: string;
    status: 'candidate' | 'approved' | 'rejected';
}

export default function HsCodeCandidates({ candidates, onChanged }: { candidates: HsCodeCandidateRow[]; onChanged: () => void }) {
    const { t } = useTranslation();
    const mut = useMutation({
        mutationFn: async ({ id, status }: { id: string; status: 'approved' | 'rejected' }) =>
            (await api.patch(`/research/hs/${id}`, { status })).data,
        onSuccess: (_data, variables) => {
            showSuccess(variables.status === 'approved'
                ? t('research.hs.approvedToast', 'Code approved.')
                : t('research.hs.rejectedToast', 'Code rejected.'));
            onChanged();
        },
        onError: (err: unknown) => showErrorFromApi(err),
    });

    if (candidates.length === 0) {
        return <Text size="sm" c="dimmed">{t('research.hs.empty', 'Nothing left to review.')}</Text>;
    }

    return (
        <Stack gap="xs">
            {candidates.map((row) => {
                const loading = mut.isPending && mut.variables?.id === row.id;
                return (
                    <Card key={row.id} withBorder radius="md" padding="sm">
                        <Group justify="space-between" align="center" wrap="nowrap">
                            <Group gap="sm" wrap="nowrap">
                                <Badge variant="filled" color="blue" ff="monospace">{row.code}</Badge>
                                <Text size="sm">{row.description}</Text>
                            </Group>
                            <Group gap="xs" wrap="nowrap">
                                <Button
                                    size="xs" variant="subtle" color="red"
                                    onClick={() => mut.mutate({ id: row.id, status: 'rejected' })}
                                    loading={loading && mut.variables?.status === 'rejected'}
                                    disabled={loading && mut.variables?.status === 'approved'}
                                >
                                    {t('research.hs.reject', 'Reject')}
                                </Button>
                                <Button
                                    size="xs" color="teal"
                                    onClick={() => mut.mutate({ id: row.id, status: 'approved' })}
                                    loading={loading && mut.variables?.status === 'approved'}
                                    disabled={loading && mut.variables?.status === 'rejected'}
                                >
                                    {t('research.hs.approve', 'Approve')}
                                </Button>
                            </Group>
                        </Group>
                    </Card>
                );
            })}
        </Stack>
    );
}
