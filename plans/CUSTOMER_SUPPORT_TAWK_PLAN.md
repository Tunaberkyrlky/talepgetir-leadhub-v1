# TG Core Customer Support — Tawk.to + PostHog Planı

**Durum:** MVP kodu tamamlandı; dış servis ve operasyon kurulumu gerekli

**Branch:** `feat/customer-support-tawk-consent`

**Tarih:** 16 Temmuz 2026
**Hedef:** Yıllık 4–6 bin USD ACV seviyesindeki B2B SaaS müşterilerine hızlı, yüksek temaslı ve ölçülebilir destek sunmak.

## 1. Yönetici kararı

İlk 6–12 ay için kendi ticket/chat altyapımızı yazmayacağız. Tawk.to şu işlerin ana sistemi olacak:

- canlı sohbet ve mobil bildirim;
- sohbetten veya e-postadan ticket oluşturma;
- ticket sahibi, durum, not, etiket ve konuşma geçmişi;
- ilk cevap, çözüm süresi, yeniden açılma ve memnuniyet KPI'ları;
- hazır cevaplar ve daha sonra bilgi bankası.

PostHog destek operasyon sistemi olmayacak. PostHog'un görevi ürün bağlamını ölçmek:

- kullanıcı hangi modülde destek penceresini açtı;
- hangi ürün akışından sonra sohbet başladı;
- destek alan kullanıcı ilgili akışı daha sonra tamamlayabildi mi;
- tenant tier/rol/modül bazında destek talebi yoğunluğu.

Bu ayrım, hızlı MVP sağlar ve ticket gerçeğini iki farklı sistemde tutmaktan kaçınır.

## 2. Neden Tawk.to?

16 Temmuz 2026 itibarıyla Tawk.to; canlı sohbet, ticketing, sınırsız agent, geçmiş ve temel raporlamayı ücretsiz sunduğunu belirtiyor. “Remove Branding” eklentisi yıllık **348 USD** veya aylık **39 USD**. 4–6 bin USD ACV ürün için yıllık 348 USD, müşteriye dönük deneyimi kendi markamız altında tutmak adına makul bir maliyettir.

Öneri:

1. İlk iç testte ücretsiz planı kullan.
2. İlk ücretli müşteri öncesinde Remove Branding yıllık paketini al.
3. AI Assist'i ilk gün açma. İlk 50–100 konuşma gerçek soru taksonomisini oluştursun; sonra bilgi bankası verisine göre değerlendir.
4. Tawk.to Hired Agents kullanma; 4–6 bin USD ACV'de ilk temas şirket ekibinden gelmeli.

Resmî kaynaklar:

- Tawk.to fiyatlandırma: https://www.tawk.to/pricing/
- Remove Branding: https://help.tawk.to/article/purchasing-the-remove-branding-and-white-label-add-on
- Raporlama metrikleri: https://help.tawk.to/article/understanding-reporting
- JavaScript API: https://developer.tawk.to/jsapi/
- Webhooks: https://developer.tawk.to/webhooks/
- Tawk.to çerezleri: https://help.tawk.to/article/what-are-tawkto-cookies-and-what-do-they-do
- Tawk.to DPA: https://www.tawk.to/data-protection/dpa-data-processing-addendum/
- PostHog consent kontrolü: https://posthog.com/docs/privacy/data-collection
- PostHog GDPR rehberi: https://posthog.com/docs/privacy/gdpr-compliance

## 3. Uygulanan teknik mimari

### Consent-first yükleme

- Zorunlu, ürün analitiği ve canlı destek ayrı tercihlerdir.
- PostHog SDK fail-closed başlar; `opt_out_capturing_by_default` açıktır.
- Analitik onayı verilince `posthog.opt_in_capturing()` çağrılır.
- Analitik reddedilir veya geri çekilirse event, identify ve session replay gönderilmez.
- Tercih her API isteğine aktarılır; backend route'larının PostHog olayları da aynı izne tabidir.
- Tawk.to script'i destek izni verilmeden DOM'a eklenmez.
- Destek izni geri çekildiğinde widget kapatılır ve erişilebilir Tawk depolaması temizlenir.
- Tercih politika sürümü değişirse kullanıcıdan yeniden seçim istenir.

### Güvenli kullanıcı bağlamı

- Tawk Property ID ve Widget ID public frontend değişkenidir.
- Tawk API key yalnız sunucudadır.
- `/api/support/identity`, giriş yapmış kullanıcının e-postasını Tawk Secure Mode için HMAC-SHA256 ile imzalar.
- Anahtar yoksa widget anonim açılır; istemciye imzasız ad/e-posta gönderilmez.
- Sohbete `tenant-id`, `tenant-name`, `tenant-tier`, `user-role`, `current-module` ve `current-path` bağlamı eklenir.
- Chat başladığında `module-*` ve `tier-*` etiketleri otomatik eklenir.

### PostHog olayları

| Event | Ne zaman | Ana property'ler | Kullanım |
|---|---|---|---|
| `$pageview` | SPA rota değişimi | `path` | Temel ürün navigasyonu |
| `support_widget_loaded` | Tawk hazır | `module`, `path` | Teknik kullanılabilirlik |
| `support_widget_opened` | Kullanıcı widget'ı açtı | `module`, `path` | Destek niyeti |
| `support_chat_started` | İlk mesajla chat başladı | `module`, `path`, `tenant_tier` | Destek talebi |
| `support_agent_joined` | Agent sohbete katıldı | `module` | İstemci tarafı cevap sinyali |
| `support_chat_ended` | Chat bitti | `module` | Chat tamamlanma |
| `support_offline_form_submitted` | Offline form gönderildi | `module`, `supplied_email` | Kaçırılan canlı temas |
| `support_chat_satisfaction` | Puan verildi | `score` | Destek memnuniyeti |

Mesaj içeriği, ticket açıklaması, agent adı ve telefon PostHog'a gönderilmez.

## 4. Dosya ve ortam değişkenleri

Kod kapsamı:

- `client/src/lib/consent.ts`
- `client/src/lib/analytics.ts`
- `client/src/contexts/ConsentContext.tsx`
- `client/src/contexts/TawkSupportContext.tsx`
- `client/src/components/CookieConsent.tsx`
- `client/src/pages/CookiePolicyPage.tsx`
- `server/src/routes/support.ts`
- mevcut App/Auth/Layout/server mount dosyaları

Gerekli değişkenler:

```env
VITE_TAWK_PROPERTY_ID=
VITE_TAWK_WIDGET_ID=
TAWK_API_KEY=

VITE_POSTHOG_KEY=
VITE_POSTHOG_HOST=https://eu.i.posthog.com
POSTHOG_API_KEY=
POSTHOG_HOST=https://eu.i.posthog.com
```

`VITE_TAWK_*` build-time değişkenlerdir. Railway/Vite build öncesinde tanımlanmalıdır. `TAWK_API_KEY` kesinlikle `VITE_` öneki almamalıdır.

## 5. Tawk.to dashboard kurulumu

### Property ve güvenlik

1. TG Core Production ve TG Core Staging için ayrı property oluştur.
2. Administration → Overview'dan Property ID'yi al.
3. Administration → Chat Widget'tan Widget ID'yi al.
4. JavaScript API / Secure Mode'u etkinleştir ve API key'i yalnız server env'e koy.
5. Domain restriction'a production ve staging domainlerini ayrı ayrı ekle.
6. Tawk.to DPA'yı şirket adına kabul et; veri aktarımı/hukuki dayanak kontrolünü tamamla.

### Widget görünümü

- İsim: `TG Core Support`
- Dil: Türkçe; İngilizce müşteriler için ikinci widget veya dil yönlendirmesi rollout sonrasında.
- Renk: mevcut TG Core violet/navy sistemi.
- Pozisyon: sağ alt; uygulamadaki destek düğmesi de aynı widget'ı açar.
- Offline form açık.
- İlk ücretli müşteri öncesinde Remove Branding.
- Varsayılan otomatik “Welcome” trigger'ını kapat veya yalnız 30–45 saniye aktif kullanım sonrası göster; agresif popup kullanma.

Uygulama Tawk script'ini zaten consent sonrasında yüklediği için Tawk'ın kendi consent formunu ikinci kez göstermek zorunlu değildir. Yine de dashboard'daki Avrupa consent ayarı, hukuk danışmanının tercihine göre ek savunma katmanı olarak açılabilir.

### Pre-chat / offline alanları

Müşteri zaten giriş yaptığı için ad ve e-posta Secure Mode ile gelir. Hemen telefonla dönüş hedefi için aşağıdakileri iste:

- Telefon: E.164 formatında (`+90...`), zorunlu;
- Aranmak istiyorum: Evet/Hayır;
- Aciliyet: İş durdu / İş etkileniyor / Soru;
- Kısa konu: serbest metin.

Pre-chat form mevcut widget deneyiminde fazla sürtünme yaratırsa telefon bilgisini ilk agent mesajındaki hazır cevapla iste. Şifre veya müşteri verisi isteme.

### Bildirim ve çalışma saatleri

- Kurucu/support owner masaüstü ve mobil Tawk.to uygulamasını kurar.
- Push, e-posta ve kaçırılan chat bildirimi açık olmalı.
- İlk aşamada iki agent: birincil owner + yedek owner.
- Scheduler gerçek cevap saatlerini göstermeli; 7/24 izlenimi verilmemeli.
- Online saatlerde hedef ilk cevap 2 dakika, telefon araması 5 dakika.
- Offline talepte hedef ilk insan yanıtı bir sonraki iş saatinde 30 dakika.

## 6. Destek iş akışı

1. **Chat gelir:** Agent 2 dakika içinde selamlar ve etkilenmeyi doğrular.
2. **Telefon kararı:** “İş durdu” veya kullanıcı arama istiyorsa telefon numarası doğrulanır ve 5 dakika içinde aranır.
3. **Ticket:** Çözüm chat sırasında bitmiyorsa sohbetten ticket açılır.
4. **Not:** Ticket'a beklenen/gerçek davranış, tekrar adımları, etkilenen modül, etki ve geçici çözüm yazılır.
5. **Etiket:** En az `module-*`, `issue-*`, `severity-*` ve gerekiyorsa `rootcause-*` eklenir.
6. **Owner/SLA:** Tek owner atanır; sonraki güncelleme zamanı müşteriye yazılır.
7. **Çözüm:** Çözüm ve doğrulama adımı ticket'ta belirtilir; müşteri teyidi alınır.
8. **Kapatma:** Çözüm sonrası ticket `Solved`; aynı sorun dönerse `Reopened`, yeni sorun ise yeni ticket.
9. **Ürün geri besleme:** Tekrarlayan `issue-*` etiketleri haftalık ürün toplantısına girer.

### Hazır cevaplar

`/hello`

> Merhaba, ben {{agent}}. Hemen ilgileniyorum. Bu sorun şu an işinizi tamamen durduruyor mu?

`/call`

> Sizi hemen arayabiliriz. Aranmak istediğiniz ülke koduyla birlikte telefon numaranızı ve uygun olduğunuzu teyit eder misiniz?

`/ticket`

> Konuyu takipten düşürmemek için ticket'a çevirdim. Referansınız: {{ticket}}. Bir sonraki güncellemeyi en geç {{time}} paylaşacağız.

`/sensitive`

> Güvenliğiniz için lütfen sohbet üzerinden şifre, API anahtarı veya müşteri listenizi paylaşmayın.

## 7. Etiket taksonomisi

Etiketler kısa, İngilizce, küçük harf ve tireli olmalı. Serbest etiket açmayı yalnız support owner yapmalı.

### Modül

- `module-dashboard`
- `module-companies`
- `module-pipeline`
- `module-tasks`
- `module-assets`
- `module-research`
- `module-cold-call`
- `module-linkedin`
- `module-campaigns`
- `module-auth`
- `module-billing`

İlk modül etiketi kod tarafından otomatik eklenir; agent gerekirse asıl etkilenen modülle düzeltir.

### Sorun tipi

- `issue-how-to`
- `issue-bug`
- `issue-data-quality`
- `issue-integration`
- `issue-permission`
- `issue-performance`
- `issue-billing`
- `issue-feature-request`

### Şiddet

- `severity-s1`: üretim/iş akışı durdu, geçici çözüm yok;
- `severity-s2`: ana iş akışı ciddi etkilendi, sınırlı workaround;
- `severity-s3`: sınırlı etki veya workaround var;
- `severity-s4`: soru/öneri.

### Kök neden

- `rootcause-product`
- `rootcause-config`
- `rootcause-user-education`
- `rootcause-third-party`
- `rootcause-data`
- `rootcause-unknown`

“En çok sorun yaşanan yerler” raporu haftalık olarak `module-* × issue-*`, aylık olarak `rootcause-*` dağılımından çıkarılır.

## 8. KPI ve hedefler

İlk 90 gün için az hacimli B2B gerçekliğine uygun hedefler:

| KPI | Tanım | İlk hedef | Kaynak |
|---|---|---:|---|
| First response time | İlk müşteri mesajı → ilk agent cevabı | online p50 < 2 dk, p90 < 5 dk | Tawk Live Chat |
| Callback time | Arama talebi → telefon araması | p90 < 5 dk (online) | Ticket notu/telefon logu |
| Missed chat rate | Cevapsız chat / toplam chat | < %5 online | Tawk Live Chat |
| Ticket first response | Ticket açılışı → ilk insan yanıtı | p90 < 30 dk iş saatinde | Tawk Tickets |
| Resolution time | Ticket açılışı → solved | S1 < 4 saat, S2 < 1 iş günü | Tawk Tickets |
| Reopen rate | Reopened / solved | < %10 | Tawk Tickets |
| CSAT | Pozitif oy / toplam oy | > %90; en az 20 cevap olmadan trend sayma | Tawk Satisfaction |
| Support contact rate | Chat başlayan aktif tenant / aktif tenant | trend; hedef koymadan önce 8 hafta baseline | PostHog |
| Repeat issue rate | Aynı tenant + aynı issue, 30 günde tekrar | düşen trend | Tawk export |

Sadece ortalama kullanma; p50 ve p90 birlikte takip edilmelidir. Düşük hacimde tek bir ticket ortalamayı bozar.

## 9. PostHog kurulum rehberi

### Önce yapılacaklar

1. PostHog Cloud EU projesi kullanıldığını doğrula (`https://eu.i.posthog.com`).
2. Project Settings'te IP capture'ı kapat.
3. Session replay için tüm input ve ekran metni maskelemesini koru.
4. Production ve staging ayrımı için environment/build property eklenmesi sonraki küçük iyileştirmedir.
5. Takım erişimini en az yetkiyle sınırla; public dashboard linki oluşturma.

### İlk dashboard: “Support Health”

- Trend: `support_chat_started`, günlük/haftalık.
- Breakdown: `module`.
- Breakdown: `tenant_tier`.
- Funnel: `support_widget_opened → support_chat_started → support_agent_joined → support_chat_ended`.
- Trend: `support_offline_form_submitted`.
- Trend: `support_chat_satisfaction`, score breakdown.
- Cohort: son 30 günde destek alan kullanıcılar.

### Ürün sürtünmesi analizi

Her ana modül için bir başarı olayı tanımlanmadan PostHog “aktif” sayılmaz. Örnek:

- Research: `research_run_completed`
- Cold Call: `cold_call_completed`
- Campaign: `campaign_activated`
- Pipeline: `deal_stage_changed`
- Import: `import_completed`

Sonra şu funnel kurulmalı:

`module entered → primary action attempted → support_chat_started → primary action completed within 24h`

Bu funnel, destek ekibinin gerçekten müşteriyi sonuca götürüp götürmediğini gösterir. Ticket kapatma KPI'sı yerine geçmez.

## 10. Hukuk ve gizlilik checklist'i

Kod consent mekanizmasını sağlar; hukuki uygunluğu tek başına garanti etmez.

- Şirketin tam ticari unvanı ve veri sorumlusu iletişimi politika metnine eklenmeli.
- KVKK aydınlatma metni ve gerekiyorsa GDPR privacy notice ile çapraz referans verilmeli.
- Tawk.to ve PostHog DPA'ları imzalanmalı/kabul edilmeli.
- Uluslararası aktarım mekanizması hukuk danışmanıyla doğrulanmalı.
- PostHog ve Tawk.to retention süreleri dashboard'da belirlenip politikaya kesin yazılmalı.
- Çalışanlar destek konuşmalarındaki kişisel/ticari veriye erişim ve silme prosedürü konusunda eğitilmeli.
- Veri sahibi talebinde PostHog kişi silme ve Tawk.to contact/ticket silme runbook'u hazırlanmalı.
- Consent kanıtı şu an cihazdaki sürümlü localStorage kaydıdır. Regülatif gereksinim merkezi kanıt istiyorsa ileride authenticated consent audit tablosu eklenmeli.
- Yayındaki Çerez Politikası sayfasındaki sarı “hukuk incelemesi” notu legal onay sonrası kaldırılmalı.

## 11. Rollout

### Gün 0 — dış servis kurulumu

- Production/staging property oluştur.
- Secure Mode ve domain restriction aç.
- Env değişkenlerini Railway'e gir.
- İki agent ekle; mobil uygulamaları ve push bildirimlerini doğrula.
- Widget rengi/dili, offline form ve scheduler ayarla.
- Etiketleri ve dört hazır cevabı oluştur.

### Gün 1 — staging kabul testi

- Yeni tarayıcıda seçim yapmadan PostHog capture/event isteği ve hiçbir Tawk isteği olmadığını doğrula (PostHog SDK uygulama paketinde yüklenir ancak capture kapalıdır).
- Yalnız analitiği kabul et: PostHog event var, Tawk script yok.
- Yalnız desteği kabul et: Tawk var, PostHog capture yok.
- İkisini kabul et: kullanıcı adı/e-posta doğru ve tenant/modül context'i agent panelinde.
- Tercihi geri çek: widget kapanıyor ve yeni event/script oluşmuyor.
- Chat, offline form, mobil push, ticket dönüşümü ve e-posta yanıtını test et.
- Türkçe/İngilizce çerez politikası ve mobil banner görünümünü kontrol et.

### İlk 2 hafta

- Her ticket'ta module/issue/severity/rootcause etiket zorunluluğu.
- Günlük 10 dakikalık açık ticket kontrolü.
- Haftalık: en çok temas alan üç modül ve üç issue.
- Eksik ürün event'lerini PostHog'a ekle; autocapture'a güvenme.

### 30–60 gün

- Remove Branding'i etkinleştir.
- İlk SLA ve tag raporunu gözden geçir.
- Sık gelen 10 soru için bilgi bankası yaz.
- Hacim yeterliyse webhook/REST API ile salt okunur destek veri ambarı düşün. Tawk webhook'ları chat start/end, transcript ve ticket create verir; ticket close değişimini doğrudan vermediği için erken aşamada kendi KPI veritabanını bunun üzerine kurma.

## 12. Kabul kriterleri

- [x] Ayrı feature branch oluşturuldu.
- [x] PostHog consent olmadan capture etmiyor.
- [x] Tawk.to consent olmadan yüklenmiyor.
- [x] Kullanıcı kimliği Secure Mode ile sunucuda imzalanıyor.
- [x] Tenant, rol, tier, modül ve sayfa desteğe context olarak aktarılıyor.
- [x] Destek olayları, analitik izni varsa PostHog'a gidiyor.
- [x] Tercihler sonradan değiştirilebiliyor.
- [x] İki dilli çerez politikası uygulama içinde erişilebilir.
- [x] Client ve server production build başarılı.
- [ ] Tawk.to dashboard/property kurulumu tamamlandı.
- [ ] Railway production/staging env değerleri girildi.
- [ ] Hukuk incelemesi ve DPA/retention kararları tamamlandı.
- [ ] Gerçek mobil push + telefon callback operasyon testi tamamlandı.
