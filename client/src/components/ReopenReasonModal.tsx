import { useEffect } from 'react';
import { useForm } from '@mantine/form';
import { Modal, Textarea, Button, Stack, Group, Text, Alert } from '@mantine/core';
import { IconLockOpen } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';

interface ReopenReasonModalProps {
    opened: boolean;
    onClose: () => void;              // iptal → stage değişmez
    companyName: string;
    targetStageLabel: string;
    loading?: boolean;
    onConfirm: (reason: string) => void;   // neden alındı → parent PATCH/PUT yapar
}

// Küçük, yeniden kullanılabilir modal: kapalı bir kaydı yeniden açmadan önce zorunlu neden ister.
// Kayıt/cache işini parent üstlenir; bu bileşen yalnızca nedeni toplar (firma başlığı menüsü,
// liste satır menüsü ve düzenleme formu aynı bileşeni paylaşır).
export default function ReopenReasonModal({
    opened,
    onClose,
    companyName,
    targetStageLabel,
    loading,
    onConfirm,
}: ReopenReasonModalProps) {
    const { t } = useTranslation();

    const form = useForm({
        initialValues: { reason: '' },
        validate: {
            reason: (v: string) => (v.trim() ? null : t('activity.reopen.reasonRequired')),
        },
    });

    // Her açılışta formu sıfırla
    useEffect(() => {
        if (opened) form.setValues({ reason: '' });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [opened]);

    const handleSubmit = form.onSubmit((values) => {
        onConfirm(values.reason.trim());
    });

    return (
        <Modal
            opened={opened}
            onClose={onClose}
            title={t('activity.reopen.title')}
            size="md"
            radius="lg"
            centered
            overlayProps={{ backgroundOpacity: 0.45, blur: 4 }}
            styles={{ title: { fontWeight: 700, fontSize: '1.1rem' } }}
        >
            <Alert icon={<IconLockOpen size={16} />} color="blue" variant="light" mb="md" radius="md">
                <Text size="sm" fw={500}>{companyName} → {targetStageLabel}</Text>
                <Text size="xs" c="dimmed" mt={2}>{t('activity.reopen.description')}</Text>
            </Alert>

            <form onSubmit={handleSubmit}>
                <Stack gap="md">
                    <Textarea
                        label={t('activity.reopen.reasonLabel')}
                        placeholder={t('activity.reopen.reasonPlaceholder')}
                        required
                        autosize
                        minRows={2}
                        radius="md"
                        data-autofocus
                        {...form.getInputProps('reason')}
                    />

                    <Group justify="flex-end" mt="sm">
                        <Button variant="default" radius="md" onClick={onClose}>
                            {t('common.cancel')}
                        </Button>
                        <Button type="submit" radius="md" color="blue" loading={loading}>
                            {t('activity.reopen.confirm')}
                        </Button>
                    </Group>
                </Stack>
            </form>
        </Modal>
    );
}
