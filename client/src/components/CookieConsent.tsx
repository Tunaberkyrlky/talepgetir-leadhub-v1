import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
    Button,
    Group,
    Modal,
    Paper,
    Stack,
    Switch,
    Text,
    Title,
} from '@mantine/core';
import { IconCookie, IconLock } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { useConsent } from '../contexts/ConsentContext';

function useCopy() {
    const { i18n } = useTranslation();
    const tr = i18n.language.startsWith('tr');
    return tr ? {
        title: 'Gizlilik tercihleri',
        summary: 'Zorunlu depolamayı uygulamanın güvenli çalışması için kullanıyoruz. PostHog ürün analitiği ve Tawk.to canlı destek yalnızca izninizle etkinleşir.',
        accept: 'Tümünü kabul et',
        reject: 'İsteğe bağlıları reddet',
        customize: 'Tercihleri yönet',
        policy: 'Çerez Politikası',
        modalTitle: 'Gizlilik tercihlerini yönet',
        necessary: 'Zorunlu',
        necessaryDescription: 'Oturum açma, güvenlik, çalışma alanı seçimi ve tercihlerinizi hatırlamak için gereklidir. Kapatılamaz.',
        analytics: 'Ürün analitiği — PostHog',
        analyticsDescription: 'Hangi özelliklerin kullanıldığını ve destek öncesi ürün akışını anlamamıza yardımcı olur. Form alanları ve ekran metinleri kayıtlarda maskelenir.',
        support: 'Canlı destek — Tawk.to',
        supportDescription: 'Bizimle anlık mesajlaşmanızı sağlar. Etkinleştirilirse kimlik, şirket ve bulunduğunuz modül desteğe bağlam olarak aktarılır.',
        save: 'Tercihleri kaydet',
    } : {
        title: 'Privacy preferences',
        summary: 'We use necessary storage to operate the app securely. PostHog product analytics and Tawk.to live support are enabled only with your permission.',
        accept: 'Accept all',
        reject: 'Reject optional',
        customize: 'Manage preferences',
        policy: 'Cookie Policy',
        modalTitle: 'Manage privacy preferences',
        necessary: 'Necessary',
        necessaryDescription: 'Required for sign-in, security, workspace selection, and remembering your choices. It cannot be disabled.',
        analytics: 'Product analytics — PostHog',
        analyticsDescription: 'Helps us understand feature usage and the product flow before support is requested. Form inputs and screen text are masked in recordings.',
        support: 'Live support — Tawk.to',
        supportDescription: 'Lets you message us in real time. When enabled, your identity, company, and current module are shared as support context.',
        save: 'Save preferences',
    };
}

export default function CookieConsent() {
    const consent = useConsent();
    const copy = useCopy();
    const [analytics, setAnalytics] = useState(consent.preferences?.analytics ?? false);
    const [support, setSupport] = useState(consent.preferences?.support ?? false);

    const acceptAll = () => {
        setAnalytics(true);
        setSupport(true);
        consent.acceptAll();
    };

    const rejectOptional = () => {
        setAnalytics(false);
        setSupport(false);
        consent.rejectOptional();
    };

    return (
        <>
            {!consent.preferences && (
                <Paper
                    role="dialog"
                    aria-labelledby="cookie-consent-title"
                    shadow="xl"
                    radius="lg"
                    p="lg"
                    withBorder
                    style={{
                        position: 'fixed',
                        zIndex: 10000,
                        left: 20,
                        right: 20,
                        bottom: 20,
                        maxWidth: 760,
                        marginInline: 'auto',
                    }}
                >
                    <Stack gap="sm">
                        <Group gap="sm" wrap="nowrap" align="flex-start">
                            <IconCookie size={24} color="var(--mantine-color-violet-6)" />
                            <div>
                                <Title id="cookie-consent-title" order={4}>{copy.title}</Title>
                                <Text size="sm" c="dimmed" mt={4}>{copy.summary}</Text>
                            </div>
                        </Group>
                        <Group justify="space-between" align="center">
                            <Text component={Link} to="/cookie-policy" size="sm" c="violet" td="underline">
                                {copy.policy}
                            </Text>
                            <Group gap="xs">
                                <Button variant="subtle" color="gray" onClick={rejectOptional}>
                                    {copy.reject}
                                </Button>
                                <Button variant="light" onClick={consent.openPreferences}>
                                    {copy.customize}
                                </Button>
                                <Button onClick={acceptAll}>{copy.accept}</Button>
                            </Group>
                        </Group>
                    </Stack>
                </Paper>
            )}

            <Modal
                opened={consent.preferencesOpened}
                onClose={consent.closePreferences}
                title={copy.modalTitle}
                centered
                radius="lg"
                size="lg"
                overlayProps={{ backgroundOpacity: 0.45, blur: 3 }}
                styles={{ title: { fontWeight: 700 } }}
            >
                <Stack gap="md">
                    <Paper withBorder radius="md" p="md">
                        <Group justify="space-between" wrap="nowrap">
                            <div>
                                <Group gap={6}><IconLock size={16} /><Text fw={600}>{copy.necessary}</Text></Group>
                                <Text size="sm" c="dimmed" mt={4}>{copy.necessaryDescription}</Text>
                            </div>
                            <Switch checked disabled aria-label={copy.necessary} />
                        </Group>
                    </Paper>
                    <Paper withBorder radius="md" p="md">
                        <Group justify="space-between" wrap="nowrap">
                            <div>
                                <Text fw={600}>{copy.analytics}</Text>
                                <Text size="sm" c="dimmed" mt={4}>{copy.analyticsDescription}</Text>
                            </div>
                            <Switch checked={analytics} onChange={(event) => setAnalytics(event.currentTarget.checked)} aria-label={copy.analytics} />
                        </Group>
                    </Paper>
                    <Paper withBorder radius="md" p="md">
                        <Group justify="space-between" wrap="nowrap">
                            <div>
                                <Text fw={600}>{copy.support}</Text>
                                <Text size="sm" c="dimmed" mt={4}>{copy.supportDescription}</Text>
                            </div>
                            <Switch checked={support} onChange={(event) => setSupport(event.currentTarget.checked)} aria-label={copy.support} />
                        </Group>
                    </Paper>
                    <Group justify="space-between">
                        <Text component={Link} to="/cookie-policy" size="sm" c="violet" onClick={consent.closePreferences}>
                            {copy.policy}
                        </Text>
                        <Button onClick={() => consent.savePreferences(analytics, support)}>{copy.save}</Button>
                    </Group>
                </Stack>
            </Modal>
        </>
    );
}
