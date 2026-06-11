import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
    Modal, Stack, Group, TextInput, NumberInput, Switch, Button, Text, Divider,
} from '@mantine/core';
import { IconServer } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showSuccess, showErrorFromApi } from '../../lib/notifications';

interface SmtpConnectionModalProps {
    opened: boolean;
    onClose: () => void;
}

export default function SmtpConnectionModal({ opened, onClose }: SmtpConnectionModalProps) {
    const { t } = useTranslation();
    const qc = useQueryClient();

    const [email, setEmail] = useState('');
    const [smtpHost, setSmtpHost] = useState('');
    const [smtpPort, setSmtpPort] = useState<number>(465);
    const [smtpSecure, setSmtpSecure] = useState(true);
    const [imapHost, setImapHost] = useState('');
    const [imapPort, setImapPort] = useState<number>(993);
    const [imapSecure, setImapSecure] = useState(true);
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [allowInvalidCert, setAllowInvalidCert] = useState(false);

    const reset = () => {
        setEmail(''); setSmtpHost(''); setSmtpPort(465); setSmtpSecure(true);
        setImapHost(''); setImapPort(993); setImapSecure(true); setUsername(''); setPassword('');
        setAllowInvalidCert(false);
    };

    const saveMut = useMutation({
        mutationFn: async () => api.post('/email-connections/smtp', {
            email_address: email.trim(),
            smtp_host: smtpHost.trim(),
            smtp_port: smtpPort,
            smtp_secure: smtpSecure,
            imap_host: imapHost.trim() || null,
            imap_port: imapHost.trim() ? imapPort : null,
            imap_secure: imapSecure,
            username: username.trim(),
            password,
            allow_invalid_cert: allowInvalidCert,
        }),
        onSuccess: () => {
            showSuccess(t('settings.smtp.saved', 'SMTP hesabı bağlandı'));
            qc.invalidateQueries({ queryKey: ['email-connection-status'] });
            reset();
            onClose();
        },
        onError: (err) => showErrorFromApi(err),
    });

    const canSave = email.includes('@') && smtpHost.trim() && username.trim() && password
        && smtpPort > 0;

    return (
        <Modal
            opened={opened}
            onClose={onClose}
            size="md"
            radius="lg"
            title={
                <Group gap={8}>
                    <IconServer size={18} color="var(--mantine-color-violet-6)" />
                    <Text fw={600}>{t('settings.smtp.title', 'SMTP / IMAP Hesabı Bağla')}</Text>
                </Group>
            }
        >
            <Stack gap="sm">
                <TextInput
                    label={t('settings.smtp.email', 'E-posta adresi')}
                    placeholder="info@firma.com"
                    value={email}
                    onChange={(e) => {
                        setEmail(e.currentTarget.value);
                        if (!username) setUsername(e.currentTarget.value);
                    }}
                    required
                />

                <Divider label={t('settings.smtp.outgoing', 'Giden (SMTP)')} labelPosition="left" />
                <Group grow align="flex-end">
                    <TextInput
                        label={t('settings.smtp.host', 'Sunucu')}
                        placeholder="mail.firma.com"
                        value={smtpHost}
                        onChange={(e) => setSmtpHost(e.currentTarget.value)}
                        required
                    />
                    <NumberInput
                        label={t('settings.smtp.port', 'Port')}
                        value={smtpPort}
                        onChange={(v) => setSmtpPort(Number(v) || 0)}
                        min={1} max={65535}
                        style={{ maxWidth: 110 }}
                    />
                </Group>
                <Switch
                    label={t('settings.smtp.secure', 'SSL/TLS (genelde 465 için açık, 587 için kapalı)')}
                    checked={smtpSecure}
                    onChange={(e) => setSmtpSecure(e.currentTarget.checked)}
                    size="sm"
                />

                <Divider label={t('settings.smtp.incoming', 'Gelen (IMAP) — cevapları görmek için')} labelPosition="left" />
                <Group grow align="flex-end">
                    <TextInput
                        label={t('settings.smtp.imapHost', 'IMAP Sunucu')}
                        placeholder="mail.firma.com"
                        value={imapHost}
                        onChange={(e) => setImapHost(e.currentTarget.value)}
                    />
                    <NumberInput
                        label={t('settings.smtp.port', 'Port')}
                        value={imapPort}
                        onChange={(v) => setImapPort(Number(v) || 0)}
                        min={1} max={65535}
                        style={{ maxWidth: 110 }}
                    />
                </Group>
                <Switch
                    label={t('settings.smtp.imapSecure', 'IMAP SSL/TLS (genelde 993 için açık)')}
                    checked={imapSecure}
                    onChange={(e) => setImapSecure(e.currentTarget.checked)}
                    size="sm"
                />

                <Divider label={t('settings.smtp.auth', 'Kimlik')} labelPosition="left" />
                <TextInput
                    label={t('settings.smtp.username', 'Kullanıcı adı')}
                    placeholder="info@firma.com"
                    value={username}
                    onChange={(e) => setUsername(e.currentTarget.value)}
                    required
                />
                <TextInput
                    label={t('settings.smtp.password', 'Şifre')}
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.currentTarget.value)}
                    required
                />

                <Switch
                    label={t('settings.smtp.allowInvalidCert', 'Sunucu sertifikasını doğrulama (paylaşımlı hosting için)')}
                    checked={allowInvalidCert}
                    onChange={(e) => setAllowInvalidCert(e.currentTarget.checked)}
                    size="sm"
                />

                <Text size="xs" c="dimmed">
                    {t('settings.smtp.testHint', 'Kaydetmeden önce bağlantı test edilir. Şifreniz şifrelenmiş olarak saklanır.')}
                </Text>

                <Group justify="flex-end" mt="xs">
                    <Button variant="subtle" color="gray" onClick={onClose}>
                        {t('settings.smtp.cancel', 'İptal')}
                    </Button>
                    <Button
                        color="violet"
                        loading={saveMut.isPending}
                        disabled={!canSave}
                        onClick={() => saveMut.mutate()}
                    >
                        {t('settings.smtp.testAndSave', 'Test Et & Kaydet')}
                    </Button>
                </Group>
            </Stack>
        </Modal>
    );
}
