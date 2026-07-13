/**
 * AiReviseButton (Z1) — a reusable "rewrite this field with AI" control.
 *
 * A small button opens a modal: the user types a free-text instruction, generates a draft
 * (POST /research/revise/draft — draft only, nothing is persisted server-side), reviews it
 * side-by-side against the current value, then Apply hands the draft to the PARENT via onApply
 * (the parent owns the actual PATCH through its existing save flow — this component NEVER PATCHes).
 *
 * Intentionally UNWIRED this slice — Phase 3 slices attach it to the ICP/offer/project cards.
 */
import { useState } from 'react';
import { Button, Group, Modal, SimpleGrid, Stack, Text, Textarea } from '@mantine/core';
import { IconSparkles } from '@tabler/icons-react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showErrorFromApi } from '../../lib/notifications';

export function AiReviseButton({
    entity,
    id,
    field,
    currentValue,
    onApply,
    label,
}: {
    entity: 'icp' | 'offer' | 'project';
    id: string;
    field: string;
    currentValue: string;
    onApply: (draft: string) => void;
    label?: string;
}) {
    const { t } = useTranslation();
    const [opened, setOpened] = useState(false);
    const [instruction, setInstruction] = useState('');
    const [draft, setDraft] = useState<string | null>(null);

    const generateMut = useMutation({
        // Send the UNSAVED on-screen value so the server rewrites what the user actually sees, not the
        // stale saved DB value. Capped at 8000 chars to match the server body limit (longer is sliced
        // for the prompt anyway; the server still validates entity/field/ownership independently).
        mutationFn: async () =>
            (await api.post('/research/revise/draft', {
                entity,
                id,
                field,
                instruction,
                currentValue: (currentValue ?? '').slice(0, 8000),
            })).data as { draft: string },
        onSuccess: (data) => setDraft(data.draft),
        onError: (err: unknown) => showErrorFromApi(err),
    });

    function close() {
        setOpened(false);
        setInstruction('');
        setDraft(null);
        generateMut.reset();
    }

    function apply() {
        if (draft != null) onApply(draft);
        close();
    }

    return (
        <>
            <Button size="xs" variant="subtle" leftSection={<IconSparkles size={14} />} onClick={() => setOpened(true)}>
                {label ?? t('research.aiRevise.button', 'Rewrite with AI')}
            </Button>

            <Modal opened={opened} onClose={close} title={t('research.aiRevise.title', 'Rewrite with AI')} size="lg">
                <Stack gap="sm">
                    <Textarea
                        label={t('research.aiRevise.instructionLabel', 'How should we rewrite this?')}
                        placeholder={t('research.aiRevise.instructionPlaceholder', 'e.g. make it shorter and more concrete')}
                        autosize
                        minRows={2}
                        value={instruction}
                        onChange={(e) => setInstruction(e.currentTarget.value)}
                    />
                    <Group justify="flex-end">
                        <Button
                            size="xs"
                            onClick={() => generateMut.mutate()}
                            loading={generateMut.isPending}
                            disabled={!instruction.trim()}
                        >
                            {generateMut.isPending
                                ? t('research.aiRevise.generating', 'Generating…')
                                : t('research.aiRevise.generate', 'Generate draft')}
                        </Button>
                    </Group>

                    {draft != null && (
                        <>
                            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
                                <Stack gap={4}>
                                    <Text size="xs" fw={600} c="dimmed">
                                        {t('research.aiRevise.currentLabel', 'Current')}
                                    </Text>
                                    <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                                        {currentValue || t('research.aiRevise.emptyDraft', '(empty)')}
                                    </Text>
                                </Stack>
                                <Stack gap={4}>
                                    <Text size="xs" fw={600} c="dimmed">
                                        {t('research.aiRevise.draftLabel', 'AI draft')}
                                    </Text>
                                    <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                                        {draft}
                                    </Text>
                                </Stack>
                            </SimpleGrid>
                            <Group justify="flex-end" gap="xs">
                                <Button size="xs" variant="default" onClick={close}>
                                    {t('research.aiRevise.cancel', 'Cancel')}
                                </Button>
                                <Button size="xs" color="teal" onClick={apply}>
                                    {t('research.aiRevise.apply', 'Apply')}
                                </Button>
                            </Group>
                        </>
                    )}
                </Stack>
            </Modal>
        </>
    );
}
