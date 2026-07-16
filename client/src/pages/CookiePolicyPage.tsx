import { Anchor, Button, Container, Divider, Group, List, Paper, Stack, Table, Text, Title } from '@mantine/core';
import { IconArrowLeft, IconAdjustments } from '@tabler/icons-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useConsent } from '../contexts/ConsentContext';

export default function CookiePolicyPage() {
    const navigate = useNavigate();
    const { i18n } = useTranslation();
    const { openPreferences } = useConsent();
    const tr = i18n.language.startsWith('tr');

    const copy = tr ? {
        title: 'Çerez ve Yerel Depolama Politikası',
        updated: 'Son güncelleme: 16 Temmuz 2026',
        intro: 'Bu politika, TG Core uygulamasında çerezleri ve tarayıcı depolamasını neden kullandığımızı açıklar. İsteğe bağlı kategorileri istediğiniz zaman kapatabilirsiniz.',
        operator: 'Veri sorumlusu iletişimi: info@tibexa.com',
        whatTitle: 'Kullandığımız kategoriler',
        category: 'Kategori / sağlayıcı',
        purpose: 'Amaç',
        duration: 'Süre',
        necessary: 'Zorunlu — TG Core',
        necessaryPurpose: 'Güvenli oturum, kimlik doğrulama, çalışma alanı seçimi ve gizlilik tercihinin saklanması.',
        necessaryDuration: 'Oturum veya yapılandırılmış oturum süresi; tercih kaydı politika sürümü değişene kadar.',
        analytics: 'Analitik — PostHog',
        analyticsPurpose: 'Ürün kullanımını, sayfa geçişlerini ve destekle ilişkili ürün olaylarını ölçmek. Form girişleri ve ekran metinleri oturum kayıtlarında maskelenir.',
        analyticsDuration: 'Yalnızca onay sonrasında; PostHog proje saklama ayarlarına göre.',
        support: 'Canlı destek — Tawk.to',
        supportPurpose: 'Canlı sohbeti sürdürmek, geri dönen sohbeti tanımak ve bulunduğunuz ürün modülünü destek bağlamına eklemek.',
        supportDuration: 'Oturum verileri oturum boyunca; ziyaretçi tanımlayıcısı Tawk.to yapılandırmasına göre (genellikle 6 aya kadar).',
        dataTitle: 'İşlenen veriler',
        dataItems: [
            'PostHog: kullanıcı kimliği, hesap rolü, tenant kimliği/seviyesi, sayfa yolu ve açıkça tanımlanan ürün olayları.',
            'Tawk.to: ad/e-posta, tenant bilgisi, rol, mevcut modül/sayfa ve sohbet sırasında sizin paylaştığınız içerik.',
            'Destek konuşmalarında şifre, erişim anahtarı, özel müşteri listesi veya gereksiz kişisel veri paylaşmayın.',
        ],
        providersTitle: 'Üçüncü taraflar ve aktarım',
        providers: 'PostHog ve Tawk.to hizmet sağlayıcı (veri işleyen) olarak kullanılmaktadır. Uluslararası veri aktarımı söz konusu olabilir; sözleşme, DPA ve uygun aktarım mekanizmaları şirket tarafından devreye alınmalıdır.',
        rightsTitle: 'Tercihleriniz ve haklarınız',
        rights: 'İsteğe bağlı analitik veya destek depolamasını reddedebilir ya da verdiğiniz izni aşağıdaki düğmeden geri çekebilirsiniz. Erişim, düzeltme veya silme talepleri için info@tibexa.com adresine yazabilirsiniz.',
        manage: 'Tercihleri yönet',
        back: 'Geri dön',
        legal: 'Bu metin ürün uygulaması için hazırlanmış operasyonel bir taslaktır; yayın öncesinde şirket unvanı, saklama süreleri ve tabi olunan KVKK/GDPR yükümlülükleri hukuk danışmanı tarafından doğrulanmalıdır.',
    } : {
        title: 'Cookie and Local Storage Policy',
        updated: 'Last updated: July 16, 2026',
        intro: 'This policy explains why the TG Core application uses cookies and browser storage. You can disable optional categories at any time.',
        operator: 'Data controller contact: info@tibexa.com',
        whatTitle: 'Categories we use',
        category: 'Category / provider',
        purpose: 'Purpose',
        duration: 'Duration',
        necessary: 'Necessary — TG Core',
        necessaryPurpose: 'Secure sessions, authentication, workspace selection, and storage of your privacy choice.',
        necessaryDuration: 'Session or configured authentication lifetime; preference record until the policy version changes.',
        analytics: 'Analytics — PostHog',
        analyticsPurpose: 'Measure product usage, page navigation, and product events related to support. Form inputs and screen text are masked in session recordings.',
        analyticsDuration: 'Only after consent; according to the PostHog project retention settings.',
        support: 'Live support — Tawk.to',
        supportPurpose: 'Maintain live chat, recognize a returning conversation, and attach your current product module as support context.',
        supportDuration: 'Session data for the session; visitor identifier according to Tawk.to configuration (typically up to 6 months).',
        dataTitle: 'Data processed',
        dataItems: [
            'PostHog: user ID, account role, tenant ID/tier, page path, and explicitly defined product events.',
            'Tawk.to: name/email, tenant details, role, current module/page, and content you choose to share in the conversation.',
            'Do not share passwords, access keys, private customer lists, or unnecessary personal data in support conversations.',
        ],
        providersTitle: 'Providers and transfers',
        providers: 'PostHog and Tawk.to are used as service providers (processors). International transfers may occur; the company should put the applicable contracts, DPAs, and transfer mechanisms in place.',
        rightsTitle: 'Your choices and rights',
        rights: 'You can reject optional analytics or support storage, or withdraw consent using the button below. Contact info@tibexa.com for access, correction, or deletion requests.',
        manage: 'Manage preferences',
        back: 'Go back',
        legal: 'This is an operational product draft. Company identity, retention periods, and applicable KVKK/GDPR obligations must be reviewed by legal counsel before publication.',
    };

    const rows = [
        [copy.necessary, copy.necessaryPurpose, copy.necessaryDuration],
        [copy.analytics, copy.analyticsPurpose, copy.analyticsDuration],
        [copy.support, copy.supportPurpose, copy.supportDuration],
    ];

    return (
        <Container size="md" py={48}>
            <Stack gap="xl">
                <Group justify="space-between">
                    <Button variant="subtle" leftSection={<IconArrowLeft size={16} />} onClick={() => navigate(-1)}>{copy.back}</Button>
                    <Button variant="light" leftSection={<IconAdjustments size={16} />} onClick={openPreferences}>{copy.manage}</Button>
                </Group>
                <div>
                    <Title order={1}>{copy.title}</Title>
                    <Text c="dimmed" mt="xs">{copy.updated}</Text>
                </div>
                <Paper withBorder radius="lg" p="xl">
                    <Stack gap="lg">
                        <Text>{copy.intro}</Text>
                        <Text size="sm" fw={600}>{copy.operator}</Text>
                        <Divider />
                        <Title order={2} size="h3">{copy.whatTitle}</Title>
                        <Table.ScrollContainer minWidth={680}>
                            <Table striped withTableBorder verticalSpacing="sm">
                                <Table.Thead><Table.Tr><Table.Th>{copy.category}</Table.Th><Table.Th>{copy.purpose}</Table.Th><Table.Th>{copy.duration}</Table.Th></Table.Tr></Table.Thead>
                                <Table.Tbody>{rows.map((row) => <Table.Tr key={row[0]}>{row.map((cell) => <Table.Td key={cell}>{cell}</Table.Td>)}</Table.Tr>)}</Table.Tbody>
                            </Table>
                        </Table.ScrollContainer>
                        <Title order={2} size="h3">{copy.dataTitle}</Title>
                        <List spacing="xs">{copy.dataItems.map((item) => <List.Item key={item}>{item}</List.Item>)}</List>
                        <Title order={2} size="h3">{copy.providersTitle}</Title>
                        <Text>{copy.providers}</Text>
                        <Group gap="md">
                            <Anchor href="https://posthog.com/privacy" target="_blank" rel="noreferrer">PostHog Privacy</Anchor>
                            <Anchor href="https://www.tawk.to/privacy-policy/" target="_blank" rel="noreferrer">Tawk.to Privacy</Anchor>
                        </Group>
                        <Title order={2} size="h3">{copy.rightsTitle}</Title>
                        <Text>{copy.rights}</Text>
                        <Paper bg="yellow.0" c="yellow.9" radius="md" p="md"><Text size="sm">{copy.legal}</Text></Paper>
                    </Stack>
                </Paper>
            </Stack>
        </Container>
    );
}
