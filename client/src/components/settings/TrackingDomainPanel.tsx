import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
    Stack, Group, Text, TextInput, Button, Paper, Badge, Loader, Center, Title,
    Alert, Code, CopyButton, ActionIcon, Tooltip, Table,
} from '@mantine/core';
import {
    IconWorld, IconShieldCheck, IconDeviceFloppy, IconCheck, IconCopy, IconAlertCircle,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showSuccess, showError, showErrorFromApi } from '../../lib/notifications';

interface TrackingDomainData {
    domain: string | null;
    verified: boolean;
    checked_at: string | null;
    expected_target: string | null;
}

interface VerifyResult {
    domain: string;
    verified: boolean;
    checked_at: string | null;
    expected_target: string | null;
    found: string[];
}

// Özel takip alanı ayarı (task-7): kullanıcı kendi alanını girer, CNAME kaydını
// ekler ve "Doğrula" ile DNS kontrolü yapar. Doğrulanmış alan gönderimlerde
// pixel/click/unsubscribe linklerinin tabanı olur.
export default function TrackingDomainPanel() {
    const { t } = useTranslation();
    const qc = useQueryClient();
    const [domain, setDomain] = useState('');
    const [dirty, setDirty] = useState(false);
    // Sunucudan gelen alanı yerel düzenlenebilir state'e bir kez senkronla. Effect
    // yerine render-anı uzlaştırma (React'in önerdiği desen): kayıtlı alan değişince
    // (ilk yükleme ya da kaydetme sonrası) input'u tazeler ve dirty'yi sıfırlar.
    const [syncedDomain, setSyncedDomain] = useState<string | null>(null);

    const { data, isLoading } = useQuery<TrackingDomainData>({
        queryKey: ['tracking-domain'],
        queryFn: async () => { const r = await api.get('/settings/tracking-domain'); return r.data.data; },
    });

    if (data && (data.domain || '') !== (syncedDomain || '')) {
        setSyncedDomain(data.domain || '');
        setDomain(data.domain || '');
        setDirty(false);
    }

    const saveMut = useMutation<TrackingDomainData, unknown, void>({
        mutationFn: async () => {
            const r = await api.put('/settings/tracking-domain', { domain: domain.trim() || null });
            return r.data.data;
        },
        onSuccess: (res) => {
            showSuccess(res.domain ? t('settings.trackingSaved', 'Tracking domain saved') : t('settings.trackingCleared', 'Tracking domain removed'));
            setDirty(false);
            qc.invalidateQueries({ queryKey: ['tracking-domain'] });
        },
        onError: (err) => showErrorFromApi(err),
    });

    const verifyMut = useMutation<VerifyResult, unknown, void>({
        mutationFn: async () => { const r = await api.post('/settings/tracking-domain/verify'); return r.data.data; },
        onSuccess: (res) => {
            if (res.verified) showSuccess(t('settings.trackingVerifyOk', 'Domain verified — it will be used for sends.'));
            else showError(t('settings.trackingVerifyFail', 'CNAME record not found yet; DNS propagation can take a few minutes, then try again.'));
            qc.invalidateQueries({ queryKey: ['tracking-domain'] });
        },
        onError: (err) => showErrorFromApi(err),
    });

    if (isLoading) return <Center py="md"><Loader size="sm" color="violet" /></Center>;

    const expectedTarget = data?.expected_target || null;
    const savedDomain = data?.domain || null;
    const verified = !!data?.verified;
    // "Doğrula" yalnız kayıtlı (dirty olmayan) bir alan varken anlamlı.
    const canVerify = !!savedDomain && !dirty && !!expectedTarget;

    const statusBadge = !savedDomain
        ? <Badge size="sm" variant="light" color="gray">{t('settings.trackingNotSet', 'Not set')}</Badge>
        : verified
            ? <Badge size="sm" variant="light" color="green" leftSection={<IconShieldCheck size={12} />}>{t('settings.trackingVerified', 'Verified')}</Badge>
            : <Badge size="sm" variant="light" color="yellow">{t('settings.trackingUnverified', 'Not verified')}</Badge>;

    return (
        <Paper shadow="sm" radius="lg" p="xl" withBorder>
            <Stack gap="md">
                <Group justify="space-between">
                    <Group gap="xs">
                        <IconWorld size={20} color="var(--mantine-color-violet-6)" />
                        <Title order={5} fw={600}>{t('settings.trackingTitle', 'Custom Tracking Domain')}</Title>
                    </Group>
                    {statusBadge}
                </Group>

                <Text size="xs" c="dimmed">
                    {t('settings.trackingDesc', 'Use your own domain for open/click pixels and unsubscribe links. This keeps link reputation on your brand; if unset, the default system address is used.')}
                </Text>

                {!expectedTarget && (
                    <Alert variant="light" color="orange" icon={<IconAlertCircle size={16} />}>
                        <Text size="xs">{t('settings.trackingNoServerBase', 'Verification unavailable because the server tracking address is not configured.')}</Text>
                    </Alert>
                )}

                <Group align="flex-end" gap="xs">
                    <TextInput
                        label={t('settings.trackingDomainLabel', 'Tracking domain')}
                        placeholder="track.yourcompany.com"
                        size="xs" radius="md" style={{ flex: 1 }}
                        value={domain}
                        onChange={(e) => { setDomain(e.currentTarget.value); setDirty(true); }}
                        onKeyDown={(e) => { if (e.key === 'Enter' && dirty) saveMut.mutate(); }}
                    />
                    {dirty ? (
                        <Button size="xs" variant="light" color="violet" leftSection={<IconDeviceFloppy size={14} />}
                            onClick={() => saveMut.mutate()} loading={saveMut.isPending}
                        >
                            {t('common.save', 'Save')}
                        </Button>
                    ) : (
                        <Button size="xs" color="violet" leftSection={<IconShieldCheck size={14} />}
                            onClick={() => verifyMut.mutate()} loading={verifyMut.isPending} disabled={!canVerify}
                        >
                            {t('settings.trackingVerify', 'Verify')}
                        </Button>
                    )}
                </Group>

                {/* Gerekli CNAME kaydı — kopyalanabilir. */}
                {savedDomain && expectedTarget && (
                    <Paper p="sm" radius="md" withBorder bg="gray.0">
                        <Text size="xs" fw={600} mb={6}>{t('settings.trackingCnameHelp', 'Add this CNAME record at your DNS provider:')}</Text>
                        <Table withRowBorders={false} verticalSpacing={2} fz="xs">
                            <Table.Tbody>
                                <Table.Tr>
                                    <Table.Td c="dimmed" w={70}>{t('settings.trackingCnameType', 'Type')}</Table.Td>
                                    <Table.Td><Code>CNAME</Code></Table.Td>
                                </Table.Tr>
                                <Table.Tr>
                                    <Table.Td c="dimmed">{t('settings.trackingCnameName', 'Name')}</Table.Td>
                                    <Table.Td>
                                        <Group gap={6} wrap="nowrap">
                                            <Code>{savedDomain}</Code>
                                            <CopyRecord value={savedDomain} />
                                        </Group>
                                    </Table.Td>
                                </Table.Tr>
                                <Table.Tr>
                                    <Table.Td c="dimmed">{t('settings.trackingCnameTarget', 'Target')}</Table.Td>
                                    <Table.Td>
                                        <Group gap={6} wrap="nowrap">
                                            <Code>{expectedTarget}</Code>
                                            <CopyRecord value={expectedTarget} />
                                        </Group>
                                    </Table.Td>
                                </Table.Tr>
                            </Table.Tbody>
                        </Table>
                        <Text size="xs" c="dimmed" mt={8}>
                            {t('settings.trackingRailwayNote', 'After verifying, also add this domain as a custom domain in the Railway dashboard so tracking requests reach the server.')}
                        </Text>
                    </Paper>
                )}

                {savedDomain && data?.checked_at && (
                    <Text size="xs" c="dimmed">
                        {t('settings.trackingLastChecked', 'Last checked')}: {new Date(data.checked_at).toLocaleString()}
                    </Text>
                )}
            </Stack>
        </Paper>
    );
}

function CopyRecord({ value }: { value: string }) {
    return (
        <CopyButton value={value} timeout={1500}>
            {({ copied, copy }) => (
                <Tooltip label={copied ? 'Copied' : 'Copy'} withArrow>
                    <ActionIcon variant="subtle" color={copied ? 'green' : 'gray'} size="sm" onClick={copy}>
                        {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
                    </ActionIcon>
                </Tooltip>
            )}
        </CopyButton>
    );
}
