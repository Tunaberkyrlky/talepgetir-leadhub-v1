import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
    Stack, Group, Text, TextInput, Button, Paper, ActionIcon, Badge, Loader, Center, Title,
} from '@mantine/core';
import { IconPlus, IconTrash, IconMail, IconDeviceFloppy } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showSuccess, showErrorFromApi } from '../../lib/notifications';

interface CcAddress {
    email: string;
    label: string;
}

export default function CcAddressesPanel() {
    const { t } = useTranslation();
    const qc = useQueryClient();
    const [addresses, setAddresses] = useState<CcAddress[]>([]);
    const [newEmail, setNewEmail] = useState('');
    const [newLabel, setNewLabel] = useState('');
    const [dirty, setDirty] = useState(false);

    const { data, isLoading } = useQuery<CcAddress[]>({
        queryKey: ['cc-addresses'],
        queryFn: async () => { const r = await api.get('/settings/cc-addresses'); return r.data.data; },
    });

    useEffect(() => {
        if (data) { setAddresses(data); setDirty(false); }
    }, [data]);

    const saveMut = useMutation<unknown, unknown, void>({
        mutationFn: async () => { await api.put('/settings/cc-addresses', { addresses }); },
        onSuccess: () => {
            showSuccess(t('settings.ccSaved', 'CC addresses saved'));
            setDirty(false);
            qc.invalidateQueries({ queryKey: ['cc-addresses'] });
        },
        onError: (err) => showErrorFromApi(err),
    });

    const addAddress = () => {
        const email = newEmail.trim().toLowerCase();
        if (!email || !email.includes('@')) return;
        if (addresses.some((a) => a.email === email)) return;
        setAddresses([...addresses, { email, label: newLabel.trim() || email }]);
        setNewEmail('');
        setNewLabel('');
        setDirty(true);
    };

    const removeAddress = (idx: number) => {
        setAddresses(addresses.filter((_, i) => i !== idx));
        setDirty(true);
    };

    if (isLoading) return <Center py="md"><Loader size="sm" color="violet" /></Center>;

    return (
        <Stack gap="md">
            <Group gap="xs">
                <IconMail size={20} color="var(--mantine-color-violet-6)" />
                <Title order={5} fw={600}>{t('settings.ccTitle', 'CC Addresses')}</Title>
            </Group>

            <Text size="xs" c="dimmed">
                {t('settings.ccDesc', 'Define CC addresses available when sending emails. These are shared across PlusVibe replies and drip campaigns.')}
            </Text>

            {/* Mevcut CC'ler */}
            {addresses.length > 0 && (
                <Stack gap={6}>
                    {addresses.map((addr, i) => (
                        <Paper key={addr.email} p="xs" radius="md" withBorder>
                            <Group justify="space-between">
                                <Group gap="xs">
                                    <Badge size="sm" variant="light" color="violet">{addr.label}</Badge>
                                    <Text size="xs" c="dimmed">{addr.email}</Text>
                                </Group>
                                <ActionIcon variant="subtle" color="red" size="sm" onClick={() => removeAddress(i)}>
                                    <IconTrash size={14} />
                                </ActionIcon>
                            </Group>
                        </Paper>
                    ))}
                </Stack>
            )}

            {/* Yeni CC ekle */}
            <Paper p="sm" radius="md" withBorder bg="gray.0">
                <Group align="flex-end" gap="xs">
                    <TextInput
                        label={t('settings.ccEmail', 'Email')}
                        placeholder="manager@company.com"
                        size="xs" radius="md" style={{ flex: 1 }}
                        value={newEmail}
                        onChange={(e) => setNewEmail(e.currentTarget.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') addAddress(); }}
                    />
                    <TextInput
                        label={t('settings.ccLabel', 'Label')}
                        placeholder="Manager"
                        size="xs" radius="md" style={{ flex: 1 }}
                        value={newLabel}
                        onChange={(e) => setNewLabel(e.currentTarget.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') addAddress(); }}
                    />
                    <Button size="xs" variant="light" color="violet" leftSection={<IconPlus size={14} />}
                        onClick={addAddress} disabled={!newEmail.includes('@')}
                    >
                        {t('common.add', 'Add')}
                    </Button>
                </Group>
            </Paper>

            {/* Kaydet */}
            {dirty && (
                <Group justify="flex-end">
                    <Button size="sm" leftSection={<IconDeviceFloppy size={16} />} color="violet" radius="md"
                        onClick={() => saveMut.mutate()} loading={saveMut.isPending}
                    >
                        {t('common.save', 'Save')}
                    </Button>
                </Group>
            )}
        </Stack>
    );
}
