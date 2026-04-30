export interface ChangelogEntry {
    version: string;
    date: string;
    title: { tr: string; en: string };
    features: { tr: string; en: string }[];
}

export const changelog: ChangelogEntry[] = [
    {
        version: '1.9.3',
        date: '2026-04-30',
        title: { tr: 'Kararlılık İyileştirmeleri', en: 'Stability Improvements' },
        features: [
            {
                tr: 'Mail panelinden aşama değiştirme artık daha güvenilir — önceki yöntem tüm şirket verisini gönderiyordu, şimdi sadece aşama güncelleniyor',
                en: 'Changing stage from the email panel is now more reliable — the previous method sent the full company payload, now only the stage is updated',
            },
            {
                tr: 'Toplu aşama değiştirme başarısız olursa artık hata bildirimi gösteriliyor',
                en: 'Bulk stage update now shows an error notification if the request fails',
            },
            {
                tr: 'Kişi silme onay ekranındaki güvenlik açığı giderildi — boş ID ile API çağrısı gitmesi önlendi',
                en: 'Fixed a safety gap in the contact delete confirmation — prevented API calls with an empty ID',
            },
        ],
    },
    {
        version: '1.9.2',
        date: '2026-04-30',
        title: { tr: 'Mail Eşleştirme İyileştirmeleri', en: 'Email Matching Improvements' },
        features: [
            {
                tr: 'Eşleşmemiş bir mail için şirket ararken bulunamazsa doğrudan popup içinden yeni şirket oluşturabilirsiniz',
                en: 'When no matching company is found for an email, you can now create a new company directly from the email popup',
            },
            {
                tr: 'Mail geçmişi en yeni mesaj üstte olacak şekilde sıralanıyor',
                en: 'Email thread history is now sorted with the most recent message at the top',
            },
        ],
    },
    {
        version: '1.9.1',
        date: '2026-04-27',
        title: { tr: 'Hata Düzeltmeleri', en: 'Bug Fixes' },
        features: [
            {
                tr: 'Staging ortamında beyaz ekran sorunu giderildi',
                en: 'Fixed white screen issue in staging environment',
            },
        ],
    },
    {
        version: '1.9.0',
        date: '2026-04-27',
        title: { tr: 'Kullanıcı Davranış Analitiği', en: 'User Behavior Analytics' },
        features: [
            {
                tr: 'Uygulama performansı ve kullanıcı deneyimi iyileştirmeleri',
                en: 'Application performance and user experience improvements',
            },
        ],
    },
    {
        version: '1.8.0',
        date: '2026-04-20',
        title: {
            tr: 'Ajanda Görünümü',
            en: 'Agenda View',
        },
        features: [
            {
                tr: 'Aktiviteler sayfasina Ajanda gorunumu eklendi gelecek toplantı, takip ve notlarinizi gün bazlı görebilirsiniz',
                en: 'Agenda view added to Activities page  see your upcoming meetings, follow-ups and notes grouped by day',
            },
            {
                tr: 'Her aktivitede kalan süre ve aciliyet rengi görünürr (kırmızı: bugünn, turuncu: 1-3 gün, yeşil: 3+ gün)',
                en: 'Each activity shows countdown and urgency color (red: today, orange: 1-3 days, green: 3+ days)',
            },
            {
                tr: 'Geçmiş aktiviteler kapalı grupta listelenir  tiklayarak açabilirsiniz',
                en: 'Overdue activities listed in a collapsed group  click to expand',
            },
            {
                tr: 'Dashboard\'a Yaklaşan Aktiviteler widget\'i eklendi  aşama dağılım grafiğinin yanında',
                en: 'Upcoming Activities widget added to Dashboard  next to stage distribution chart',
            },
        ],
    },
    {
        version: '1.7.6',
        date: '2026-04-20',
        title: {
            tr: 'Aktiviteler Yeni Görünüm',
            en: 'Activities New View',
        },
        features: [
            {
                tr: 'Aktiviteler sayfası artık şirket bazlı gruplu görünümde açılıyor, her bir şirketin aktivitelerini tek bakışta görebilirsiniz',
                en: 'Activities page now opens in company-grouped view, see all activities per company at a glance',
            },
            {
                tr: 'Şirketler en son aktiviteye göre sıralanır, en aktif şirket üstte görünür',
                en: 'Companies sorted by most recent activity, most active on top',
            },
        ],
    },
    {
        version: '1.7.4',
        date: '2026-04-19',
        title: {
            tr: 'Email Yanıt Paneli Yenilikleri',
            en: 'Email Reply Panel Updates',
        },
        features: [
            {
                tr: 'CC adresleri artik yanıt panelinden eklenebiliyor bir kez eklediğiniz adres sonraki yanıtlarda hazır badge olarak çıkıyor',
                en: 'Add CC addresses directly from the reply panel — once added, they appear as ready-to-use badges in future replies',
            },
            {
                tr: 'Bir maile yanıt yazdiginizda, aktivite eklediginizde veya stage degistirdiginizde o mail otomatik okundu olarak isaretlenir',
                en: 'When you reply to an email, add an activity, or change a stage, that email is automatically marked as read',
            },
            {
                tr: 'Taslak olarak kaydedilen mailler artik musteri hesaplarinda da gorunur',
                en: 'Draft saved emails are now visible to client accounts as well',
            },
        ],
    },
    {
        version: '1.7.1',
        date: '2026-04-18',
        title: {
            tr: 'Duzeltmeler',
            en: 'Fixes',
        },
        features: [
            {
                tr: '28 guvenlik ve performans guncellemesi, pipeline ve aktivite sayfasi duzeltmeleri',
                en: '28 security and performance updates, pipeline and activity page fixes',
            },
        ],
    },
    {
        version: '1.7.0',
        date: '2026-04-18',
        title: {
            tr: 'Drip Kampanya Sistemi',
            en: 'Drip Campaign System',
        },
        features: [
            {
                tr: 'Kampanyalar sayfasindan otomatik email dizileri olusturabilirsiniz — her adimda email veya bekleme suresi tanimlayabilirsiniz',
                en: 'Create automated email sequences from the Campaigns page — define email or delay steps for each stage',
            },
            {
                tr: 'Email icerigine degiskenler ekleyebilirsiniz (isim, sirket adi vb.) — cursor neredeyse oraya eklenir',
                en: 'Insert variables into email content (name, company, etc.) — inserted at cursor position',
            },
            {
                tr: 'Leadleri kampanyaya ekleyip ilerlemeyi takip edebilirsiniz — gonderilen, acilan, tiklanan emaillerin istatistikleri',
                en: 'Enroll leads into campaigns and track progress — statistics for sent, opened, and clicked emails',
            },
        ],
    },
    {
        version: '1.6.6',
        date: '2026-04-17',
        title: {
            tr: 'Email Yanit Ekrani Gelistirmeleri',
            en: 'Email Reply Screen Enhancements',
        },
        features: [
            {
                tr: 'Email yanit ekranindan dogrudan sonlandirma raporu olusturabilirsiniz — stage secip rapor yazmaniz yeterli',
                en: 'Create closing reports directly from the email reply screen — just select a stage and write your report',
            },
            {
                tr: 'Email ek sablonlarini artik tek tikla silebilirsiniz (onay ile)',
                en: 'Delete email attachment templates with one click (with confirmation)',
            },
        ],
    },
];
