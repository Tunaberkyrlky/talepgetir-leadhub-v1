import { Modal, Text, Stack } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import AttachmentSection from './AttachmentSection';

interface Props {
    opened: boolean;
    onClose: () => void;
}

/**
 * Standalone attachment-library manager — lets you upload files / add links and
 * edit/delete saved attachments WITHOUT composing a mail. Reuses the shared
 * AttachmentSection in 'manage' mode so the library behaves identically to the
 * one shown inside compose / reply / forward.
 */
export default function AttachmentLibraryModal({ opened, onClose }: Props) {
    const { t } = useTranslation();

    return (
        <Modal
            opened={opened}
            onClose={onClose}
            title={t('emailReplies.attachmentLibrary.title', 'Mail Ekleri')}
            size="lg"
            radius="lg"
            centered
            overlayProps={{ backgroundOpacity: 0.4, blur: 4 }}
            styles={{ title: { fontWeight: 700 } }}
        >
            <Stack gap="xs">
                <Text size="sm" c="dimmed">
                    {t(
                        'emailReplies.attachmentLibrary.description',
                        'Buradan yüklediğiniz dosya ve linkler, mail yazarken ya da yanıtlarken ek olarak seçilebilir. Mail göndermenize gerek yok.',
                    )}
                </Text>
                <AttachmentSection mode="manage" />
            </Stack>
        </Modal>
    );
}
