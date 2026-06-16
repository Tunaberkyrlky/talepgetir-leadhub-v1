export type ChangelogType = 'feature' | 'fix' | 'improvement' | 'security';

export interface ChangelogEntry {
    version: string;
    date: string;
    /** Baskın değişiklik tipi — başlıkta renkli badge olarak görünür. Eski entry'ler için opsiyonel (varsayılan: 'feature'). */
    type?: ChangelogType;
    title: { tr: string; en: string };
    features: { tr: string; en: string }[];
}

export const changelog: ChangelogEntry[] = [
    {
        version: '1.10.10',
        date: '2026-06-16',
        type: 'feature',
        title: { tr: 'Ürün Alanları Artık Etiket Listesi', en: 'Product Fields Are Now Tag Lists' },
        features: [
            {
                tr: 'Şirketlerdeki Ürün/Hizmetler ve Ürün Portföyü alanları artık tek bir metin yerine ayrı etiketler halinde tutuluyor. Şirket eklerken veya düzenlerken virgül, noktalı virgül ya da dikey çizgiyle yazdığınız ürünler otomatik olarak ayrı etiketlere bölünür, içe aktarımda da çoklu ürünler tek tek listelenir.',
                en: 'The Products/Services and Product Portfolio fields on companies are now kept as separate tags instead of a single text. When you add or edit a company, the products you type with commas, semicolons or vertical bars are split into separate tags automatically, and on import multiple products are listed one by one.',
            },
            {
                tr: 'Ürün filtresinde bir kategori seçtiğinizde, o ürünü içeren tüm şirketleri listeleyebilirsiniz.',
                en: 'When you pick a category in the product filter, you can list every company that includes that product.',
            },
        ],
    },
    {
        version: '1.10.9',
        date: '2026-06-16',
        type: 'fix',
        title: { tr: 'Kararlılık ve Bağlantı Düzeltmeleri', en: 'Stability & Link Fixes' },
        features: [
            {
                tr: 'Gelen cevapları yakalarken bir mail hesabında bağlantı hatası oluşması artık akışı kesmiyor. Hata güvenle kaydediliyor ve diğer hesaplar normal şekilde taranmaya devam ediyor.',
                en: 'A connection error on one mailbox while capturing incoming replies no longer interrupts the flow. The error is logged safely and the other mailboxes keep being polled normally.',
            },
            {
                tr: 'Gönderdiğiniz yanıt, yönlendirme ve yeni maillerde bir bağlantının hemen ardına kapanış parantezi veya ayraç koyduğunuzda, bağlantı artık bu işareti içine almadan doğru adrese gidiyor.',
                en: 'In the replies, forwards and new mails you send, when a closing parenthesis or bracket comes right after a link, the link now points to the correct address without swallowing that character.',
            },
        ],
    },
    {
        version: '1.10.8',
        date: '2026-06-15',
        type: 'improvement',
        title: { tr: 'Kararlılık ve Hata Bildirimleri', en: 'Stability & Error Notifications' },
        features: [
            {
                tr: 'Geçmiş mailleri içe aktarırken bir kampanya başarısız olursa artık uyarı alıyorsunuz. Önceden bu durum sessiz kalıp her şey tamamlanmış gibi görünebiliyordu.',
                en: 'When a campaign fails while importing past emails you now get a warning. Previously this could stay silent and look like everything completed.',
            },
            {
                tr: 'Mail yakalama tarafında kod kalitesi ve hata yakalama güçlendirildi. Beklenmedik içerikler akışı durdurmadan güvenle işleniyor ve gönderdiğiniz açılış mailleri ilgili şirketle daha tutarlı eşleşiyor.',
                en: 'Code quality and error handling on the mail capture side were strengthened. Unexpected content is handled safely without breaking the flow, and the opening emails you sent match to the right company more consistently.',
            },
        ],
    },
    {
        version: '1.10.7',
        date: '2026-06-15',
        type: 'feature',
        title: { tr: 'Mail Açılma Takibi ve Yeni Özet Kartları', en: 'Mail Open Tracking & New Summary Cards' },
        features: [
            {
                tr: 'Email Yanıtları\'ndan kendi mail hesabınızla gönderdiğiniz yanıt, yönlendirme ve yeni maillerin açılıp açılmadığını artık görebilirsiniz. Yazışma geçmişinde gönderdiğiniz her mailin yanında açıldı işareti belirir, üstteki kartta da toplam açılma oranını izleyebilirsiniz. Bu takip kampanya gönderimlerini değil, sizin elle gönderdiğiniz mailleri kapsar.',
                en: 'You can now see whether the replies, forwards and new mails you send from your own mailbox get opened. Each mail you send shows an opened indicator in the thread, and the summary card tracks your overall open rate. This covers the mails you send by hand, not campaign sends.',
            },
            {
                tr: 'Email Yanıtları üstündeki özet kartları yenilendi: Okunmamış, İlgilenen, Yanıt Bekleyen ve Açılan. Bir karta tıklayarak listeyi o duruma göre filtreleyebilir, seçtiğiniz tarih aralığına göre de güncel rakamları görebilirsiniz.',
                en: 'The summary cards on Email Replies are refreshed: Unread, Interested, Awaiting Reply and Opened. Click a card to filter the list by that state, and the numbers follow the date range you pick.',
            },
        ],
    },
    {
        version: '1.10.6',
        date: '2026-06-15',
        type: 'feature',
        title: { tr: 'Açılış Mailiniz Konuşmada', en: 'Your Opening Email in the Thread' },
        features: [
            {
                tr: 'PlusVibe cevap konuşmalarında artık kampanyayı başlatan ilk mailiniz ve sonraki adım mailleriniz de görünüyor. Böylece bir yazışmanın tamamını, gönderdiğiniz açılış mailinden itibaren tek ekranda takip edebilirsiniz.',
                en: 'PlusVibe reply conversations now also show the opening email that started the campaign and your follow-up step emails. So you can follow a whole conversation in one place, starting from the opening email you sent.',
            },
        ],
    },
    {
        version: '1.10.5',
        date: '2026-06-11',
        type: 'fix',
        title: { tr: 'Mail Gönderiminde Düzeltmeler', en: 'Mail Sending Fixes' },
        features: [
            {
                tr: 'Outlook hesabından gönderirken birden fazla CC adresi artık doğru iletiliyor.',
                en: 'Multiple CC addresses are now delivered correctly when sending from Outlook.',
            },
            {
                tr: 'Yeni mailde eklediğiniz tek seferlik CC artık kayıtlı listenize otomatik eklenmiyor.',
                en: 'A one-off CC added in a new mail is no longer auto-saved to your list.',
            },
        ],
    },
    {
        version: '1.10.4',
        date: '2026-06-11',
        type: 'feature',
        title: { tr: 'Kendi Mail Sunucunuz (SMTP/IMAP)', en: 'Your Own Mail Server (SMTP/IMAP)' },
        features: [
            {
                tr: 'Gmail/Outlook\'un yanında artık kendi SMTP sunucunuzu da bağlayabilir, maillerinizi kendi adresinizden gönderebilirsiniz. Birden fazla hesap ekleyip gönderirken aralarından seçim yapabilirsiniz.',
                en: 'Alongside Gmail/Outlook, you can now connect your own SMTP server and send mail from your own address. Add multiple accounts and pick which one to send from.',
            },
            {
                tr: 'Bağladığınız hesaba gelen cevaplar otomatik olarak sisteme düşüyor ve ilgili şirketle eşleşiyor, böylece tüm yazışmayı tek ekranda takip edebilirsiniz.',
                en: 'Replies arriving to your connected account are pulled in automatically and matched to the right company, so you can follow the whole conversation in one place.',
            },
        ],
    },
    {
        version: '1.10.3',
        date: '2026-06-05',
        type: 'feature',
        title: { tr: 'İçe Aktarma Eşleşme Denetimi', en: 'Import Match Audit' },
        features: [
            {
                tr: 'İçe aktarma sonuç ekranına Eşleşme Denetimi bölümü eklendi. Hangi kişinin hangi şirkete bağlandığını, şirketin yeni mi oluşturulduğunu yoksa mevcut bir şirketle mi eşleştiğini ve mükerrer olduğu için atlanan kişileri tek bir tabloda görebilirsiniz.',
                en: 'A Match Audit section was added to the import result screen. You can see which contact was linked to which company, whether the company was newly created or matched to an existing one, and which contacts were skipped as duplicates, all in a single table.',
            },
            {
                tr: 'İçe aktarma geçmişinde herhangi bir kayda tıklayarak o içe aktarmanın eşleşme detayını açabilir, tüm listeyi CSV olarak indirebilirsiniz.',
                en: 'In the import history you can click any record to open that import\'s match detail, and download the full list as CSV.',
            },
        ],
    },
    {
        version: '1.10.2',
        date: '2026-06-05',
        type: 'improvement',
        title: { tr: 'Mail Altyapısı Güçlendirildi', en: 'Stronger Email Infrastructure' },
        features: [
            {
                tr: 'Mail altyapısı güçlendirildi. Farklı kaynaklardan kurulan mail bağlantıları tek bir standart yapıda toplanarak yanıtlarınızın her zaman doğru hesaptan gönderilmesi ve gelen maillerin şirketlerle tutarlı biçimde eşleşmesi sağlandı.',
                en: 'The email infrastructure has been strengthened. Mail connections set up from different sources are now unified under a single standard, so your replies always go out from the correct account and incoming emails match to companies consistently.',
            },
            {
                tr: 'Kampanya yanıtlarını yeniden içe aktardığınızda kayıtlar tekrar oluşmuyor, eksik kalan gönderen bilgileri de tamamlanıyor.',
                en: 'Re-importing campaign replies no longer creates duplicate records, and any missing sender details are filled in.',
            },
        ],
    },
    {
        version: '1.10.1',
        date: '2026-06-02',
        type: 'fix',
        title: { tr: 'Yanıtta "Kimden" Düzeltmesi', en: 'Reply "From" Fix' },
        features: [
            {
                tr: 'Bir maile yanıt verirken "Kimden" alanı artık doğru hesabınızı gösteriyor. Bazı maillerde karşı tarafın adresi görünüyordu.',
                en: 'When replying to an email, the "From" field now shows your correct account. On some emails it was showing the other side\'s address.',
            },
        ],
    },
    {
        version: '1.10.0',
        date: '2026-05-24',
        type: 'feature',
        title: { tr: 'Gmail Bağlantısı', en: 'Gmail Connection' },
        features: [
            {
                tr: 'Ayarlar > E-posta Bağlantısı\'ndan Gmail hesabınızı bağlayabilirsiniz; drip kampanya mailleri artık sizin Gmail adresinizden gönderilip Gönderildi klasörünüze düşüyor',
                en: 'Connect Gmail from Settings > Email Connection; drip campaign emails are now sent from your own Gmail account and land in your Sent folder',
            },
        ],
    },
    {
        version: '1.9.22',
        date: '2026-05-24',
        type: 'improvement',
        title: { tr: 'Aktiviteler Sayfası Sadeleştirildi', en: 'Activities Page Simplified' },
        features: [
            {
                tr: 'Aktiviteler sayfasındaki stat kartlarına tıklayarak listeyi tipe göre filtreleyebilirsiniz. Şirkete göre filtre kutusu da eklendi, şirket adıyla doğru kayda hızlıca ulaşabilirsiniz.',
                en: 'On the Activities page, you can now click the stat cards to filter the list by type. A company filter was also added, so you can quickly find the right record by typing a company name.',
            },
            {
                tr: 'Yeni aktivite ekleme formu sadeleşti. Varsayılan tür artık "Not". Detay, kişi ve görünürlük alanları doğrudan görünür durumda. Telefonda form tam ekran açılıyor.',
                en: 'The new activity form is now simpler. Default type is "Note". Detail, contact and visibility fields are visible by default. On mobile the form opens fullscreen.',
            },
        ],
    },
    {
        version: '1.9.21',
        date: '2026-05-23',
        type: 'improvement',
        title: { tr: 'Yönlendirmeye Dosya Eki', en: 'Attachments on Forward' },
        features: [
            {
                tr: 'E-posta yanıtlarını yönlendirirken artık dosya eki de seçebilirsiniz. Yanıtlama ekranındakiyle aynı şablon listesinden istediğiniz dosyaları işaretleyip yönlendirme mesajınıza otomatik kart olarak ekleyebilirsiniz. Önceden bu akış yalnızca doğrudan yanıtlarda mevcuttu.',
                en: 'When forwarding email replies, you can now attach files too. Pick from the same template list used in replies; the selected files are appended as cards on the forwarded message. Previously, attachments were limited to direct replies only.',
            },
            {
                tr: 'Yenilikler panelinde versiyonun yanındaki tip rozetleri (Özellik / Düzeltme / İyileştirme / Güvenlik) sadeleştirildi; artık küçük renkli bir nokta ve ince yazı şeklinde, görsel olarak daha az dikkat çeker.',
                en: 'The type badges (Feature/Fix/Improvement/Security) next to each version in the What\'s New panel are now minimal — a small colored dot with light text, less visually noisy.',
            },
        ],
    },
    {
        version: '1.9.20',
        date: '2026-05-20',
        type: 'fix',
        title: { tr: 'Hata Bildirim Toast\'ı Düzeltildi', en: 'Error Notification Toast Fixed' },
        features: [
            {
                tr: 'API hataları geldiğinde sağ alttaki kırmızı bildirim artık doğru gözüküyor; hata mesajı, saat, "İstek No" ve "Hata Bildir" linki tekrar görünür durumda. Eski sürümde bu bilgileri render eden kod React ile uyumsuz olduğu için toast içeriği boş kalıyordu.',
                en: 'When an API error occurs, the red toast in the bottom-right is no longer empty — the error message, time, "Request ID" and "Report Error" link are visible again. The previous renderer was incompatible with React and silently dropped the content.',
            },
        ],
    },
    {
        version: '1.9.19',
        date: '2026-05-20',
        type: 'improvement',
        title: { tr: 'Arama Sıralaması & Zaman Filtresi', en: 'Search Ranking & Time Filter' },
        features: [
            {
                tr: 'Şirket ve kişi listelerinde arama yaparken tam eşleşen sonuç artık en üstte; "Pharma" yazınca tam isimli kayıt birinci sırada, sonra adında "Pharma" geçen diğer şirketler. Eskiden tam eşleşme aşağılarda kalıyordu.',
                en: 'When searching companies and people, exact matches now rank first — typing "Pharma" puts the exact match on top, followed by other entries containing "Pharma". Previously, exact matches were buried further down the list.',
            },
            {
                tr: 'Şirketler sayfasındaki zaman filtresi varsayılan olarak "Tümü" oldu (eskiden "Bu Ay"dı). Tüm geçmiş kayıtlar açılışta görünüyor, istersen Gün/Hafta/Ay/Özel ile daraltabilirsin.',
                en: 'The time filter on the Companies page now defaults to "All" (previously "This Month"). All historical records are visible on load; narrow with Day/Week/Month/Custom whenever you need to.',
            },
        ],
    },
    {
        version: '1.9.18',
        date: '2026-05-20',
        type: 'improvement',
        title: { tr: 'E-posta Eşleştirmesi Düzeltildi', en: 'Email Matching Fixed' },
        features: [
            {
                tr: 'Gelen e-posta yanıtları ile şirketlerin eşleme algoritması iyileştirildi, benzer isimli farklı şirketler (örn. "Pharma" ile "NomPharma") arasındaki karışıklık önlendi. Geçmişteki yanlış eşleşmeler de toplu olarak düzeltildi, mailler doğru şirket kartlarına taşındı.',
                en: 'Incoming email replies now match to the correct company — confusion between similarly named companies (e.g. "Pharma" vs "NomPharma") is prevented. Past mismatches were also fixed in bulk; mails have been moved to the correct company cards.',
            },
        ],
    },
    {
        version: '1.9.17',
        date: '2026-05-18',
        type: 'feature',
        title: { tr: 'Hata Bildirmek Artık Tek Tık', en: 'Reporting Errors Is Now One Click' },
        features: [
            {
                tr: 'Bir işlem hata verdiğinde sağ alttaki bildirimde artık saat ve "İstek No" görünüyor, yanındaki "Hata Bildir" linkine tıklayınca geri bildirim formu hatanın tüm bilgileriyle otomatik dolu açılıyor — sadece ne yapmaya çalıştığını birkaç cümleyle eklemen yeterli',
                en: 'When an action fails, the toast in the bottom-right now shows the time and a "Request ID", and clicking the new "Report Error" link opens the feedback form pre-filled with all the details (page, time, request, status, server message, request ID) — you only have to add a sentence about what you were doing',
            },
        ],
    },
    {
        version: '1.9.16',
        date: '2026-05-18',
        type: 'fix',
        title: { tr: 'İstek Limiti Rahatlatıldı', en: 'Request Limit Relaxed' },
        features: [
            {
                tr: 'Hata bildirim formu ve diğer butonlar yoğun kullanımda "Çok fazla istek" hatası veriyordu; dakikalık istek limiti artırıldı, aktif kullanım sırasında butonlar engelleme yapmıyor',
                en: 'The bug report form and other buttons occasionally surfaced a "Too many requests" error under heavy use; the per-minute request limit has been raised so active sessions no longer hit the wall',
            },
        ],
    },
    {
        version: '1.9.15',
        date: '2026-05-18',
        type: 'improvement',
        title: { tr: 'Eklenti Akışı İyileştirmeleri', en: 'Attachment Workflow Improvements' },
        features: [
            {
                tr: 'Mail yanıtlarken ve yönlendirirken aynı anda 10 ek dosyaya kadar seçebilirsiniz; önceki 3 dosya sınırı kaldırıldı',
                en: 'You can now attach up to 10 files when replying or forwarding emails; the previous 3-file limit has been lifted',
            },
            {
                tr: 'Eklentileri artık düzenleyebilirsiniz, eklenti üzerindeki kalem ikonuna tıklayın, ad/URL/tip/boyut alanlarını güncelleyin.',
                en: 'Attachments can now be edited — click the pencil icon on any attachment to update its name, URL, type or size in place; no need to delete and re-create from scratch',
            },
        ],
    },
    {
        version: '1.9.14',
        date: '2026-05-14',
        type: 'fix',
        title: { tr: 'Konum Eşlemesi Daha İsabetli', en: 'Smarter Location Matching' },
        features: [
            {
                tr: 'Aynı isimli farklı ülke şehirleri belirtilen ülkeye göre doğru eşleniyor (örn. "Katy, Texas, USA" → Mali değil ABD\'deki Katy)',
                en: 'Cities sharing a name across countries now resolve to the country specified in the string (e.g. "Katy, Texas, USA" → Katy in the US, not Mali)',
            },
        ],
    },
    {
        version: '1.9.13',
        date: '2026-05-13',
        type: 'improvement',
        title: { tr: 'Pipeline Sadeleştirildi & Karar Akışı', en: 'Pipeline Simplified & Closing Flow' },
        features: [
            {
                tr: 'Pipeline için 6 temel aşama kurgulandı (Cold → Bağlantı Kuruldu → Görüşmede → Takipte → Kazanıldı / Kaybedildi); fazlasına ihtiyacın olursa Ayarlar > Pipeline\'dan istediğin aşamayı ekleyebilirsin',
                en: 'New tenants now start with a leaner 6-stage pipeline (Cold → Connected → In Meeting → Follow Up → Won / Lost); add more from Settings > Pipeline whenever you need them',
            },
            {
                tr: 'Müşterilere özel aşama ekleme artık daha güvenli: aşama listesindeki teknik kısıtlamalar kaldırıldı, istediğin slug\'la özel aşama oluşturabilirsin',
                en: 'Adding custom stages is more reliable: the underlying database constraint that blocked some slugs has been removed, so any slug you create now works',
            },
            {
                tr: 'Arka planda: veritabanı güvenliği sertleştirildi (RLS politikaları, fonksiyon yetkileri, audit log koruması) ve kullanıcı silmeyi engelleyen FK kısıtlamaları gevşetildi',
                en: 'Behind the scenes: database security hardening (RLS policies, function execute grants, audit log lockdown) and FK constraints relaxed to allow user deletion',
            },
        ],
    },
    {
        version: '1.9.12',
        date: '2026-05-12',
        title: { tr: 'Yanıt Gönderici Adresi Düzeltmesi', en: 'Reply Sender Address Fix' },
        features: [
            {
                tr: 'Bir maile yanıt yazarken "Kimden" alanı artık o mailin geldiği gerçek hesabı gösteriyor; daha önce kampanyanın ilk hesabını sabit gösteriyordu',
                en: 'When replying to an email, the "From" field now shows the actual mailbox the lead replied to, not the campaign\'s first account',
            },
        ],
    },
    {
        version: '1.9.11',
        date: '2026-05-11',
        title: { tr: 'Mail Yönlendirme', en: 'Email Forwarding' },
        features: [
            {
                tr: 'Mail detayında artık "Yönlendir" butonu var — bir maili istediğiniz adrese, üstüne kendi notunuzu ekleyerek iletebilirsiniz; orijinal mail otomatik olarak notunuzun altında ekleniyor',
                en: 'The email detail view now has a "Forward" button — forward any email to a recipient of your choice with your own note on top; the original message is appended automatically below',
            },
            {
                tr: 'Yönlendirilmiş mailler thread görünümünde sarı "Yönlendirildi" rozeti ve hedef adresle birlikte görünüyor; gönderilen ve yönlendirilen mailleri tek bakışta ayırt edebilirsiniz',
                en: 'Forwarded messages appear with a yellow "Forwarded" badge and the target address in the thread view, so you can tell sent and forwarded emails apart at a glance',
            },
        ],
    },
    {
        version: '1.9.10',
        date: '2026-05-07',
        title: { tr: 'Konum Filtresi & Harita Akışı', en: 'Location Filter & Map Drill-Down' },
        features: [
            {
                tr: 'Haritada ülkeye tıklayınca, konumu sadece şehir olarak girilmiş şirketler de tabloda görünür',
                en: 'Clicking a country on the map also shows companies whose location was entered as a city only',
            },
            {
                tr: 'Konum filtresi Türkçe ülke adıyla arama desteklendi, şehir aramak için yazmaya başlayın',
                en: 'Location filter shows countries by default with Turkish search support; start typing to look up cities',
            },
        ],
    },
    {
        version: '1.9.7',
        date: '2026-05-06',
        title: { tr: 'Tam Ekran Harita Düzeltmesi', en: 'Fullscreen Map Fix' },
        features: [
            {
                tr: 'Dashboard\'daki dünya haritasını tam ekrana aldığınızda ülke üzerine geldiğinizde açılan bilgi balonu ve ülkeye tıklayınca açılan şirket tablosu artık çalışıyor',
                en: 'When the dashboard world map is enlarged to fullscreen, the hover tooltip and the company table that opens on country click now work correctly',
            },
        ],
    },
    {
        version: '1.9.6',
        date: '2026-05-05',
        title: { tr: 'Aylık Rapor Ayarlara Taşındı', en: 'Monthly Report Moved to Settings' },
        features: [
            {
                tr: 'Aylık rapor indirme özelliğine artık Ayarlar > Raporlar sekmesinden ulaşabilirsiniz',
                en: 'The monthly report download button has been removed from Dashboard; it is now accessible via Settings > Reports tab',
            },

        ],
    },
    {
        version: '1.9.4',
        date: '2026-04-30',
        title: { tr: 'Mail Okuma Deneyimi', en: 'Email Reading Experience' },
        features: [
            {
                tr: 'Mail geçmişinde alıntılanan (quoted) eski mesajlar artık gizli — "···" butonuna tıklayarak açabilirsiniz',
                en: 'Quoted previous messages in email threads are now collapsed — click "···" to expand them',
            },
        ],
    },
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
