import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Stack, Group, Text, Button, Switch, Chip, Select, Loader, Center, Title } from '@mantine/core';
import { IconMail, IconDeviceFloppy } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showSuccess, showErrorFromApi } from '../../lib/notifications';

interface DigestSettings {
    enabled: boolean;
    days: number[];
    hour: number;
}

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => ({
    value: String(h),
    label: `${String(h).padStart(2, '0')}:00`,
}));

export default function DigestSettingsPanel() {
    const { t, i18n } = useTranslation();
    const qc = useQueryClient();
    const [enabled, setEnabled] = useState(false);
    const [days, setDays] = useState<string[]>(['1', '4']);
    const [hour, setHour] = useState<string>('8');
    const [dirty, setDirty] = useState(false);

    const { data, isLoading } = useQuery<DigestSettings>({
        queryKey: ['digest-settings'],
        queryFn: async () => { const r = await api.get('/settings/digest'); return r.data.data; },
    });

    useEffect(() => {
        if (data) {
            setEnabled(Boolean(data.enabled));
            setDays((Array.isArray(data.days) && data.days.length ? data.days : [1, 4]).map(String));
            setHour(String(Number.isInteger(data.hour) ? data.hour : 8));
            setDirty(false);
        }
    }, [data]);

    const saveMut = useMutation<unknown, unknown, void>({
        mutationFn: async () => {
            await api.put('/settings/digest', { enabled, days: days.map(Number), hour: Number(hour) });
        },
        onSuccess: () => {
            showSuccess(t('settings.digestSaved', 'Özet maili ayarları kaydedildi'));
            setDirty(false);
            qc.invalidateQueries({ queryKey: ['digest-settings'] });
        },
        onError: (err) => showErrorFromApi(err),
    });

    // Haftagünü kısaltması (0=Pazar … 6=Cumartesi). 2024-01-07 bir Pazardır.
    const dayLabel = (wd: number) =>
        new Intl.DateTimeFormat(i18n.language, { weekday: 'short' }).format(new Date(2024, 0, 7 + wd));

    if (isLoading) return <Center py="md"><Loader size="sm" color="violet" /></Center>;

    return (
        <Stack gap="md">
            <Group gap="xs">
                <IconMail size={20} color="var(--mantine-color-violet-6)" />
                <Title order={5} fw={600}>{t('settings.digestTitle', 'Özet Maili')}</Title>
            </Group>

            <Text size="xs" c="dimmed">
                {t('settings.digestDesc', 'Seçtiğiniz günlerde bağlı mail hesaplarınıza önemli yanıtlar, eklenen aktiviteler, pipeline durumu ve vadesi gelen toplantıları içeren bir özet gönderilir.')}
            </Text>

            <Switch
                label={t('settings.digestEnabled', 'Özet mailini aç')}
                checked={enabled}
                onChange={(e) => { setEnabled(e.currentTarget.checked); setDirty(true); }}
            />

            {enabled && (
                <>
                    <Stack gap={4}>
                        <Text size="sm" fw={500}>{t('settings.digestDays', 'Gönderim günleri')}</Text>
                        <Chip.Group multiple value={days} onChange={(v) => { setDays(v); setDirty(true); }}>
                            <Group gap="xs" mt={4}>
                                {[1, 2, 3, 4, 5, 6, 0].map((wd) => (
                                    <Chip key={wd} value={String(wd)} size="sm">{dayLabel(wd)}</Chip>
                                ))}
                            </Group>
                        </Chip.Group>
                    </Stack>

                    <Select
                        label={t('settings.digestHour', 'Gönderim saati')}
                        data={HOUR_OPTIONS}
                        value={hour}
                        onChange={(v) => { if (v) { setHour(v); setDirty(true); } }}
                        w={140}
                        allowDeselect={false}
                    />
                </>
            )}

            {dirty && (
                <Group justify="flex-end">
                    <Button size="sm" leftSection={<IconDeviceFloppy size={16} />} color="violet" radius="md"
                        onClick={() => saveMut.mutate()} loading={saveMut.isPending}
                    >
                        {t('common.save', 'Kaydet')}
                    </Button>
                </Group>
            )}
        </Stack>
    );
}
