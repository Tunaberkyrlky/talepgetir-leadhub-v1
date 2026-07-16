/**
 * GuideTab — uygulama içi "Nasıl Kullanılır?" rehberi (TR). İçerik
 * `plans/COLD_CALL_MUSTERI_REHBERI.md` dokümanının özetidir; tam metin
 * paylaşılabilir doküman olarak ayrıca mevcuttur. $ ASLA gösterilmez.
 */
import { Accordion, List, Stack, Table, Text, Title } from '@mantine/core';
import { useTranslation } from 'react-i18next';

export default function GuideTab() {
    const { t } = useTranslation();

    return (
        <Stack maw={760}>
            <Title order={4}>{t('coldcall.guide.title', 'Nasıl Kullanılır?')}</Title>
            <Text c="dimmed" size="sm">
                {t('coldcall.guide.intro', 'Cold Call modülünü ilk kez kullanıyorsanız aşağıdaki bölümler sık sorulan soruların çoğunu yanıtlar.')}
            </Text>

            <Accordion variant="separated" defaultValue="numbers">
                <Accordion.Item value="numbers">
                    <Accordion.Control>{t('coldcall.guide.s1Title', '1. Numara Alma — Hangi Numarayı Seçmelisiniz?')}</Accordion.Control>
                    <Accordion.Panel>
                        <Stack gap="xs">
                            <Text size="sm">
                                {t('coldcall.guide.s1p1', 'Numara, karşı tarafın ekranında görünen arayan kimliğinizdir (caller ID). Asıl maliyeti belirleyen numaranın kendisi değil, hangi ülkeyi aradığınızdır.')}
                            </Text>
                            <Text size="sm">
                                {t('coldcall.guide.s1p2', 'Avrupa\'daki alıcıları arayacaksanız bir AB bölgesi numarası alın — önerimiz belgesiz İngiltere (GB) mobil veya İsveç (SE) mobil numaralardır; Almanya, Fransa, Hollanda gibi ülkelerdeki mobil hatları ararken çok daha az kredi harcarsınız.')}
                            </Text>
                            <Text size="sm">
                                {t('coldcall.guide.s1p3', 'ABD, Kanada veya diğer denizaşırı alıcıları arayacaksanız belgesiz bir ABD (US) veya Kanada (CA) yerel numarası alın.')}
                            </Text>
                            <Text size="sm">
                                {t('coldcall.guide.s1p4', 'Numara satın almak için Numaralarım sekmesine gidin, ülke seçin ve uygun numarayı satın alın. Birden fazla numaranız olabilir.')}
                            </Text>
                        </Stack>
                    </Accordion.Panel>
                </Accordion.Item>

                <Accordion.Item value="calling">
                    <Accordion.Control>{t('coldcall.guide.s2Title', '2. Arama Yapma')}</Accordion.Control>
                    <Accordion.Panel>
                        <List size="sm" spacing="xs">
                            <List.Item>{t('coldcall.guide.s2i1', 'Aramak istediğiniz şirket veya kişi sayfasını açıp ahize simgesine tıklayın, ya da bu ekranda Dialer sekmesinden doğrudan numara girin.')}</List.Item>
                            <List.Item>{t('coldcall.guide.s2i2', 'Açılan arama panelinde karşı tarafın bilgilerini, geçen süreyi, sessize alma düğmesini görürsünüz; kulaklık ve mikrofonunuzla tarayıcı üzerinden görüşürsünüz.')}</List.Item>
                            <List.Item>{t('coldcall.guide.s2i3', 'Görüşme bitince sonucu seçin (ulaşıldı, ilgilendi, cevapsız, vb.) ve isterseniz not ekleyin — kaydettiğinizde şirketin aktivite geçmişine işlenir.')}</List.Item>
                            <List.Item>{t('coldcall.guide.s2i4', 'Kısa süre içinde ses kaydı, yazıya döküm ve yapay zeka özeti de Aramalar sekmesinde görünür.')}</List.Item>
                        </List>
                    </Accordion.Panel>
                </Accordion.Item>

                <Accordion.Item value="credit">
                    <Accordion.Control>{t('coldcall.guide.s3Title', '3. Kredi / Bakiye Okuma ve Ülke Çarpanı')}</Accordion.Control>
                    <Accordion.Panel>
                        <Stack gap="xs">
                            <Text size="sm">
                                {t('coldcall.guide.s3p1', 'Krediniz dakika cinsindendir ve bir sonraki aya devreder — ay başında sıfırlanmaz. Kalan bakiyenizi ve bu dönem kullandığınızı bu sayfanın üst kısmında, tüm hareketlerinizi ise Kredi Geçmişi sekmesinde görebilirsiniz.')}
                            </Text>
                            <Text size="sm">
                                {t('coldcall.guide.s3p2', 'Her konuşma dakikası bire bir düşülmez; bir çarpan uygulanır (arayan numaranızın bölgesi ve aranan hattın sabit/mobil olmasına göre 1× ile 6× arasında). Mobil hatlar sabit hatlardan daha fazla kredi harcar; sistem çarpanı en fazla 6× ile sınırlar.')}
                            </Text>
                            <Table withTableBorder withColumnBorders>
                                <Table.Thead>
                                    <Table.Tr>
                                        <Table.Th>{t('coldcall.guide.tblNumber', 'Kullandığınız numara')}</Table.Th>
                                        <Table.Th>{t('coldcall.guide.tblLine', 'Aradığınız hat')}</Table.Th>
                                        <Table.Th>{t('coldcall.guide.tblMult', 'Çarpan')}</Table.Th>
                                        <Table.Th>{t('coldcall.guide.tblCost', '10 dk görüşme')}</Table.Th>
                                    </Table.Tr>
                                </Table.Thead>
                                <Table.Tbody>
                                    <Table.Tr>
                                        <Table.Td>{t('coldcall.guide.rowEuFixed_num', 'AB numarası (GB/SE mobil)')}</Table.Td>
                                        <Table.Td>{t('coldcall.guide.rowEuFixed_line', 'Almanya, sabit hat')}</Table.Td>
                                        <Table.Td>1×</Table.Td>
                                        <Table.Td>{t('coldcall.guide.rowEuFixed_cost', '10 kredi-dakika')}</Table.Td>
                                    </Table.Tr>
                                    <Table.Tr>
                                        <Table.Td>{t('coldcall.guide.rowEuMobile_num', 'AB numarası (GB/SE mobil)')}</Table.Td>
                                        <Table.Td>{t('coldcall.guide.rowEuMobile_line', 'Almanya, mobil')}</Table.Td>
                                        <Table.Td>2×</Table.Td>
                                        <Table.Td>{t('coldcall.guide.rowEuMobile_cost', '20 kredi-dakika')}</Table.Td>
                                    </Table.Tr>
                                    <Table.Tr>
                                        <Table.Td>{t('coldcall.guide.rowIntlFixed_num', 'ABD/Kanada numarası')}</Table.Td>
                                        <Table.Td>{t('coldcall.guide.rowIntlFixed_line', 'Almanya, sabit hat')}</Table.Td>
                                        <Table.Td>1×</Table.Td>
                                        <Table.Td>{t('coldcall.guide.rowIntlFixed_cost', '10 kredi-dakika')}</Table.Td>
                                    </Table.Tr>
                                    <Table.Tr>
                                        <Table.Td>{t('coldcall.guide.rowIntlMobile_num', 'ABD/Kanada numarası')}</Table.Td>
                                        <Table.Td>{t('coldcall.guide.rowIntlMobile_line', 'Almanya, mobil')}</Table.Td>
                                        <Table.Td>6×</Table.Td>
                                        <Table.Td>{t('coldcall.guide.rowIntlMobile_cost', '60 kredi-dakika')}</Table.Td>
                                    </Table.Tr>
                                </Table.Tbody>
                            </Table>
                            <Text size="sm">
                                {t('coldcall.guide.s3p3', 'Uygulama, aramadan önce dialer panelinde tahmini çarpanı gösterir; böylece ne kadar kredi harcayacağınızı önceden bilirsiniz. Konuşma süresi her zaman bir üst dakikaya yuvarlanır; bağlanan her arama en az 1 kredi-dakika olarak işlenir.')}
                            </Text>
                        </Stack>
                    </Accordion.Panel>
                </Accordion.Item>

                <Accordion.Item value="recording">
                    <Accordion.Control>{t('coldcall.guide.s4Title', '4. Kayıt ve Onay')}</Accordion.Control>
                    <Accordion.Panel>
                        <Text size="sm">
                            {t('coldcall.guide.s4p1', 'Görüşmeleriniz seçtiğiniz kayıt ayarına göre kaydedilir: her zaman kaydet, anons ile kaydet (önerilen ve varsayılan — görüşme başlamadan karşı tarafa otomatik bir anons çalınır) veya kaydetme. Bazı ülkelerde kaydın bildirilmesi yasal bir gerekliliktir; bu yüzden anonslu ayarı öneririz.')}
                        </Text>
                    </Accordion.Panel>
                </Accordion.Item>

                <Accordion.Item value="reputation">
                    <Accordion.Control>{t('coldcall.guide.s5Title', '5. Numara İtibarı ve Isıtma (Warm-up)')}</Accordion.Control>
                    <Accordion.Panel>
                        <List size="sm" spacing="xs">
                            <List.Item>{t('coldcall.guide.s5i1', 'Yeni satın aldığınız bir numarayla ilk günlerde düşük hacimde arama yapıp zamanla artırın — ani yüksek hacim spam riskini artırır.')}</List.Item>
                            <List.Item>{t('coldcall.guide.s5i2', 'Her numara için otomatik bir günlük arama tavanı uygulanır; yüksek hacimde arama gerekiyorsa birden fazla numara edinip aramalarınızı dağıtın.')}</List.Item>
                            <List.Item>{t('coldcall.guide.s5i3', 'Yerel bir numarayla aramak, karşı tarafın telefonu açma olasılığını artırır. Her numara için bir sağlık göstergesi (Numaralarım sekmesinde) cevaplanma oranını takip etmenizi sağlar.')}</List.Item>
                        </List>
                    </Accordion.Panel>
                </Accordion.Item>

                <Accordion.Item value="topup">
                    <Accordion.Control>{t('coldcall.guide.s6Title', '6. Kredi Yükleme')}</Accordion.Control>
                    <Accordion.Panel>
                        <Text size="sm">
                            {t('coldcall.guide.s6p1', 'Uygulama içinde kendi kendinize kredi satın alma imkânı şu an bulunmamaktadır. Bakiyeniz azaldığında veya tükendiğinde bizimle iletişime geçmeniz yeterlidir; talebiniz ve ödemeniz sonrasında dakikalar hesabınıza tanımlanır ve hemen bakiyenize yansır.')}
                        </Text>
                    </Accordion.Panel>
                </Accordion.Item>

                <Accordion.Item value="faq">
                    <Accordion.Control>{t('coldcall.guide.s7Title', '7. Sık Sorulan Sorular')}</Accordion.Control>
                    <Accordion.Panel>
                        <Stack gap="sm">
                            <div>
                                <Text size="sm" fw={600}>{t('coldcall.guide.faq1q', 'Kredim biterse ne olur?')}</Text>
                                <Text size="sm" c="dimmed">{t('coldcall.guide.faq1a', 'Bakiyeniz sıfırlandığında yeni bir arama başlatamazsınız. Devam eden bir görüşmeniz kesilmez. Yeniden arama için bizimle iletişime geçip kredi yüklemeniz gerekir.')}</Text>
                            </div>
                            <div>
                                <Text size="sm" fw={600}>{t('coldcall.guide.faq2q', 'Neden bazı Avrupa mobil numaralarını ararken 6 kat kredi yakıyorum?')}</Text>
                                <Text size="sm" c="dimmed">{t('coldcall.guide.faq2a', 'Genellikle bu, aramayı bir ABD/Kanada kökenli numarayla yapmanızdan kaynaklanır. Aynı hedefi bir AB bölgesi numarasıyla ararsanız çarpan çoğu zaman çok daha düşük olur.')}</Text>
                            </div>
                            <div>
                                <Text size="sm" fw={600}>{t('coldcall.guide.faq3q', 'Numara almak için belge gerekir mi?')}</Text>
                                <Text size="sm" c="dimmed">{t('coldcall.guide.faq3a', 'Şu an sunulan ABD yerel, Kanada yerel, İngiltere (GB) mobil ve İsveç (SE) mobil numaralar belge gerektirmez ve hızlıca aktive edilir.')}</Text>
                            </div>
                            <div>
                                <Text size="sm" fw={600}>{t('coldcall.guide.faq4q', 'Hangi ülkeleri arayamam?')}</Text>
                                <Text size="sm" c="dimmed">{t('coldcall.guide.faq4a', 'Uluslararası yaptırımlara tabi birkaç ülke (ör. Rusya, Kuzey Kore, İran, Suriye, Küba) aranabilir hedefler arasında değildir; ayrıntılar Ülke Tarifeleri sekmesinde.')}</Text>
                            </div>
                        </Stack>
                    </Accordion.Panel>
                </Accordion.Item>
            </Accordion>
        </Stack>
    );
}
