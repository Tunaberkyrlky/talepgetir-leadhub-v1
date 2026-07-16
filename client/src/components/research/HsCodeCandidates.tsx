import { useState } from 'react';
import { Badge, Button, Card, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
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

/** Modal edit control shared by candidate rows and the panel's decided section. */
export function EditHsCodeButton({ row, onChanged }: { row: HsCodeCandidateRow; onChanged: () => void }) {
    const { t } = useTranslation();
    const [opened, setOpened] = useState(false);
    const [code, setCode] = useState(row.code);
    const [description, setDescription] = useState(row.description ?? '');

    const mut = useMutation({
        mutationFn: async () =>
            (await api.patch(`/research/hs/${row.id}`, { code: code.trim(), description: description.trim() || null })).data,
        onSuccess: () => {
            showSuccess(t('research.hs.editToast', 'Code updated.'));
            setOpened(false);
            onChanged();
        },
        onError: (err: unknown) => showErrorFromApi(err),
    });

    const open = () => {
        setCode(row.code);
        setDescription(row.description ?? '');
        setOpened(true);
    };

    return (
        <>
            <Button size="xs" variant="subtle" onClick={open}>
                {t('research.hs.edit', 'Edit')}
            </Button>
            <Modal opened={opened} onClose={() => setOpened(false)} title={t('research.hs.editHeading', 'Edit HS code')} centered>
                <Stack gap="sm">
                    <TextInput
                        label={t('research.hs.code', 'HS code')}
                        placeholder={t('research.hs.codePlaceholder', 'e.g. 847130')}
                        value={code}
                        onChange={(e) => setCode(e.currentTarget.value)}
                    />
                    <TextInput
                        label={t('research.hs.description', 'Description')}
                        placeholder={t('research.hs.descriptionPlaceholder', 'What the code covers')}
                        value={description}
                        onChange={(e) => setDescription(e.currentTarget.value)}
                    />
                    <Group justify="flex-end" gap="xs">
                        <Button variant="subtle" onClick={() => setOpened(false)} disabled={mut.isPending}>
                            {t('research.hs.cancel', 'Cancel')}
                        </Button>
                        <Button onClick={() => mut.mutate()} loading={mut.isPending} disabled={code.trim().length === 0}>
                            {t('research.hs.save', 'Save')}
                        </Button>
                    </Group>
                </Stack>
            </Modal>
        </>
    );
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
                            <Group gap="sm" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
                                <Badge variant="filled" color="blue" ff="monospace" style={{ flexShrink: 0 }} styles={{ label: { overflow: 'visible' } }}>{row.code}</Badge>
                                <Text size="sm" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{row.description}</Text>
                            </Group>
                            <Group gap="xs" wrap="nowrap">
                                <EditHsCodeButton row={row} onChanged={onChanged} />
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
