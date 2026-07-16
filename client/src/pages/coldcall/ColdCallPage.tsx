/**
 * ColdCallPage — Cold Call modülünün müşteri yüzeyi.
 *   • Arama: tek tık cold call (dialer) + canlı çağrı paneli + sonuç girişi.
 *   • Geçmiş: kayıtlar, transkriptler, AI özetleri.
 *   • Numaralarım: ülke bazlı numara satın alma/iade.
 *   • Ülke Tarifeleri: pahalı ve aranamayan ülkeler dahil tam tablo.
 */
import { Alert, Container, Group, Stack, Tabs, Text, Title } from '@mantine/core';
import { IconAlertTriangle, IconGlobe, IconHelpCircle, IconHistory, IconPhone, IconPhonePlus, IconReceipt } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { coldcallApi } from './../../components/coldcall/api';
import DialerTab from '../../components/coldcall/DialerTab';
import CallsTab from '../../components/coldcall/CallsTab';
import NumbersTab from '../../components/coldcall/NumbersTab';
import CountriesTab from '../../components/coldcall/CountriesTab';
import CreditHistoryTab from '../../components/coldcall/CreditHistoryTab';
import GuideTab from '../../components/coldcall/GuideTab';

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
    const balanceDisplay = config ? Math.max(0, Math.round(config.minutes_balance * 10) / 10) : 0;

    return (
        <Container size="xl" py="md">
            {config?.low_balance && (
                <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />} mb="md">
                    {t('coldcall.credit.lowBalanceBanner', 'Krediniz azalıyor ({{balance}} dk). Yükleme için bizimle iletişime geçin.', { balance: balanceDisplay })}
                </Alert>
            )}
            <Group justify="space-between" align="flex-start" mb="md">
                <div>
                    <Title order={2}>{t('coldcall.title', 'Cold Call')}</Title>
                    <Text c="dimmed" size="sm">
                        {t('coldcall.subtitle', 'Call your leads with one click — with your own local numbers, recordings and AI summaries.')}
                    </Text>
                </div>
                {config && (
                    <Stack gap={2} align="flex-end">
                        <Group gap={6} align="baseline">
                            <Text size="xs" c="dimmed">{t('coldcall.credit.balanceLabel', 'Kalan bakiye')}</Text>
                            <Text size="xl" fw={700} c={config.low_balance ? 'red' : undefined}>
                                {balanceDisplay} {t('coldcall.credit.minutesShort', 'dk')}
                            </Text>
                        </Group>
                        <Text size="xs" c="dimmed">
                            {t('coldcall.credit.usedPeriodLabel', 'Bu ay kullanılan: {{used}} dk', {
                                used: Math.round(config.minutes_used_period * 10) / 10,
                            })}
                        </Text>
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
                    <Tabs.Tab value="credits" leftSection={<IconReceipt size={16} />}>
                        {t('coldcall.credit.tabHistory', 'Kredi Geçmişi')}
                    </Tabs.Tab>
                    <Tabs.Tab value="guide" leftSection={<IconHelpCircle size={16} />}>
                        {t('coldcall.credit.tabGuide', 'Nasıl Kullanılır?')}
                    </Tabs.Tab>
                </Tabs.List>

                <Tabs.Panel value="dialer"><DialerTab initial={initialCall} /></Tabs.Panel>
                <Tabs.Panel value="calls"><CallsTab /></Tabs.Panel>
                <Tabs.Panel value="numbers"><NumbersTab /></Tabs.Panel>
                <Tabs.Panel value="countries"><CountriesTab /></Tabs.Panel>
                <Tabs.Panel value="credits"><CreditHistoryTab /></Tabs.Panel>
                <Tabs.Panel value="guide"><GuideTab /></Tabs.Panel>
            </Tabs>
        </Container>
    );
}
