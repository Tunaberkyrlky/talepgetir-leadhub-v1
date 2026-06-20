import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Modal, Stack, Group, TextInput, Button, Text, Anchor, List } from '@mantine/core';
import { IconBrandGoogle } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showSuccess, showErrorFromApi } from '../../lib/notifications';

interface GmailConnectModalProps {
    opened: boolean;
    onClose: () => void;
}

// Gmail over an app password: one credential drives both SMTP send and IMAP read
// (the inbound poller picks up replies), so no Google OAuth / verification needed.
const GMAIL_HOSTS = {
    smtp_host: 'smtp.gmail.com', smtp_port: 465, smtp_secure: true,
    imap_host: 'imap.gmail.com', imap_port: 993, imap_secure: true,
};

export default function GmailConnectModal({ opened, onClose }: GmailConnectModalProps) {
    const { t } = useTranslation();
    const qc = useQueryClient();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');

    const reset = () => { setEmail(''); setPassword(''); };

    const saveMut = useMutation({
        mutationFn: async () => api.post('/email-connections/smtp', {
            email_address: email.trim(),
            username: email.trim(),
            // Google shows the app password in 4-char groups; strip spaces so a
            // pasted "xxxx xxxx xxxx xxxx" authenticates.
            password: password.replace(/\s+/g, ''),
            ...GMAIL_HOSTS,
        }),
        onSuccess: () => {
            showSuccess(t('settings.gmail.connected', 'Gmail bağlandı'));
            qc.invalidateQueries({ queryKey: ['email-connection-status'] });
            reset();
            onClose();
        },
        onError: (err) => showErrorFromApi(err),
    });

    const canSave = email.includes('@') && password.trim().length > 0;

    return (
        <Modal
            opened={opened}
            onClose={onClose}
            size="md"
            radius="lg"
            title={
                <Group gap={8}>
                    <IconBrandGoogle size={18} color="var(--mantine-color-violet-6)" />
                    <Text fw={600}>{t('settings.gmail.title', 'Gmail Bağla (uygulama şifresi)')}</Text>
                </Group>
            }
        >
            <Stack gap="sm">
                <Text size="sm" c="dimmed">
                    {t('settings.gmail.desc', 'Gmail hesabınızı bir uygulama şifresiyle bağlayın. Tek şifreyle hem gönderim hem gelen yanıtların okunması sağlanır; Google onayı/doğrulaması gerekmez.')}
                </Text>

                <List size="xs" spacing={4} c="dimmed">
                    <List.Item>{t('settings.gmail.step1', 'Gmail hesabınızda 2 Adımlı Doğrulama açık olmalı.')}</List.Item>
                    <List.Item>
                        {t('settings.gmail.step2', 'Bir uygulama şifresi (app password) oluşturun:')}{' '}
                        <Anchor href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer" size="xs">
                            myaccount.google.com/apppasswords
                        </Anchor>
                    </List.Item>
                    <List.Item>{t('settings.gmail.step3', '16 haneli şifreyi aşağıya yapıştırın.')}</List.Item>
                    <List.Item>{t('settings.gmail.step4', 'Gmail ayarlarında IMAP erişimi açık olmalı (Workspace’te yönetici kapatmış olabilir).')}</List.Item>
                </List>

                <TextInput
                    label={t('settings.gmail.email', 'Gmail adresi')}
                    placeholder="ad@gmail.com"
                    value={email}
                    onChange={(e) => setEmail(e.currentTarget.value)}
                    required
                />
                <TextInput
                    label={t('settings.gmail.appPassword', 'Uygulama şifresi (app password)')}
                    type="password"
                    placeholder="xxxx xxxx xxxx xxxx"
                    value={password}
                    onChange={(e) => setPassword(e.currentTarget.value)}
                    required
                />

                <Text size="xs" c="dimmed">
                    {t('settings.gmail.testHint', 'Kaydetmeden önce gönderim ve okuma bağlantısı test edilir. Şifreniz şifrelenmiş saklanır.')}
                </Text>

                <Group justify="flex-end" mt="xs">
                    <Button variant="subtle" color="gray" onClick={onClose}>
                        {t('settings.gmail.cancel', 'İptal')}
                    </Button>
                    <Button
                        color="violet"
                        loading={saveMut.isPending}
                        disabled={!canSave}
                        onClick={() => saveMut.mutate()}
                    >
                        {t('settings.gmail.testAndSave', 'Test Et & Bağla')}
                    </Button>
                </Group>
            </Stack>
        </Modal>
    );
}
