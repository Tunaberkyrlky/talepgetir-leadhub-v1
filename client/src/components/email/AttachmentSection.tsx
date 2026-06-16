import { useState, useMemo } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
    Group, Box, Text, Button, Checkbox, Collapse, TextInput, ActionIcon, Badge, Modal,
} from '@mantine/core';
import { IconPlus, IconX, IconPencil } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showErrorFromApi } from '../../lib/notifications';
import AttachmentUploader from './AttachmentUploader';

export interface AttachmentTemplate {
    id: string;
    label: string;
    file_type: string;
    file_url: string;
    file_size: string;
    storage_path?: string | null; // present → uploaded file (real attachment); absent → external URL (link)
}

// Accent palette per host (reply/compose = violet, forward = yellow).
const ACCENT = {
    violet: { sel: '#7c3aed', selBg: '#f5f3ff', dash: '#c4b5fd', mantine: 'violet' },
    yellow: { sel: '#d97706', selBg: '#fffbeb', dash: '#fcd34d', mantine: 'yellow' },
} as const;

interface Props {
    /** Selection state — only used in 'select' mode (compose/reply/forward). */
    selected?: string[];
    setSelected?: Dispatch<SetStateAction<string[]>>;
    color?: keyof typeof ACCENT;
    disabled?: boolean;
    /**
     * 'select' (default): chips are checkboxes the parent's send mutation reads.
     * 'manage': standalone library manager — no selection, uploads always land
     * in the library, and an empty-state hint shows when the library is empty.
     */
    mode?: 'select' | 'manage';
}

/**
 * The single, shared attachment UI used by compose / reply / forward and the
 * standalone library manager. Owns the library list, one-off uploads, the
 * "Add Link" (URL) form + edit/delete, and the drag-drop file uploader, so all
 * places are guaranteed identical. In 'select' mode the parent owns the
 * selected-id list (its send mutation reads it).
 */
export default function AttachmentSection({ selected, setSelected, color = 'violet', disabled, mode = 'select' }: Props) {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const accent = ACCENT[color];
    const isManage = mode === 'manage';
    const selectedIds = selected ?? [];
    const updateSelected: Dispatch<SetStateAction<string[]>> = setSelected ?? (() => {});

    const [oneOffUploads, setOneOffUploads] = useState<AttachmentTemplate[]>([]);
    const [newAttOpen, setNewAttOpen] = useState(false);
    const [editingAttId, setEditingAttId] = useState<string | null>(null);
    const [newAttLabel, setNewAttLabel] = useState('');
    const [newAttUrl, setNewAttUrl] = useState('');
    const [newAttType, setNewAttType] = useState('PDF');
    const [newAttSize, setNewAttSize] = useState('');
    const [deleteAttId, setDeleteAttId] = useState<string | null>(null);

    const { data: attachmentTemplates = [] } = useQuery<AttachmentTemplate[]>({
        queryKey: ['attachment-templates'],
        queryFn: async () => {
            const { data } = await api.get('/attachment-templates');
            return data.data || [];
        },
        staleTime: 5 * 60_000,
    });

    // Library templates + this-session one-off uploads (deduped once a saved
    // upload appears in the refetched library list).
    const allAttachments = useMemo(() => {
        const libIds = new Set(attachmentTemplates.map((a) => a.id));
        return [...attachmentTemplates, ...oneOffUploads.filter((o) => !libIds.has(o.id))];
    }, [attachmentTemplates, oneOffUploads]);

    const resetAttForm = () => {
        setNewAttOpen(false);
        setEditingAttId(null);
        setNewAttLabel('');
        setNewAttUrl('');
        setNewAttType('PDF');
        setNewAttSize('');
    };

    const createTemplateMutation = useMutation({
        mutationFn: async () => (await api.post('/attachment-templates', {
            label: newAttLabel.trim(),
            file_url: newAttUrl.trim(),
            file_type: newAttType.toLowerCase(),
            file_size: newAttSize.trim(),
        })).data,
        onSuccess: (result: { data: AttachmentTemplate }) => {
            queryClient.invalidateQueries({ queryKey: ['attachment-templates'] });
            if (!isManage) updateSelected((prev) => [...prev, result.data.id]);
            resetAttForm();
        },
        onError: (err) => showErrorFromApi(err, t('emailReplies.attachments.createFailed')),
    });

    const updateTemplateMutation = useMutation({
        mutationFn: async () => {
            if (!editingAttId) throw new Error('No template selected for edit');
            return (await api.put(`/attachment-templates/${editingAttId}`, {
                label: newAttLabel.trim(),
                file_url: newAttUrl.trim(),
                file_type: newAttType.toLowerCase(),
                file_size: newAttSize.trim(),
            })).data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['attachment-templates'] });
            resetAttForm();
        },
        onError: (err) => showErrorFromApi(err, t('emailReplies.attachments.updateFailed', t('emailReplies.attachments.createFailed'))),
    });

    const startEditTemplate = (tmpl: AttachmentTemplate) => {
        setEditingAttId(tmpl.id);
        setNewAttLabel(tmpl.label);
        setNewAttUrl(tmpl.file_url);
        setNewAttType(tmpl.file_type.toUpperCase());
        setNewAttSize(tmpl.file_size || '');
        setNewAttOpen(true);
    };

    const deleteTemplateMutation = useMutation({
        mutationFn: async (id: string) => { await api.delete(`/attachment-templates/${id}`); },
        onSuccess: (_data, deletedId) => {
            queryClient.invalidateQueries({ queryKey: ['attachment-templates'] });
            updateSelected((prev) => prev.filter((x) => x !== deletedId));
        },
        onError: (err) => showErrorFromApi(err, t('emailReplies.attachments.deleteFailed')),
    });

    const toggle = (id: string) =>
        updateSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

    return (
        <Box mt={12} pt={12} style={{ borderTop: '1px solid #f1f3f5' }}>
            <Group justify="space-between" mb={8}>
                <Text size="xs" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.06em', fontSize: 10 }}>
                    {t('emailReplies.attachments.label')}
                </Text>
                <Button
                    size="compact-xs"
                    variant="subtle"
                    color={accent.mantine}
                    leftSection={<IconPlus size={11} />}
                    onClick={() => setNewAttOpen((v) => !v)}
                    disabled={disabled}
                    styles={{ root: { fontSize: 11, fontWeight: 600, border: `1px dashed ${accent.dash}`, borderRadius: 6, padding: '2px 8px' } }}
                >
                    {t('emailReplies.attachments.addNew')}
                </Button>
            </Group>

            {/* Empty-state hint (manage mode only) */}
            {isManage && allAttachments.length === 0 && (
                <Text size="xs" c="dimmed" fs="italic">
                    {t('emailReplies.attachments.emptyLibrary', 'Henüz kayıtlı ek yok. Aşağıdan dosya yükleyin ya da link ekleyin.')}
                </Text>
            )}

            {/* Chips */}
            {allAttachments.length > 0 && (
                <Group gap={6}>
                    {allAttachments.map((tmpl) => {
                        const isSelected = !isManage && selectedIds.includes(tmpl.id);
                        return (
                            <Box
                                key={tmpl.id}
                                onClick={() => { if (!isManage && !disabled) toggle(tmpl.id); }}
                                style={{
                                    display: 'flex', alignItems: 'center', gap: 6,
                                    border: `1px solid ${isSelected ? accent.sel : '#e8e8f0'}`,
                                    borderRadius: 8, padding: '6px 10px',
                                    cursor: isManage ? 'default' : (disabled ? 'not-allowed' : 'pointer'),
                                    background: isSelected ? accent.selBg : '#fafafe',
                                    transition: 'all 0.15s', userSelect: 'none', position: 'relative',
                                    opacity: disabled ? 0.5 : 1,
                                }}
                            >
                                {!isManage && <Checkbox checked={isSelected} onChange={() => {}} size="xs" color={accent.mantine} styles={{ input: { cursor: 'pointer' } }} />}
                                <Box style={{ flex: 1 }}>
                                    <Group gap={6} align="center" wrap="nowrap">
                                        <Text size="xs" fw={600} c="#252540">{tmpl.label}</Text>
                                        <Badge size="xs" variant="light" color={tmpl.storage_path ? 'teal' : 'gray'}>
                                            {tmpl.storage_path
                                                ? t('emailReplies.attachments.deliveryFile', 'Dosya')
                                                : t('emailReplies.attachments.deliveryLink', 'Link')}
                                        </Badge>
                                    </Group>
                                    <Text size="xs" c="dimmed" style={{ fontSize: 10 }}>
                                        {tmpl.file_type.toUpperCase()}{tmpl.file_size ? ` · ${tmpl.file_size}` : ''}
                                    </Text>
                                </Box>
                                <ActionIcon
                                    size={16} variant="subtle" color="gray" radius="xl"
                                    onClick={(e) => { e.stopPropagation(); startEditTemplate(tmpl); }}
                                    style={{ flexShrink: 0, opacity: 0.4 }}
                                    onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = '1'; }}
                                    onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = '0.4'; }}
                                    aria-label={t('emailReplies.attachments.edit', 'Düzenle')}
                                >
                                    <IconPencil size={10} />
                                </ActionIcon>
                                <ActionIcon
                                    size={16} variant="subtle" color="red" radius="xl"
                                    onClick={(e) => { e.stopPropagation(); setDeleteAttId(tmpl.id); }}
                                    style={{ flexShrink: 0, opacity: 0.4 }}
                                    onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = '1'; }}
                                    onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = '0.4'; }}
                                >
                                    <IconX size={10} />
                                </ActionIcon>
                            </Box>
                        );
                    })}
                </Group>
            )}

            {/* Add-link (URL) form */}
            <Collapse in={newAttOpen}>
                <Box mt={10} p={12} style={{ border: '1px solid #e8e8f0', borderRadius: 10, background: '#f9f9fd' }}>
                    <Text size="xs" fw={600} c="#495057" mb={8}>
                        {editingAttId
                            ? t('emailReplies.attachments.editTitle', 'Linki Düzenle')
                            : t('emailReplies.attachments.createTitle')}
                    </Text>
                    <TextInput
                        size="xs"
                        label={t('emailReplies.attachments.nameLabel')}
                        placeholder={t('emailReplies.attachments.namePlaceholder')}
                        value={newAttLabel}
                        onChange={(e) => setNewAttLabel(e.currentTarget.value)}
                        mb={6}
                    />
                    <TextInput
                        size="xs"
                        label={t('emailReplies.attachments.urlLabel')}
                        placeholder="https://drive.google.com/..."
                        value={newAttUrl}
                        onChange={(e) => setNewAttUrl(e.currentTarget.value)}
                        mb={6}
                        styles={{ input: { fontFamily: 'monospace', fontSize: 11 } }}
                    />
                    <Group gap={8}>
                        <TextInput
                            size="xs"
                            label={t('emailReplies.attachments.typeLabel')}
                            placeholder="PDF"
                            value={newAttType}
                            onChange={(e) => setNewAttType(e.currentTarget.value)}
                            style={{ flex: '0 0 100px' }}
                        />
                        <TextInput
                            size="xs"
                            label={t('emailReplies.attachments.sizeLabel')}
                            placeholder="2.4 MB"
                            value={newAttSize}
                            onChange={(e) => setNewAttSize(e.currentTarget.value)}
                            style={{ flex: '0 0 100px' }}
                        />
                    </Group>
                    <Group justify="flex-end" mt={10} gap={6}>
                        <Button size="xs" variant="subtle" color="gray" onClick={resetAttForm}>
                            {t('emailReplies.reply.cancel')}
                        </Button>
                        <Button
                            size="xs"
                            color={accent.mantine}
                            loading={createTemplateMutation.isPending || updateTemplateMutation.isPending}
                            disabled={!newAttLabel.trim() || !newAttUrl.trim()}
                            onClick={() => (editingAttId ? updateTemplateMutation.mutate() : createTemplateMutation.mutate())}
                        >
                            {t('emailReplies.attachments.save')}
                        </Button>
                    </Group>
                </Box>
            </Collapse>

            {/* Drag-drop file upload */}
            <Box mt={10}>
                <AttachmentUploader
                    color={accent.mantine}
                    disabled={disabled}
                    forceLibrary={isManage}
                    onUploaded={(tmpl) => {
                        // Manage mode uploads go straight to the library (the uploader
                        // refetches it); no one-off/selection bookkeeping needed.
                        if (isManage) return;
                        setOneOffUploads((prev) => [...prev, tmpl]);
                        updateSelected((prev) => [...prev, tmpl.id]);
                    }}
                />
            </Box>

            {/* Delete confirm */}
            <Modal
                opened={!!deleteAttId}
                onClose={() => setDeleteAttId(null)}
                title={t('emailReplies.attachments.deleteTitle')}
                size="xs"
                radius="lg"
                centered
                zIndex={1000}
                overlayProps={{ backgroundOpacity: 0.4, blur: 4 }}
                styles={{ title: { fontWeight: 700 } }}
            >
                <Text size="sm" mb="md">{t('emailReplies.attachments.deleteConfirm')}</Text>
                <Group justify="flex-end">
                    <Button variant="default" size="sm" radius="md" onClick={() => setDeleteAttId(null)}>
                        {t('common.cancel')}
                    </Button>
                    <Button
                        color="red"
                        size="sm"
                        radius="md"
                        loading={deleteTemplateMutation.isPending}
                        onClick={() => {
                            if (deleteAttId) {
                                deleteTemplateMutation.mutate(deleteAttId, { onSuccess: () => setDeleteAttId(null) });
                            }
                        }}
                    >
                        {t('common.delete')}
                    </Button>
                </Group>
            </Modal>
        </Box>
    );
}
