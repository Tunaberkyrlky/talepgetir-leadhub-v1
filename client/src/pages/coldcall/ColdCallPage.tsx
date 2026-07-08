/**
 * ColdCallPage — Cold Call modülünün müşteri yüzeyi.
 *   • Arama: tek tık cold call (dialer) + canlı çağrı paneli + sonuç girişi.
 *   • Geçmiş: kayıtlar, transkriptler, AI özetleri.
 *   • Numaralarım: ülke bazlı numara satın alma/iade.
 *   • Ülke Tarifeleri: pahalı ve aranamayan ülkeler dahil tam tablo.
 */
import { Container, Group, Progress, Stack, Tabs, Text, Title } from '@mantine/core';
import { IconGlobe, IconHistory, IconPhone, IconPhonePlus } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { coldcallApi } from './../../components/coldcall/api';
import DialerTab from '../../components/coldcall/DialerTab';
import CallsTab from '../../components/coldcall/CallsTab';
import NumbersTab from '../../components/coldcall/NumbersTab';
import CountriesTab from '../../components/coldcall/CountriesTab';

export default function ColdCallPage() {
    const { t } = useTranslation();
    // CRM yüzeylerinden gelen tek-tık arama (CallButton): ?to=…&company_id=…
    const [searchParams] = useSearchParams();
    const initialCall = searchParams.get('to')
        ? {
            to: searchParams.get('to')!,
            companyId: searchParams.get('company_id') ?? undefined,
            companyName: searchParams.get('company_name') ?? undefined,
            contactId: searchParams.get('contact_id') ?? undefined,
        }
        : undefined;
    const configQuery = useQuery({ queryKey: ['coldcall', 'config'], queryFn: coldcallApi.config });
    const config = configQuery.data;
    const quotaPct = config ? Math.min(100, (config.minutes_used / Math.max(1, config.minutes_quota)) * 100) : 0;

    return (
        <Container size="xl" py="md">
            <Group justify="space-between" align="flex-start" mb="md">
                <div>
                    <Title order={2}>{t('coldcall.title', 'Cold Call')}</Title>
                    <Text c="dimmed" size="sm">
                        {t('coldcall.subtitle', 'Call your leads with one click — with your own local numbers, recordings and AI summaries.')}
                    </Text>
                </div>
                {config && (
                    <Stack gap={4} w={220}>
                        <Group justify="space-between">
                            <Text size="xs" c="dimmed">{t('coldcall.quota', 'Minute quota')}</Text>
                            <Text size="xs" fw={600}>
                                {Math.round(config.minutes_used * 10) / 10} / {config.minutes_quota}
                            </Text>
                        </Group>
                        <Progress value={quotaPct} color={quotaPct > 90 ? 'red' : quotaPct > 70 ? 'orange' : 'violet'} size="sm" />
                    </Stack>
                )}
            </Group>

            <Tabs defaultValue="dialer" keepMounted={false}>
                <Tabs.List mb="md">
                    <Tabs.Tab value="dialer" leftSection={<IconPhone size={16} />}>
                        {t('coldcall.tabDialer', 'Dialer')}
                    </Tabs.Tab>
                    <Tabs.Tab value="calls" leftSection={<IconHistory size={16} />}>
                        {t('coldcall.tabCalls', 'Call history')}
                    </Tabs.Tab>
                    <Tabs.Tab value="numbers" leftSection={<IconPhonePlus size={16} />}>
                        {t('coldcall.tabNumbers', 'My numbers')}
                    </Tabs.Tab>
                    <Tabs.Tab value="countries" leftSection={<IconGlobe size={16} />}>
                        {t('coldcall.tabCountries', 'Country tariffs')}
                    </Tabs.Tab>
                </Tabs.List>

                <Tabs.Panel value="dialer"><DialerTab initial={initialCall} /></Tabs.Panel>
                <Tabs.Panel value="calls"><CallsTab /></Tabs.Panel>
                <Tabs.Panel value="numbers"><NumbersTab /></Tabs.Panel>
                <Tabs.Panel value="countries"><CountriesTab /></Tabs.Panel>
            </Tabs>
        </Container>
    );
}
