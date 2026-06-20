import { Modal, Text, Stack, Tabs } from '@mantine/core';
import { IconPaperclip, IconAt } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import AttachmentSection from './AttachmentSection';
import CcAddressesPanel from '../settings/CcAddressesPanel';

interface Props {
    opened: boolean;
    onClose: () => void;
}

/**
 * Mail extras manager — attachment library + CC addresses in one place, opened
 * from the "İşlemler" menu next to compose. The attachment library (manage mode)
 * behaves identically to the one shown inside compose/reply/forward; the CC tab
 * reuses the same panel that used to live under Settings → Integrations.
 */
export default function AttachmentLibraryModal({ opened, onClose }: Props) {
    const { t } = useTranslation();

    return (
        <Modal
            opened={opened}
            onClose={onClose}
            title={t('emailReplies.attachmentLibrary.title', 'Mail Ekleri ve CC Adresleri')}
            size="lg"
            radius="lg"
            centered
            overlayProps={{ backgroundOpacity: 0.4, blur: 4 }}
            styles={{ title: { fontWeight: 700 } }}
        >
            <Tabs defaultValue="attachments" color="violet">
                <Tabs.List mb="md">
                    <Tabs.Tab value="attachments" leftSection={<IconPaperclip size={16} />}>
                        {t('emailReplies.attachmentLibrary.tabAttachments', 'Mail Ekleri')}
                    </Tabs.Tab>
                    <Tabs.Tab value="cc" leftSection={<IconAt size={16} />}>
                        {t('emailReplies.attachmentLibrary.tabCc', 'CC Adresleri')}
                    </Tabs.Tab>
                </Tabs.List>

                <Tabs.Panel value="attachments">
                    <Stack gap="xs">
                        <Text size="sm" c="dimmed">
                            {t(
                                'emailReplies.attachmentLibrary.description',
                                'Buradan yüklediğiniz dosya ve linkler, mail yazarken ya da yanıtlarken ek olarak seçilebilir. Mail göndermenize gerek yok.',
                            )}
                        </Text>
                        <AttachmentSection mode="manage" />
                    </Stack>
                </Tabs.Panel>

                <Tabs.Panel value="cc">
                    <CcAddressesPanel />
                </Tabs.Panel>
            </Tabs>
        </Modal>
    );
}
