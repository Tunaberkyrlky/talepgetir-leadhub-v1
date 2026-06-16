import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Group, Stack, Text, Switch, Progress } from '@mantine/core';
import { Dropzone } from '@mantine/dropzone';
import { IconUpload, IconX, IconFileUpload } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showWarning, showErrorFromApi } from '../../lib/notifications';

/** The attachment row returned by POST /attachment-templates/upload. */
export interface UploadedAttachment {
    id: string;
    label: string;
    file_type: string;
    file_url: string;
    file_size: string;
    storage_path?: string | null; // present → uploaded file (real attachment-capable)
}

// Keep in sync with the server's ALLOWED_EXTS / bucket allowed_mime_types.
const ACCEPT = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'image/png',
    'image/jpeg',
    'text/plain',
];
const MAX_BYTES = 10 * 1024 * 1024; // 10MB

interface Props {
    /** Called with the created attachment row after a successful upload. */
    onUploaded: (tmpl: UploadedAttachment) => void;
    disabled?: boolean;
    /** Theme color — violet for compose/reply, yellow for forward. */
    color?: string;
    /** Library-management context: always save to library, hide the toggle. */
    forceLibrary?: boolean;
}

/**
 * Drag-and-drop file upload for email attachments. The file goes to Supabase
 * Storage and becomes an attachment row (link card, same send path as URL
 * templates). Default is one-off (this mail only); the toggle saves it to the
 * reusable library. In `forceLibrary` mode (the standalone library manager) the
 * upload always lands in the library and the toggle is hidden.
 */
export default function AttachmentUploader({ onUploaded, disabled, color = 'violet', forceLibrary = false }: Props) {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const [saveToLibrary, setSaveToLibrary] = useState(false);
    const [progress, setProgress] = useState(0);

    const toLibrary = forceLibrary || saveToLibrary;

    const uploadMutation = useMutation({
        mutationFn: async (file: File) => {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('saveToLibrary', String(toLibrary));
            const res = await api.post('/attachment-templates/upload', formData, {
                headers: { 'Content-Type': 'multipart/form-data' },
                onUploadProgress: (e) => setProgress(e.total ? Math.round((e.loaded / e.total) * 100) : 0),
            });
            return res.data.data as UploadedAttachment;
        },
        onSuccess: (data) => {
            // Saved-to-library uploads belong in the shared list → refetch it.
            if (toLibrary) queryClient.invalidateQueries({ queryKey: ['attachment-templates'] });
            onUploaded(data);
            setProgress(0);
        },
        onError: (err) => {
            showErrorFromApi(err, t('emailReplies.attachments.uploadFailed', 'Dosya yüklenemedi'));
            setProgress(0);
        },
    });

    const busy = uploadMutation.isPending;

    return (
        <Stack gap={6}>
            <Dropzone
                onDrop={(files) => files[0] && uploadMutation.mutate(files[0])}
                onReject={(rejections) => {
                    const tooBig = rejections.some((r) => r.errors.some((e) => e.code === 'file-too-large'));
                    showWarning(
                        tooBig
                            ? t('emailReplies.attachments.fileTooLarge', 'Dosya çok büyük (en fazla 10MB)')
                            : t('emailReplies.attachments.invalidType', 'Desteklenmeyen dosya türü'),
                    );
                }}
                accept={ACCEPT}
                maxSize={MAX_BYTES}
                multiple={false}
                loading={busy}
                disabled={disabled || busy}
                radius="md"
                p="xs"
            >
                <Group justify="center" gap={8} mih={40} style={{ pointerEvents: 'none' }}>
                    <Dropzone.Accept><IconUpload size={18} color={`var(--mantine-color-${color}-6)`} /></Dropzone.Accept>
                    <Dropzone.Reject><IconX size={18} color="var(--mantine-color-red-6)" /></Dropzone.Reject>
                    <Dropzone.Idle><IconFileUpload size={18} color="var(--mantine-color-dimmed)" /></Dropzone.Idle>
                    <Text size="xs" c="dimmed">
                        {t('emailReplies.attachments.dropHint', 'Dosyayı sürükleyin ya da tıklayıp seçin')}
                    </Text>
                </Group>
            </Dropzone>
            {busy && progress > 0 && <Progress value={progress} size="xs" color={color} />}
            {!forceLibrary && (
                <Switch
                    size="xs"
                    color={color}
                    checked={saveToLibrary}
                    onChange={(e) => setSaveToLibrary(e.currentTarget.checked)}
                    label={t('emailReplies.attachments.saveToLibrary', 'Kütüphaneye kaydet (tekrar kullanmak için)')}
                    disabled={disabled || busy}
                />
            )}
            <Text size="10px" c="dimmed" lh={1.3}>
                {t(
                    'emailReplies.attachments.deliveryHint',
                    'Dosyalar destekleyen kanallarda gerçek ek, aksi halde indirme linki olarak gönderilir.',
                )}
            </Text>
        </Stack>
    );
}
