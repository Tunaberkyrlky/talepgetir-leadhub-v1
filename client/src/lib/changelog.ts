export type ChangelogType = 'feature' | 'fix' | 'improvement' | 'security';

interface Localized { tr: string; en: string }

export interface ChangelogEntry {
    version: string;
    date: string;
    /** Baskın değişiklik tipi — başlıkta renkli badge olarak görünür. Eski entry'ler için opsiyonel (varsayılan: 'feature'). */
    type?: ChangelogType;
    /** İlgili ekran/sayfa anahtarı (başlıkta rozet). Verilmezse başlıktan otomatik çıkarsanır. */
    area?: string;
    title: Localized;
    /**
     * Yeni format (kısa ve öz, 3 soruya cevap). Her biri tek cümle.
     *   about — Bu güncelleme ne hakkında? (zorunlu)
     *   usage — Yeni kullanım nasıl? (yeni ekran/buton/davranış varsa)
     *   notes — Neleri bilmeliyim? (uyarı/sınır varsa)
     */
    about?: Localized;
    usage?: Localized;
    notes?: Localized;
    /** Eski format — yalnızca yeni-format alanları yoksa gösterilir (geriye dönük). */
    features?: Localized[];
}

export const changelog: ChangelogEntry[] = [
    {
        version: '1.19.10',
        date: '2026-07-17',
        type: 'improvement',
        area: 'general',
        title: { tr: 'Kararlılık İyileştirmeleri', en: 'Stability Improvements' },
        about: {
            tr: 'Bir sayfada beklenmedik bir hata olsa bile artık yalnız o sayfa etkileniyor, menü ve diğer ekranlar çalışmaya devam ediyor.',
            en: 'If an unexpected error occurs on a page, only that page is affected now while the menu and other screens keep working.',
        },
        notes: {
            tr: 'Hatalı sayfada "Yenile" düğmesine basarak ya da başka bir menüye geçerek devam edebilirsiniz.',
            en: 'On an errored page you can continue by clicking the Reload button or switching to another menu item.',
        },
    },
    {
        version: '1.19.9',
        date: '2026-07-15',
        type: 'improvement',
        area: 'general',
        title: { tr: 'Hata Bildiriminde Yazma Alanı Üstte', en: 'Report Field Now on Top' },
        about: {
            tr: 'Hata bildirim penceresinde yazma alanı en üste alındı, otomatik doldurulan sayfa ve tarih bilgisi birkaç satır aşağıda duruyor.',
            en: 'In the error report window the writing area is now at the top, with the auto-filled page and date shown a few lines below.',
        },
        usage: {
            tr: 'Hata Bildir penceresini açtığınızda açıklamayı doğrudan en üstteki boş alana yazabilirsiniz.',
            en: 'When you open the Report Error window you can type your description directly into the empty area at the top.',
        },
    },
    {
        version: '1.19.8',
        date: '2026-07-13',
        type: 'fix',
        area: 'mail',
        title: { tr: 'Silinen Kutuya Yanıt Düzeltmesi', en: 'Reply-to-Deleted-Mailbox Fix' },
        about: {
            tr: 'Yanıt vermek istediğiniz konuşmanın gönderim kutusu kapatılmışsa yanıtınız artık otomatik olarak aktif bir kutudan gönderilir.',
            en: 'If the sending mailbox of the conversation you are replying to has been closed, your reply is now sent automatically from an active mailbox.',
        },
        notes: {
            tr: 'Gönderim adresi değiştiğinde bir bilgi mesajıyla haberdar edilirsiniz; hiçbir aktif kutu kalmadıysa yanıt gönderilemez.',
            en: 'You are notified when the sending address changes; if no active mailbox remains, the reply cannot be sent.',
        },
    },
    {
        version: '1.19.7',
        date: '2026-07-10',
        type: 'fix',
        title: { tr: 'Yandex Mail Gönderim Düzeltmesi', en: 'Yandex Mail Sending Fix' },
        about: {
            tr: 'Yandex posta kutusu bağlı hesaplarda mail gönderme ve alma sorunu giderildi.',
            en: 'Fixed a sending and receiving issue for accounts connected to a Yandex mailbox.',
        },
    },
    {
        version: '1.19.6',
        date: '2026-07-09',
        type: 'improvement',
        title: { tr: 'Ürün / Hizmetler Tek Alanda', en: 'Products / Services in One Field' },
        about: {
            tr: 'Ürün portföyü ile ürün / hizmetler alanları tek "Ürün / Hizmetler" listesinde birleştirildi ve kategoriler tek tek etiketler olarak ayrı tutuluyor.',
            en: 'Product portfolio and products / services are combined into a single "Products / Services" list, with categories kept separately as individual tags.',
        },
        usage: {
            tr: 'Şirket formundaki tek "Ürün / Hizmetler" kutusuna kategorileri virgülle ekleyebilir, filtrede bunlara göre arayabilirsiniz.',
            en: 'You can add categories to the single "Products / Services" box in the company form separated by commas, and filter by them.',
        },
        notes: {
            tr: 'Önceki ürün portföyü değerleriniz bu listeye taşındı, ayrıca birleşik kayıtlar tek tek kategorilere bölündü.',
            en: 'Your previous product portfolio values were moved into this list, and combined entries were split into individual categories.',
        },
    },
    {
        version: '1.19.5',
        date: '2026-07-08',
        type: 'improvement',
        title: { tr: 'Taslaklar Otomatik Kaydediliyor', en: 'Drafts Save Automatically' },
        about: {
            tr: 'Yanıt yazarken taslağınız otomatik kaydedilir; pencereyi kapatsanız bile yazdıklarınız, seçtiğiniz ekler ve CC korunur.',
            en: 'While you write a reply, your draft is saved automatically; even if you close the window, your text, selected attachments and CC are kept.',
        },
        usage: {
            tr: 'Yazmaya devam edin; artık "Taslak Kaydet"e basmanız gerekmez, kutunun altında "Taslak otomatik kaydedildi" görünür.',
            en: 'Just keep writing — you no longer need to press "Save Draft"; "Draft saved automatically" appears under the box.',
        },
        notes: {
            tr: 'Yanıtı gönderdiğinizde taslak otomatik temizlenir.',
            en: 'Once you send the reply, the draft is cleared automatically.',
        },
    },
    {
        version: '1.19.4',
        date: '2026-07-07',
        type: 'fix',
        title: { tr: 'Konuşma Açılış Maili', en: 'Conversation Opening Email' },
        about: {
            tr: 'Başlangıç maili görünmeyen konuşmalar düzeltildi, kampanya açılış maili artık konuşmanın başında görünüyor.',
            en: 'Conversations missing their opening email are fixed, the campaign opening email now appears at the start of the conversation.',
        },
    },
    {
        version: '1.19.3',
        date: '2026-07-06',
        type: 'improvement',
        title: { tr: 'SMTP/IMAP Bağlantı Hataları Daha Açıklayıcı', en: 'Clearer SMTP/IMAP Connection Errors' },
        about: {
            tr: 'Kendi mail sunucunuzu bağlarken doğrulama başarısız olursa, artık nedenini (şifre, port/SSL, sertifika ya da erişim) belirten net bir mesaj görürsünüz.',
            en: 'When connecting your own mail server fails, you now see a clear message stating the reason (password, port/SSL, certificate, or reachability).',
        },
    },
    {
        version: '1.19.2',
        date: '2026-07-01',
        type: 'improvement',
        area: 'general',
        title: { tr: 'Yenilikler Paneli: Filtre ve Sayfa Etiketi', en: 'What’s New: Filter & Page Label' },
        about: {
            tr: 'Yenilikler panelinde artık yeni özellikler öne çıkar ve her güncellemenin hangi sayfayla ilgili olduğu başlıkta görünür.',
            en: 'In the What’s New panel, new features are highlighted and each update shows which page it relates to in its title.',
        },
        usage: {
            tr: 'Üstteki Yeni Özellikler ve Tümü düğmesinden düzeltme ile iyileştirmeleri de görebilirsiniz.',
            en: 'Use the New Features and All toggle at the top to also see fixes and improvements.',
        },
    },
    {
        version: '1.19.1',
        date: '2026-07-01',
        type: 'feature',
        title: { tr: 'Dashboard Mail Özeti', en: 'Dashboard Mail Summary' },
        about: {
            tr: 'Dashboard\'da okunmamış, yanıt bekleyen ve ilgilenen mail sayılarını tek bakışta görebilirsiniz.',
            en: 'On the dashboard you can see unread, awaiting-reply and interested mail counts at a glance.',
        },
        usage: {
            tr: 'Aşama Dağılımı\'nın altındaki Mail Özeti kartına tıklayınca mail sayfası, seçili tarih aralığı ve ilgili filtreyle açılır.',
            en: 'Click a Mail Summary card under Stage Distribution to open the mail page with the selected date range and matching filter applied.',
        },
        notes: {
            tr: 'Mail sayfası artık açılışta tüm mailleri gösterir; istediğiniz tarih aralığını üstten seçebilirsiniz.',
            en: 'The mail page now shows all mail on open; you can pick a date range from the top.',
        },
    },
    {
        version: '1.19.0',
        date: '2026-07-01',
        type: 'feature',
        title: { tr: 'Outlook / Microsoft 365 Bağlantısı', en: 'Outlook / Microsoft 365 Connection' },
        about: {
            tr: 'Outlook veya Microsoft 365 kutunuzu bağlayıp maillerinizi kendi kutunuzdan gönderebilirsiniz.',
            en: 'You can connect your Outlook or Microsoft 365 mailbox and send emails from your own mailbox.',
        },
        usage: {
            tr: 'Ayarlar, E-posta Bağlantısı bölümünden Outlook’a tıklayıp hesabınızla giriş yapın.',
            en: 'Go to Settings, Email Connection and click Outlook to sign in with your account.',
        },
        notes: {
            tr: 'Kurumsal Microsoft 365 hesaplarında ilk bağlantı için yöneticinizin onayı gerekebilir.',
            en: 'Corporate Microsoft 365 accounts may require admin approval for the first connection.',
        },
    },
    {
        version: '1.18.2',
        date: '2026-06-30',
        type: 'fix',
        title: { tr: 'Ek Kaybı Düzeltmeleri', en: 'Attachment Loss Fixes' },
        about: {
            tr: 'Yönlendirilen maillerde ve kaydedilmiş taslaktan gönderimde eklerin kaybolması düzeltildi; yönlendirmede ekler bağlantı kartı, yanıtta gerçek dosya olarak gider.',
            en: 'Fixed attachments being lost on forwarded emails and when sending from a saved draft; forwards send link cards and replies send real files.',
        },
        notes: {
            tr: 'Taslağı tekrar açtığınızda seçtiğiniz ekler artık korunur.',
            en: 'Your selected attachments are now kept when you reopen a draft.',
        },
    },
    {
        version: '1.18.1',
        date: '2026-06-29',
        type: 'fix',
        title: { tr: 'Ek Kartı Tıklama Düzeltmesi', en: 'Attachment Card Click Fix' },
        about: {
            tr: 'Gönderdiğiniz maillerde ek kartlarındaki "Görüntüle" butonu artık tüm e-posta istemcilerinde (Outlook dâhil) tıklanabilir bir bağlantı olarak gidiyor.',
            en: 'The "View" button on attachment cards in the emails you send is now a clickable link in all email clients, including Outlook.',
        },
    },
    {
        version: '1.18.0',
        date: '2026-06-29',
        type: 'feature',
        title: { tr: 'Mail Geçmişinde Ekler', en: 'Attachments in Thread' },
        about: {
            tr: 'Mail geçmişinde, gönderdiğiniz eklerin adını, boyutunu ve tipini görebilir ve karta tıklayarak dosyayı açabilirsiniz.',
            en: 'In the email thread, you can see the name, size and type of the attachments you sent, and open a file by clicking its card.',
        },
        usage: {
            tr: 'Bir mesaj geçmişini açın; gönderilen ek kartları ilgili mesajın altında görünür, açmak için karta tıklayın.',
            en: 'Open a message thread; the attachment cards appear under the message they were sent with, and you click a card to open it.',
        },
        notes: {
            tr: 'Gönderimden sonra silinen ekler "mevcut değil" olarak gösterilir.',
            en: 'Attachments deleted after sending are shown as "no longer available".',
        },
    },
    {
        version: '1.17.2',
        date: '2026-06-29',
        type: 'improvement',
        title: { tr: 'Mail Eklerinde İyileştirme', en: 'Email Attachment Improvements' },
        about: {
            tr: 'PlusVibe yanıt ve yönlendirmelerinde seçtiğiniz dosyalar artık indirme linki yerine gerçek mail eki olarak gönderiliyor.',
            en: 'Files you attach to PlusVibe replies and forwards are now delivered as real email attachments instead of a download link.',
        },
        notes: {
            tr: 'Bir ek gönderilemezse mail yine iletilir ve hangi dosyanın eklenemediğini bildiren bir uyarı görürsünüz.',
            en: 'If an attachment can’t be included, the email is still delivered and you’ll see a warning naming the file that was left off.',
        },
    },
    {
        version: '1.17.1',
        date: '2026-06-24',
        type: 'improvement',
        title: { tr: 'Özet Maili Ayarları', en: 'Summary Email Settings' },
        about: {
            tr: 'Özet mailini artık Ayarlar sayfasından kendiniz açıp gönderim günlerini ve saatini seçebilirsiniz.',
            en: 'You can now enable the summary email yourself from the Settings page and choose its send days and time.',
        },
        usage: {
            tr: 'Ayarlar, Özet maili sekmesinden özelliği açın, günleri ve saati seçip kaydedin.',
            en: 'In Settings, open the Summary email tab, enable it, pick the days and time, and save.',
        },
        notes: {
            tr: 'Özet seçtiğiniz saatte yalnızca o saatte gönderilir ve tenant’a bağlı aktif mail hesaplarına ulaşır.',
            en: 'The summary is sent only at the time you choose and reaches the active mailboxes connected to the tenant.',
        },
    },
    {
        version: '1.17.0',
        date: '2026-06-24',
        type: 'feature',
        title: { tr: 'Özet Maili', en: 'Summary Email' },
        about: {
            tr: 'Seçtiğiniz günlerde, müşterinin bağlı mail hesaplarına önemli yanıtları, eklenen aktiviteleri, pipeline durumunu ve vadesi gelen toplantıları içeren bir özet maili gider.',
            en: 'On the days you choose, a summary email covering important replies, added activities, pipeline status, and upcoming meetings is sent to the customer’s connected mailboxes.',
        },
        usage: {
            tr: 'Yönetim ekranında müşteriyi düzenleyip Özet maili seçeneğini açın ve gönderim günlerini seçin.',
            en: 'In the Admin screen, edit the customer, turn on Summary email and pick the send days.',
        },
        notes: {
            tr: 'Özet yalnızca müşteriye bağlı aktif mail hesaplarına gider; bağlı hesap yoksa gönderim olmaz.',
            en: 'The summary only goes to the customer’s active connected mailboxes; with no connected mailbox, nothing is sent.',
        },
    },
    {
        version: '1.16.1',
        date: '2026-06-24',
        type: 'improvement',
        title: { tr: 'Adım Adları ve Kolay Bağlama', en: 'Step Names & Easier Wiring' },
        about: {
            tr: 'E-posta adımlarına ad verebilir, bu adı node’larda, listede ve koşul seçimlerinde konu yerine görebilirsiniz; görsel tuvalde adımları bağlamak ve bağlantıyı kaldırmak kolaylaştı.',
            en: 'You can name email steps and see that name instead of the subject on nodes, in the list, and in condition pickers; connecting steps and removing connections on the visual canvas is now easier.',
        },
        usage: {
            tr: 'E-posta düzenleyicisindeki Adım adı alanını doldurun; tuvalde bir node’un noktasından diğerine sürükleyerek bağlayın, bir bağlantının üstüne gelince çıkan × ile kaldırın.',
            en: 'Fill the Step name field in the email editor; on the canvas drag from a node’s dot to another to connect, and use the × that appears when you hover a connection to remove it.',
        },
    },
    {
        version: '1.16.0',
        date: '2026-06-24',
        type: 'feature',
        title: { tr: 'Koşullu Dallanma', en: 'Conditional Branching' },
        about: {
            tr: 'Görsel akışa koşul adımı ekleyip adımları birbirine bağlayarak, kişinin maili açıp açmadığına, tıklayıp tıklamadığına ya da yanıtlayıp yanıtlamadığına göre kampanyayı Evet ve Hayır dallarına ayırabilirsiniz.',
            en: 'You can add a condition step to the visual flow and wire steps together to split the campaign into Yes and No branches based on whether the contact opened, clicked, or replied.',
        },
        usage: {
            tr: 'Görsel görünümde bir node’un noktasından diğerine sürükleyerek bağlantı kurun, çizgideki × ile koparın; koşul için sağ panelden tipi, kontrol edilecek maili, bekleme süresini ve dalların gideceği adımı seçin.',
            en: 'In the Visual view, drag from a node’s dot to another to connect, click the × on a line to disconnect; for a condition, pick the type, which email to check, the wait time, and where each branch goes from the right panel.',
        },
        notes: {
            tr: 'Koşul önce belirlediğiniz süre kadar bekler, sonra kişiyi kontrol edip dalı seçer; bir dalı boş bırakırsanız dizi orada sonlanır.',
            en: 'The condition waits for the time you set, then checks the contact and picks a branch; leaving a branch empty ends the sequence there.',
        },
    },
    {
        version: '1.15.6',
        date: '2026-06-24',
        type: 'improvement',
        title: { tr: 'Görsel Akış Cilası', en: 'Visual Flow Polish' },
        about: {
            tr: 'Görsel akışta mail konuları temiz görünür, boş adımlar uyarı gösterir, bağlantılar yön okuyla akar ve artık ayrı bir Bekleme adımı ekleyebilirsiniz.',
            en: 'In the visual flow, email subjects display cleanly, empty steps show a warning, connections flow with a direction arrow, and you can now add a standalone Wait step.',
        },
        usage: {
            tr: 'Görsel görünümün araç çubuğundaki Bekle ekle ile bekleme koyun; bir Bekleme kutusuna tıklayıp süresini düzenleyin.',
            en: 'Use Add wait on the Visual toolbar to insert a wait; click a Wait box to edit its duration.',
        },
    },
    {
        version: '1.15.5',
        date: '2026-06-24',
        type: 'fix',
        title: { tr: 'Görsel Akış Düzeltmeleri', en: 'Visual Flow Fixes' },
        about: {
            tr: 'Görsel akışta bir kutuyu sürüklerken kutu artık imleci takip ediyor ve adımlar arasındaki bağlantı çizgileri görünüyor.',
            en: 'In the visual flow, a box now follows the cursor while you drag it and the connector lines between steps are visible.',
        },
    },
    {
        version: '1.15.4',
        date: '2026-06-24',
        type: 'improvement',
        title: { tr: 'Tuvalde Serbest Yerleşim', en: 'Free Canvas Layout' },
        about: {
            tr: 'Görsel akışta mail kutularını sürükleyerek istediğiniz gibi yerleştirebilir, düzeniniz kayıt sonrası korunur.',
            en: 'In the visual flow you can drag email boxes to arrange them as you like, and your layout is kept after saving.',
        },
        usage: {
            tr: 'Görsel görünümde bir mail kutusunu sürükleyip bırakın; yeri kaydettiğinizde hatırlanır.',
            en: 'Drag and drop an email box in the Visual view; its place is remembered when you save.',
        },
        notes: {
            tr: 'Duraklatılmış bir kampanyayı düzenlemek, dizide ilerleyen kişilerin sırasını artık bozmaz.',
            en: 'Editing a paused campaign no longer disrupts the position of contacts already moving through it.',
        },
    },
    {
        version: '1.15.3',
        date: '2026-06-23',
        type: 'improvement',
        title: { tr: 'Görsel Akışta Düzenleme', en: 'Editing in the Visual Flow' },
        about: {
            tr: 'Görsel görünümde artık mail adımı ekleyebilir, seçili adımı silebilir ve bir kutuya tıklayıp içeriğini düzenleyebilirsiniz.',
            en: 'In the Visual view you can now add an email step, delete the selected step, and click a box to edit its content.',
        },
        usage: {
            tr: 'Dizi sekmesinde Görsel’e geçin; tuval üstündeki Mail adımı ekle ile ekleyin, bir kutuyu seçip Sil’e basın, içeriği sağdaki düzenleyiciden değiştirin.',
            en: 'Switch to Visual on the Sequence tab; add with Add email step on the canvas, select a box and press Delete, and edit the content from the panel on the right.',
        },
    },
    {
        version: '1.15.0',
        date: '2026-06-23',
        type: 'feature',
        title: { tr: 'Görsel Kampanya Akışı (önizleme)', en: 'Visual Campaign Flow (preview)' },
        about: {
            tr: 'Kampanya dizisini artık Görsel görünümde bir akış şeması olarak görebilir, bir mail kutusuna tıklayıp içeriğini yanda açabilirsiniz.',
            en: 'You can now view the campaign sequence as a flow diagram in the new Visual view, and click an email box to open its content beside it.',
        },
        usage: {
            tr: 'Dizi sekmesindeki Basit/Görsel anahtarından Görsel’e geçin; tuvali sürükleyip yakınlaştırabilirsiniz.',
            en: 'Switch to Visual from the Simple/Visual toggle on the Sequence tab; you can pan and zoom the canvas.',
        },
        notes: {
            tr: 'Görsel görünüm şimdilik salt görüntüleme; ekleme ve düzenleme Basit görünümde yapılır.',
            en: 'The Visual view is view-only for now; adding and editing is still done in the Simple view.',
        },
    },
    {
        version: '1.14.0',
        date: '2026-06-23',
        type: 'feature',
        title: { tr: 'Otomatik Kampanya Atama', en: 'Automatic Campaign Assignment' },
        about: {
            tr: 'PlusVibe kampanyaları artık adının önekine göre ilgili müşteriye otomatik atanır.',
            en: 'PlusVibe campaigns are now auto-assigned to the matching customer based on their name prefix.',
        },
        usage: {
            tr: 'Kampanyalar sayfasındaki Atama sekmesinden önek kuralı ekleyin (örn. NTR → Naturagen); eşleşen kampanyalar otomatik atanır.',
            en: 'On the Assignment tab of the Campaigns page, add a prefix rule (e.g. NTR → Naturagen); matching campaigns are assigned automatically.',
        },
        notes: {
            tr: 'Tek tek kampanya atama kaldırıldı; atama tamamen önek kurallarıyla yapılır.',
            en: 'Per-campaign manual assignment was removed; assignment is now driven entirely by prefix rules.',
        },
    },
    {
        version: '1.13.6',
        date: '2026-06-23',
        type: 'feature',
        title: { tr: 'Adım Bazlı Kampanya Analizi', en: 'Per-Step Campaign Analytics' },
        about: {
            tr: 'Kampanya analizinde her adımın kaç gönderim ve açılma aldığını ayrı ayrı görebilirsiniz.',
            en: 'In campaign analytics you can now see how many sends and opens each step received separately.',
        },
        usage: {
            tr: 'Çok adımlı bir kampanyanın analiz bölümünde Adıma göre kırılımı görünür.',
            en: 'The By step breakdown appears in the analytics section of a multi-step campaign.',
        },
        notes: {
            tr: 'Kırılım yalnızca bu güncellemeden sonra gönderilen mailleri kapsar, önceki gönderimler adımsız sayılır.',
            en: 'The breakdown covers only emails sent after this update; earlier sends are counted without a step.',
        },
    },
    {
        version: '1.13.5',
        date: '2026-06-23',
        type: 'improvement',
        title: { tr: 'Kampanya Listesi Sıralama ve Sayfalama', en: 'Campaign List Sorting and Pagination' },
        about: {
            tr: 'Kampanya listesini en yeni, en eski, ada veya duruma göre sıralayabilir, sayfalar arasında gezebilir ve her kampanyanın son gönderim tarihini görebilirsiniz.',
            en: 'You can sort the campaign list by newest, oldest, name or status, page through it, and see each campaign’s last send date.',
        },
        usage: {
            tr: 'Liste üstündeki Sırala kutusundan sıralamayı seçebilir, çok kampanya olduğunda altta çıkan sayfa numaralarıyla gezebilirsiniz.',
            en: 'Pick an order from the Sort box above the list and use the page numbers that appear below when there are many campaigns.',
        },
    },
    {
        version: '1.13.4',
        date: '2026-06-23',
        type: 'improvement',
        title: { tr: 'Kampanya Ekranı Cilası', en: 'Campaign Screen Polish' },
        about: {
            tr: 'Kampanya ekranları yüklenirken boş ekran yerine içeriğin iskeleti görünür, hiç kampanyanız yokken oluşturma butonu sunulur ve değişken etiketleri klavyeyle de kullanılabilir.',
            en: 'Campaign screens now show a content skeleton while loading instead of a blank spinner, offer a create button when you have no campaigns yet, and the variable chips can be used with the keyboard.',
        },
        usage: {
            tr: 'Henüz kampanyanız yoksa boş ekranda çıkan yeni kampanya butonuyla doğrudan oluşturmaya başlayabilirsiniz.',
            en: 'When you have no campaigns yet, you can start creating right away with the new campaign button on the empty screen.',
        },
    },
    {
        version: '1.13.3',
        date: '2026-06-23',
        type: 'fix',
        title: { tr: 'Kampanya Kayıt Düzeltmeleri', en: 'Campaign Enrollment Fixes' },
        about: {
            tr: 'Yanıt veren kişiler, kampanya duraklatılıp yeniden başlatılsa bile tekrar mail almıyor ve boş konulu adımlar hatasız kaydedilebiliyor.',
            en: 'Contacts who replied no longer get re-emailed even after a campaign is paused and resumed, and steps with an empty subject save without errors.',
        },
    },
    {
        version: '1.13.2',
        date: '2026-06-22',
        type: 'improvement',
        title: { tr: 'Kitle Yönetimi', en: 'Audience Management' },
        about: {
            tr: 'Kayıtlı kişilerde arama yapabilir, duruma göre filtreleyip sayfalayabilir ve birden çok kişiyi tek seferde durdurabilir, sürdürebilir veya çıkarabilirsiniz; ayrıca duraklatılmış kampanyaya da kişi ekleyebilirsiniz.',
            en: 'You can search enrolled contacts, filter by status and page through them, and pause, resume or remove several at once, and you can now also add contacts to a paused campaign.',
        },
        usage: {
            tr: 'Kitle sekmesindeki kayıtlı listenin üstünden arayıp filtreleyebilir, satırları işaretleyip üstte çıkan çubuktan toplu işlem yapabilirsiniz.',
            en: 'Search and filter from the top of the enrolled list on the Audience tab, tick rows and use the bar that appears to act on them in bulk.',
        },
    },
    {
        version: '1.13.1',
        date: '2026-06-22',
        type: 'feature',
        title: { tr: 'Spintax Görsel Editörü', en: 'Visual Spintax Editor' },
        about: {
            tr: 'Spintax blokları artık metin yığını yerine tıklanabilir etiketler olarak görünüyor; e-posta konusu ve gövdesinde çift süslü parantez yazınca değişken ve spintax önerileri alabilirsiniz.',
            en: 'Spintax blocks now appear as clickable tags instead of a wall of text, and you get variable and spintax suggestions by typing double curly braces in both the subject and the body.',
        },
        usage: {
            tr: 'Konu veya gövdedeki bir spintax etiketine tıklayıp seçeneklerini düzenleyebilir, çift süslü parantez yazarak açılan listeden değişken ya da spintax ekleyebilirsiniz.',
            en: 'Click a spintax tag in the subject or body to edit its options, and add a variable or spintax from the list that opens when you type double curly braces.',
        },
    },
    {
        version: '1.13.0',
        date: '2026-06-22',
        type: 'feature',
        area: 'campaigns',
        title: { tr: 'Zengin E-posta Editörü', en: 'Rich Email Editor' },
        about: {
            tr: 'Kampanya adımlarını artık zengin metin editörüyle yazabilir; kalın, başlık, liste ve link ekleyebilir, gövdede çift süslü parantez yazınca değişken ve spintax önerileri alabilirsiniz.',
            en: 'You can now write campaign steps in a rich text editor with bold, headings, lists and links, and get variable and spintax suggestions by typing double curly braces in the body.',
        },
        usage: {
            tr: 'Adım düzenlerken biçimlendirme araç çubuğunu kullanabilir, Yaz, HTML ve Önizle arasında geçebilir, gövdede çift süslü parantez yazarak açılan listeden değişken ya da spintax seçebilirsiniz.',
            en: 'While editing a step you can use the formatting toolbar, switch between Write, HTML and Preview, and pick a variable or spintax from the list that opens when you type double curly braces in the body.',
        },
    },
    {
        version: '1.12.8',
        date: '2026-06-22',
        type: 'improvement',
        title: { tr: 'Kampanya Ekranları Yenilendi', en: 'Campaign Screens Refreshed' },
        about: {
            tr: 'Kampanya ekranları derli toplu yenilendi: durumu listeden aç kapatabilir, diziyi zaman çizelgesi olarak görebilir ve analizleri zaman serisi ile kutu başına dağılım sayesinde daha ayrıntılı izleyebilirsiniz.',
            en: 'The campaign screens got a tidy refresh: toggle status from the list, see the sequence as a timeline, and follow analytics in more detail with a time series and per-inbox breakdown.',
        },
        usage: {
            tr: 'Listede durum anahtarına tıklayarak kampanyayı başlatıp duraklatabilir, Analiz sekmesinde zaman grafiğini, kutu başına gönderimi ve sekme veya abonelikten çıkma sayılarını görebilirsiniz.',
            en: 'Click the status switch in the list to start or pause a campaign, and on the Analytics tab see the time chart, per-inbox sending and bounce or unsubscribe counts.',
        },
    },
    {
        version: '1.12.7',
        date: '2026-06-22',
        type: 'feature',
        title: { tr: 'Gelişmiş Gönderim Kontrolleri', en: 'Advanced Sending Controls' },
        about: {
            tr: 'Drip kampanyalarda kutu başına günlük limit koyabilir, gönderimleri rastgele aralıklarla daha doğal hale getirebilir, CC adresi ekleyebilir ve açılma/tıklama takibini açıp kapatabilirsiniz.',
            en: 'In drip campaigns you can set a per-inbox daily limit, make sends more natural with random gaps, add CC addresses and toggle open and click tracking.',
        },
        usage: {
            tr: 'Ayarlar sekmesindeki Limitler altından kutu başına limiti ve rastgele gecikmeyi, CC ve Takip bölümlerinden kopya adreslerini ve takip anahtarlarını ayarlayabilirsiniz.',
            en: 'On the Settings tab you can set the per-inbox limit and random delay under Limits, and manage copy addresses and tracking switches in the CC and Tracking sections.',
        },
        notes: {
            tr: 'Bir gönderen kutusu günlük limitini doldurduğunda o kutudan gidecek kişiler ertesi güne ertelenir.',
            en: 'When a sending mailbox reaches its daily limit, contacts assigned to it are deferred to the next day.',
        },
    },
    {
        version: '1.12.6',
        date: '2026-06-22',
        type: 'fix',
        title: { tr: 'Yanıt Hatası Düzeltmesi', en: 'Reply Error Fix' },
        about: {
            tr: 'Bazı kampanya e-postalarında "Yanıtla" işleminin hata vermesi düzeltildi; bu e-postalara artık yanıt gönderebilirsiniz.',
            en: 'Fixed an error when replying to some campaign emails; you can now reply to these messages again.',
        },
    },
    {
        version: '1.12.5',
        date: '2026-06-22',
        type: 'improvement',
        title: { tr: 'Kampanya Kontrolü ve Netlik', en: 'Campaign Control & Clarity' },
        about: {
            tr: 'Drip kampanyalarda kişileri tek tek yönetebilir, başlatmadan önce hazır olup olmadığını görebilir ve liste metriklerini daha derli toplu izleyebilirsiniz.',
            en: 'You can manage contacts one by one in drip campaigns, see whether a campaign is ready before starting it, and follow list metrics in a more compact view.',
        },
        usage: {
            tr: 'Kitle sekmesindeki kişi satırından durdurabilir, sürdürebilir veya çıkarabilir; Başlat butonunun üstüne gelerek eksik kalan adımları görebilirsiniz.',
            en: 'From a contact row on the Audience tab you can pause, resume or remove them, and hovering the Activate button shows what is still missing.',
        },
        notes: {
            tr: 'Açılma ve tıklama takibi yapılandırılmamışsa Analiz sekmesi bunu belirtir ve bu sayılar boş kalabilir.',
            en: 'If open and click tracking is not configured, the Analytics tab now says so and those counts may stay empty.',
        },
    },
    {
        version: '1.12.4',
        date: '2026-06-22',
        type: 'feature',
        title: { tr: 'Kampanya Gönderimi ve Ayarları', en: 'Campaign Sending & Settings' },
        about: {
            tr: 'Drip kampanyalar artık kendi posta kutunuzdan sorunsuz gönderiyor.',
            en: 'Drip campaigns now send reliably from your own mailbox.',
        },
        usage: {
            tr: 'Ayarlar sekmesinden her kutuya gönderen adı verebilir, gece saatlerini de kapsayan gönderim penceresi seçebilir ve kampanyayı yeniden aktive ederek duraklatılan kişileri kaldıkları yerden sürdürebilirsiniz.',
            en: 'In the Settings tab you can set a sender name per mailbox, choose a sending window that spans overnight, and resume paused contacts where they left off by reactivating the campaign.',
        },
    },
    {
        version: '1.12.3',
        date: '2026-06-22',
        type: 'feature',
        title: { tr: 'Test Gönderimi ve Çoklu Kutu', en: 'Test Send & Multiple Inboxes' },
        about: {
            tr: 'Bir adımı kendinize test olarak yollayabilir ve kampanyayı birden çok gönderen kutuya dağıtabilirsiniz.',
            en: 'You can send a step to yourself as a test and spread the campaign across multiple sending inboxes.',
        },
        usage: {
            tr: 'Adım düzenlerken "Test gönder" ile kendinize örnek mail atabilir, Ayarlar sekmesindeki Gönderen Kutular bölümünden birden çok kutu seçebilirsiniz.',
            en: 'While editing a step you can send yourself a sample with "Send test", and pick multiple inboxes under Sending Accounts on the Settings tab.',
        },
        notes: {
            tr: 'Birden çok kutu seçerseniz kişiler kutulara dağıtılır ve her kişiye hep aynı kutudan gidilir; boş bırakırsanız varsayılan kutu kullanılır.',
            en: 'With multiple inboxes, contacts are spread across them and each contact always gets the same inbox; leave it empty to use the default mailbox.',
        },
    },
    {
        version: '1.12.2',
        date: '2026-06-22',
        type: 'feature',
        title: { tr: 'Metin Çeşitleme (Spintax)', en: 'Text Variation (Spintax)' },
        about: {
            tr: 'Kampanya mailinde her gönderimde otomatik olarak farklı kelime ve cümle varyantı kullanabilirsiniz.',
            en: 'Campaign emails can automatically use a different word or phrase variant on each send.',
        },
        usage: {
            tr: 'Adım metnine {{random|Merhaba|Selam|İyi günler}} gibi yazabilir ya da Spintax butonuna tıklayabilirsiniz; sistem her alıcıya seçeneklerden birini rastgele gönderir.',
            en: 'Type something like {{random|Hi|Hello|Good day}} in the step text or click the Spintax button, and each recipient gets one option at random.',
        },
        notes: {
            tr: 'Değişkenleri (ör. {{first_name}}) buton kullanmadan elle de yazabilirsiniz; önizlemede spintax ilk seçenekle gösterilir.',
            en: 'You can also type variables such as {{first_name}} by hand, and the preview shows spintax with the first option.',
        },
    },
    {
        version: '1.12.1',
        date: '2026-06-20',
        type: 'feature',
        title: { tr: 'Gönderim Programı ve Günlük Limit', en: 'Sending Schedule & Daily Limit' },
        about: {
            tr: 'Drip kampanyalarda mailler artık seçtiğiniz gün ve saat aralığında, günlük limiti aşmadan gönderiliyor.',
            en: 'Drip campaign emails now send only within your chosen days and hours, staying under the daily limit.',
        },
        usage: {
            tr: 'Kampanya Ayarlar sekmesinde gönderim günlerini, saat aralığını ve saat dilimini seçip günlük gönderim sayısını sınırlayabilirsiniz.',
            en: 'On the campaign Settings tab you can pick sending days, time range and timezone, and cap how many emails go out per day.',
        },
        notes: {
            tr: 'Pencere dışına denk gelen mailler bir sonraki açılışa, günlük limit dolunca ertesi güne ertelenir.',
            en: 'Emails falling outside the window are deferred to the next opening, and once the daily limit is reached, to the next day.',
        },
    },
    {
        version: '1.12.0',
        date: '2026-06-20',
        type: 'feature',
        title: { tr: 'Drip Kampanya Yenilemesi', en: 'Drip Campaign Overhaul' },
        about: {
            tr: 'Drip kampanyalarda dizi kurma, kişi seçimi ve liste yönetimi yeniden tasarlandı.',
            en: 'Sequence building, contact selection and list management for drip campaigns have been redesigned.',
        },
        usage: {
            tr: 'Diziyi her e-postaya gönderim öncesi bekleme süresi vererek kurabilir, Önizle ile görüp Kitle sekmesinde aşama, sektör ve ülkeye göre filtreleyip eşleşen herkesi tek tıkla kaydedebilirsiniz.',
            en: 'You can build the sequence by giving each email a wait time before sending, check it with Preview, and on the Audience tab filter by stage, industry and country to enroll everyone matching in one click.',
        },
        notes: {
            tr: 'Yeni Ayarlar sekmesindeki gönderim programı ve günlük limit gibi bazı alanlar bir sonraki güncellemede devreye girecek.',
            en: 'Some fields in the new Settings tab such as sending schedule and daily limit will go live in an upcoming update.',
        },
    },
    {
        version: '1.11.0',
        date: '2026-06-20',
        type: 'feature',
        title: { tr: 'Gmail Bağlama ve Mail Araçları', en: 'Gmail Connect & Mail Tools' },
        about: {
            tr: 'Gmail hesabınızı uygulama şifresiyle bağlayabilir, mail bağlantı ayarlarına ve ek/CC yönetimine doğrudan mail sayfasından erişebilirsiniz.',
            en: 'You can connect your Gmail with an app password and reach mailbox settings plus attachment and CC management right from the mail page.',
        },
        usage: {
            tr: '"Yeni Mail" yanındaki ayar butonundan Gmail bağlayabilir, İşlemler menüsündeki "Mail eki ve CC adresi" bölümünden ekleri ve CC adreslerini düzenleyebilirsiniz.',
            en: 'You can connect Gmail from the settings button next to "New Mail" and manage attachments and CC addresses under "Attachments & CC" in the Actions menu.',
        },
        notes: {
            tr: 'Gmail bağlamak için hesabınızda iki adımlı doğrulama açık olmalı ve bir uygulama şifresi oluşturmanız gerekir.',
            en: 'To connect Gmail, two step verification must be on and you need to create an app password.',
        },
    },
    {
        version: '1.10.16',
        date: '2026-06-18',
        type: 'fix',
        title: { tr: 'Okundu İşareti Kalıcı', en: 'Read Mark Sticks' },
        about: {
            tr: 'Bir konuşmayı okundu işaretlediğinizde durum artık geri dönmüyor.',
            en: 'Marking a conversation as read no longer reverts.',
        },
        notes: {
            tr: 'Okundu/okunmadı artık tüm konuşmaya uygulanıyor; çok mesajlı konuşmalarda kısa süre sonra okunmadıya dönme sorunu giderildi.',
            en: 'Read/unread now applies to the whole conversation, fixing multi-message threads that reverted to unread shortly after.',
        },
    },
    {
        version: '1.10.15',
        date: '2026-06-18',
        type: 'fix',
        title: { tr: 'Gelen Mailler Okunmadı Geliyor', en: 'Incoming Mail Arrives as Unread' },
        about: {
            tr: 'Sisteme yeni düşen mailler artık geliş yolundan bağımsız olarak okunmadı görünüyor.',
            en: 'New mail entering the system now appears as unread regardless of how it arrives.',
        },
        notes: {
            tr: 'Önceden içe aktarılan bazı yanıtlar yanlışlıkla okunmuş görünebiliyordu.',
            en: 'Previously some imported replies could mistakenly appear as read.',
        },
    },
    {
        version: '1.10.14',
        date: '2026-06-17',
        type: 'feature',
        title: { tr: 'Notlara Hızlı Erişim ve Şirket/Kişi Geçişi', en: 'Quick Notes Access & Companies/People Switch' },
        about: {
            tr: 'Mail sayfasında şirket notlarını artık liste satırından okuyabilir, Şirketler ile Kişiler görünümleri arasında tek tıkla geçebilirsiniz.',
            en: 'On the mail page you can now read company notes right from the list row, and switch between the Companies and People views in one click.',
        },
        usage: {
            tr: 'Aktivite sayısına tıklayınca o şirketin notları açılır, bir satırı genişlettiğinizde notlar mail geçmişinin altında da listelenir. Şirketler ve Kişiler arasında sayfa başlığındaki düğmeden geçebilirsiniz.',
            en: 'Click the activity count to open that company’s notes, and expand a row to also see them under the mail history. Switch between Companies and People from the toggle in the page header.',
        },
        notes: {
            tr: 'Kampanya atama artık Kampanyalar sayfasındaki Atama sekmesinde yer alıyor.',
            en: 'Campaign assignment now lives in the Assignment tab on the Campaigns page.',
        },
    },
    {
        version: '1.10.13',
        date: '2026-06-16',
        type: 'fix',
        title: { tr: 'Sayaç Görünüm Düzeltmesi', en: 'Counter Display Fix' },
        about: {
            tr: 'Sayfa başlıkları ve sekmelerdeki sayaç rozetlerinin büyük sayıları kırpması düzeltildi.',
            en: 'Fixed counter badges in page titles and tabs clipping large numbers.',
        },
        notes: {
            tr: 'Artık yüzler ve binler de tam görünüyor.',
            en: 'Hundreds and thousands now show in full.',
        },
    },
    {
        version: '1.10.12',
        date: '2026-06-16',
        type: 'feature',
        title: { tr: 'Mail Ekleri Yönetimi ve Yanıt Durumu', en: 'Attachment Library & Reply Status' },
        about: {
            tr: 'Mail eklerini göndermeden yönetebileceğiniz bir kütüphane ile liste satırlarında yanıt durumu göstergeleri geldi.',
            en: 'A library to manage email attachments without sending, plus reply-status indicators on list rows.',
        },
        usage: {
            tr: 'Mail Yanıtları’ndaki İşlemler menüsünden Ekler’i açıp dosya/link kaydedin; bu ekler yeni mail, yanıt ve iletmede seçilebilir hale gelir.',
            en: 'Open Attachments from the Actions menu on Email Replies and save files/links; they become selectable on new mail, reply and forward.',
        },
        notes: {
            tr: 'Ekler artık güvenle iletiliyor (gerçek ek ya da tarayıcıda önizlenebilir link). Satırda saat = sizden yanıt bekliyor, yeşil tik = son söz sizde.',
            en: 'Attachments now arrive reliably (a real attachment or a browser-previewable link). On a row, a clock = awaiting your reply, a green check = you had the last word.',
        },
    },
    {
        version: '1.10.11',
        date: '2026-06-16',
        type: 'feature',
        title: { tr: 'Maillere Doğrudan Dosya Ekleme', en: 'Direct File Attachments in Emails' },
        about: {
            tr: 'Maillere doğrudan dosya ekleme ve yeni mail, yanıt, iletmede aynı çalışan tek tip ek alanı geldi.',
            en: 'Direct file attachments and a unified attachment area that works the same on new mail, reply and forward.',
        },
        usage: {
            tr: 'Dosyayı sürükleyip bırakın ya da link ekleyin; her ek “Dosya” veya “Link” rozetiyle görünür.',
            en: 'Drag and drop a file or add a link; each attachment shows a “File” or “Link” badge.',
        },
        notes: {
            tr: 'Dosya, kanal destekliyorsa gerçek ek, desteklemiyorsa indirme/önizleme linki olarak gider.',
            en: 'A file is delivered as a real attachment when the channel supports it, otherwise as a download/preview link.',
        },
    },
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
