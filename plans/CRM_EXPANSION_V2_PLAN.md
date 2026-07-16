# Tibexa Core CRM Expansion v2

**Durum:** Aktif, kanonik ürün ve uygulama planı
**Oluşturulma:** 2026-07-10
**Kapsam:** Yalnız CRM fonksiyonları ve kullanıcı deneyimi
**Kapsam dışı:** Güvenlik sertleştirmesi, altyapı, performans optimizasyonu, fiyatlandırma, TG-Research ve outreach motorlarının kendi iç akışları
**Önceki plan:** `plans/CRM_EXPANSION_PLAN.md` tarihsel kayıttır; mevcut uygulama durumunu yansıtmadığı için bu dosya onun yerini alır.

---

Salih Notar:

Bu sadece ihracat için kullanılacak bir CRM değil, lead generation için de kullanılır.

Cold email veya reklam veya youtube inbound'dan gelen leadler için

Takvim entegrasyonu, [cal.com](http://cal.com) gibi bir randevulama motoru ile SMS + whatsapp + email drip campaign

## 1. Yönetici özeti

Tibexa Core bugün çalışan bir **lead yönetimi ve outreach CRM omurgasına** sahiptir:

- Şirket ve kişi kayıtları
- Özelleştirilebilir stage yapısı
- Kanban, tablo ve sonuçlanan lead görünümleri
- Not, toplantı, takip, stage değişimi ve kapanış raporu aktiviteleri
- E-posta yanıtı, kampanya e-postası ve cold-call bağlantıları
- Aktivite zaman çizelgesi ve ajanda
- Dashboard, stage dağılımı ve pipeline hunisi

Ana ürün boşluğu yeni bir dashboard veya daha fazla profil alanı değildir. Eksik olan, satış ekibinin günlük çalışmasını yöneten şu döngüdür:

> **Ne oldu? → Sonuç ne? → Sıradaki iş ne? → Kim yapacak? → Ne zaman? → Tamamlandı mı?**

Mevcut `activities` yapısı hem geçmiş olayları hem gelecekte yapılacak işleri temsil etmeye çalışır. Bunun sonucu:

- Notlar ve sistem kayıtları ajandaya karışabilir.
- Takiplerin bekliyor/tamamlandı/iptal durumu yoktur.
- Gecikmiş iş kavramı güvenilir değildir.
- Sorumluluk ve “benim işlerim” görünümü yoktur.
- `companies.next_step` ile `follow_up` aktivitesi iki ayrı doğruluk kaynağıdır.

Bu planın ilk hedefi CRM'i kayıt arşivinden günlük çalışma sistemine dönüştürmektir. İlk üç yatırım sırası:

1. **Görev ve sonraki aksiyon modeli**
2. **Firma/görev sahipliği ve kişisel iş kuyruğu**
3. **Birleşik etkileşim zaman çizelgesi**

Deal/fırsat nesnesi, gelişmiş forecast ve kapsamlı satış analitiği bu operasyonel çekirdek oturduktan sonra gelir.

---

## 2. Mevcut durum değerlendirmesi


| Alan             | Mevcut durum                                           | Olgunluk | Temel boşluk                                               |
| ---------------- | ------------------------------------------------------ | --------: | ---------------------------------------------------------- |
| Şirket kaydı     | Firma, iletişim, sektör, ürün, fit score, özel alanlar | İyi      | Sahiplik, kaynak, etiket ve öncelik eksik                  |
| Kişi kaydı       | Firma bağlantısı, unvan, kıdem, iletişim, primary kişi | Orta     | Satın alma rolü, durum ve çoklu ilişki eksik               |
| Pipeline         | Kanban, tablo, sonuçlar, stage yaşı, drag-drop         | İyi      | Sahip, sonraki görev, son temas ve değer görünmüyor        |
| Stage yönetimi   | Tenant bazlı stage ve grup yapılandırması              | İyi      | Geçiş kriterleri ve yüzeyler arası tutarlılık eksik        |
| Aktivite geçmişi | Not, toplantı, takip, kapanış, e-posta, arama          | Orta     | Geçmiş olay ile gelecekteki iş birbirine karışıyor         |
| Ajanda           | Tarihe göre gruplayan görünüm ve dashboard widget'ı    | Zayıf    | Görev durumu olmadığından gecikme semantiği bozuk          |
| Sahiplik         | `companies.assigned_to` alanı mevcut                   | Zayıf    | Atama, gösterim, filtre ve takım iş akışı yok              |
| Next step        | Serbest metin `companies.next_step`                    | Zayıf    | Tarih/sorumlu/durum yok; follow-up ile bağlantısız         |
| Kanal geçmişi    | E-posta ve cold call kısmen activity'ye yazılıyor      | Orta     | Filtreler, LinkedIn ve gelen/giden iletişim tek akış değil |
| Kapanış          | Terminal stage + kapanış raporu                        | Orta     | Bazı stage değiştirme yüzeyleri raporu atlayabiliyor       |
| Raporlama        | Temel funnel, conversion ve stage dağılımı             | Orta     | Aktivite sonucu, hız, sahip performansı ve forecast eksik  |
| Veri düzeni UX'i | Arama, filtre, kolon yönetimi ve bulk stage var        | Orta     | Birleştirme, arşivleme, etiket ve kayıtlı görünüm eksik    |


### 2.1 Güçlü yönler

- Şirketi merkez alan B2B bilgi mimarisi mevcut ürün için anlaşılırdır.
- Firma detayında kişi, aktivite ve e-posta bağlamı bir aradadır.
- Pipeline kartları stage'de geçen günü göstererek bekleyen kayıtları görünür kılar.
- Terminal stage'ler için kapanış raporu fikri doğrudur.
- Pipeline stage'lerinin tenant bazlı yapılandırılabilmesi büyüme için iyi temeldir.
- Cold call ve kampanya e-postalarının activity üretmesi birleşik timeline için altyapı sağlar.
- Liste ve pipeline üzerinde geri alma, arama, sıralama ve bulk aksiyonları vardır.

### 2.2 Kritik deneyim problemleri

1. **Activity ve task ayrımı yoktur.**
2. **Firma ve iş sahipliği görünür değildir.**
3. **Next step iki farklı yerde tutulur.**
4. **Ajanda yalnız planlanan işleri göstermemektedir.**
5. **Stage değişimi kullanılan yüzeye göre farklı davranabilir.**
6. **Kanal geçmişi tek timeline'da tam birleşmemiştir.**
7. **Şirket aynı zamanda opportunity olarak kullanılmaktadır.**
8. **Pipeline günlük karar vermek için gereken bilgileri kart üzerinde göstermez.**

---

## 3. Ürün kararları

### K1 — Activity ve task ayrı nesnelerdir

**Activity**, gerçekleşmiş bir olaydır:

- Not eklendi
- Telefon görüşmesi yapıldı
- E-posta gönderildi/alındı
- Toplantı gerçekleşti
- Stage değişti
- Firma kapatıldı veya yeniden açıldı

**Task**, gelecekte yapılacak iştir:

- Takip araması yap
- Teklif gönder
- Toplantı ayarla
- Sözleşmeyi kontrol et
- Belirli bir kişiden yanıt bekle

Activity geçmişi kronolojiktir. Task iş kuyruğudur. Bir task tamamlandığında isteğe bağlı sonuç activity'si oluşturulur.

### K2 — Tek kanonik “sonraki aksiyon” task üzerinden hesaplanır

`companies.next_step` yeni doğruluk kaynağı olmayacaktır. Bir şirketin sonraki aksiyonu:

- `status = pending`
- en erken `due_at`
- ilgili şirkete bağlı

task kaydıdır. Geçiş döneminde eski `next_step` okunmaya devam eder; yeni task oluşturulduğunda UI task'ı öncelikli gösterir.

### K3 — Sahiplik iki seviyelidir

- **Firma/deal sahibi:** Ticari ilişkinin ana sorumlusu
- **Task sahibi:** Belirli işi yapacak kişi

İkisi varsayılan olarak aynı olabilir fakat bağımsız değiştirilebilir.

### K4 — Pipeline günlük çalışma yüzeyidir

Pipeline kartı yalnız sınıflandırma göstermemeli; kullanıcıya karar verdirmelidir. Kart üzerinde minimum:

- Firma adı
- Sahip
- Stage yaşı
- Son temas yaşı
- Sonraki task ve tarihi
- Gecikme durumu
- Kişi sayısı

Deal modeli geldikten sonra değer ve tahmini kapanış tarihi de eklenir.

### K5 — Stage değişikliği tek servis ve tek UX sözleşmesinden geçer

Kanban, liste, firma başlığı ve düzenleme formu aynı stage transition akışını kullanır:

- Normal stage: doğrudan geçiş + activity
- Terminal stage: kapanış raporu
- Kapalı kaydı açma: yeniden açma nedeni
- Stage'e özel zorunlu alan varsa inline transition paneli

### K6 — Şirket ve deal ayrımı kademeli yapılır

İlk sürüm mevcut “bir şirket = bir aktif satış süreci” varsayımını bozmaz. Deal nesnesi Phase 5'te eklenir. Görev ve timeline nesneleri baştan `company_id` yanında gelecekte `deal_id` destekleyebilecek şekilde tasarlanır.

### K7 — Birleşik timeline tek okuma yüzeyidir

Kullanıcının firma geçmişini anlamak için sekmeler arasında dolaşması gerekmemelidir. Timeline şu kaynakları tek kronolojide gösterir:

- Manuel notlar
- Task oluşturma/tamamlama sonucu
- Toplantılar
- Cold call sonuçları
- Gelen ve giden e-postalar
- Kampanya e-postaları
- LinkedIn aksiyonları
- Stage ve sahip değişiklikleri
- Kapanış/yeniden açılma

Kanalın kendi detay ekranı korunabilir; timeline özet ve geçiş noktasıdır.

---

## 4. Hedef bilgi mimarisi

```text
CRM
├── Bugün / İşlerim
│   ├── Gecikmiş
│   ├── Bugün
│   ├── Yaklaşan
│   └── Tamamlananlar
├── Şirketler
│   ├── Kayıtlı görünümler
│   ├── Firma detayı
│   │   ├── Özet
│   │   ├── Sonraki aksiyon
│   │   ├── Timeline
│   │   ├── Kişiler
│   │   └── Fırsatlar (Phase 5)
│   └── Birleştirme / arşiv
├── Kişiler
├── Pipeline
│   ├── Kanban
│   ├── Tablo
│   ├── Sonuçlar
│   └── Kayıtlı görünümler
├── Aktiviteler
│   ├── Birleşik geçmiş
│   └── Analiz
└── Ayarlar
    ├── Stage ve geçiş kuralları
    ├── Kayıp nedenleri
    ├── Etiketler
    └── Görev varsayılanları
```

---

## 5. Hedef nesne modeli

### 5.1 Task


| Alan                       | Amaç                                      |
| -------------------------- | ----------------------------------------- |
| `id`                       | Kimlik                                    |
| `tenant_id`                | Tenant sınırı                             |
| `company_id`               | Zorunlu firma bağlantısı                  |
| `contact_id`               | İsteğe bağlı kişi bağlantısı              |
| `deal_id`                  | Phase 5'te isteğe bağlı fırsat bağlantısı |
| `title`                    | Yapılacak iş                              |
| `detail`                   | Bağlam ve talimat                         |
| `status`                   | `pending`, `completed`, `cancelled`       |
| `priority`                 | `low`, `normal`, `high`                   |
| `due_at`                   | Son tarih/saat                            |
| `assigned_to`              | Task sahibi                               |
| `completed_at`             | Tamamlanma zamanı                         |
| `completed_by`             | Tamamlayan kişi                           |
| `created_by`               | Oluşturan kişi                            |
| `created_at`, `updated_at` | Zamanlar                                  |


İleri faz alanları: reminder, recurrence, task type, completion outcome, snoozed_until.

### 5.2 Company ownership

Mevcut `companies.assigned_to` korunur ve ürünleştirilir:

- Firma formu ve detayında kullanıcı seçimi
- Pipeline kartında avatar/isim
- Liste ve pipeline filtreleri
- Bulk assign
- Sahipsiz kayıt görünümü
- Değişiklik timeline activity'si

### 5.3 Deal — Phase 5


| Alan                    | Amaç                      |
| ----------------------- | ------------------------- |
| `company_id`            | Account bağlantısı        |
| `name`                  | Fırsat adı                |
| `pipeline_id` / `stage` | Satış akışı               |
| `owner_id`              | Deal sahibi               |
| `amount`, `currency`    | Ticari değer              |
| `probability`           | Tahmini kazanma olasılığı |
| `expected_close_at`     | Tahmini kapanış           |
| `product_services`      | Kapsam                    |
| `source`                | Kaynak                    |
| `priority`              | Öncelik                   |
| `won_lost_reason`       | Sonuç nedeni              |


---

## 6. Faz planı

## Phase 0 — Semantik düzeltmeler ve güven kazanımı

**Hedef:** Mevcut ekranların yanlış yönlendirdiği durumları yeni veri modeli beklemeden düzeltmek.

### Değişiklikler

- Ajanda görünümünde yalnız planlanmış iş türlerini göster.
- Notları ve sistem aktivitelerini “gecikmiş” olarak sınıflandırma.
- Dashboard yaklaşan aktivitelerinden notları çıkar.
- Cold call activity türünü type, ikon, renk, filtre ve istatistiklerde birinci sınıf yap.
- Firma başlığı stage menüsünü terminal stage kapanış akışına bağla.
- Aktivite detay alanını çok satırlı hale getir.
- Aktivite düzenleme menüsündeki yinelenen etiketi düzelt.
- Aktiviteler sayfasına firma seçerek global kayıt oluşturma aksiyonu ekle.

### Kabul kriterleri

- Bir not ajandada gecikmiş görünmez.
- Geçmiş bir stage değişikliği dashboard yaklaşan işler kartına girmez.
- Terminal stage, hangi ekrandan seçilirse seçilsin kapanış raporu ister.
- Cold call kaydı timeline'da doğru etiket, ikon ve renkle görünür.

---

## Phase 1 — Tasks ve kanonik sonraki aksiyon

**Hedef:** “Kim, neyi, ne zaman yapacak?” sorusunu ürünün merkezine almak.

### Backend ve veri

- `tasks` tablosu ve indeksleri
- Firma/kişi scoped task listeleme
- Kişisel iş kuyruğu sorguları
- Oluşturma, düzenleme, tamamlama, iptal ve silme endpoint'leri
- Tamamlama sırasında isteğe bağlı sonuç activity'si
- Pending task'tan kanonik sonraki aksiyon hesaplama

### Firma detayı

- Üst özet alanında “Sonraki aksiyon” paneli
- Hızlı task ekleme
- Tamamla ve ertele aksiyonları
- Gecikmiş/b bugün/yaklaşan görsel durumları
- Kişi bağlantısı
- Task yoksa yönlendirici empty state

### İşlerim sayfası

- Gecikmiş, bugün, yaklaşan, tamamlanan sekmeleri
- Bana atanan / oluşturduğum / tüm takım filtreleri
- Firma, kişi, öncelik ve sahip filtresi
- Inline tamamla, ertele ve yeniden ata
- Global hızlı task oluşturma

### Geçiş

- `follow_up` activity oluşturma bir süre daha desteklenir.
- Yeni UI takip için task oluşturmayı varsayılan yapar.
- Mevcut `companies.next_step` salt okunur fallback olarak gösterilir.
- Eski follow-up kayıtları otomatik migrate edilmez; kullanıcı geçmişi korunur.

### Kabul kriterleri

- Task bekliyor, tamamlandı veya iptal durumuna sahiptir.
- Tamamlanmış task gecikmiş görünmez.
- Bir şirketin sonraki aksiyonu deterministik biçimde hesaplanır.
- Kullanıcı firma detayından ayrılmadan task oluşturup tamamlayabilir.
- Task tamamlanınca kullanıcıya yeni sonraki aksiyon önerilir.

---

## Phase 2 — Sahiplik ve takım çalışma modeli

**Hedef:** Firma ve iş sorumluluğunu görünür, filtrelenebilir ve devredilebilir yapmak.

### Değişiklikler

- Tenant üyeleri için CRM kullanıcı seçici endpoint'i
- Firma oluşturma/düzenleme formunda sahip
- Firma detay başlığında sahip
- Pipeline kartında sahip
- “Benim leadlerim”, “sahipsiz”, takım üyesi filtreleri
- Toplu firma sahibi atama
- Task sahibi seçme ve toplu yeniden atama
- Sahip değişikliklerini timeline'a yazma
- Kullanıcı pasif olduğunda devretme akışı

### Kabul kriterleri

- Ham UUID hiçbir müşteri yüzeyinde gösterilmez.
- Her firma ve task için sahip adı görünür.
- Kullanıcı tek tıkla yalnız kendi işlerini görebilir.
- Sahipsiz kayıtlar ayrı bir operasyon kuyruğunda bulunur.

---

## Phase 3 — Birleşik timeline ve iletişim sonuçları

**Hedef:** Firma geçmişini tek kronolojik akışta anlaşılır hale getirmek.

### Değişiklikler

- Timeline event sunum sözleşmesi
- Manuel note, task, call, email, LinkedIn ve sistem olayları için ortak kart modeli
- Gelen ve giden e-postaların timeline özeti
- Cold-call duration, disposition, not ve kayıt bağlantısı
- LinkedIn invite/message/reply olaylarının timeline özeti
- Kanal, kullanıcı, kişi ve tarih filtreleri
- “Sadece önemli” ve sabitlenmiş not görünümü
- Yeni olaydan sonra “sonraki task oluştur” önerisi
- Timeline item deep-link ile kaynak detayını açma

### Kabul kriterleri

- Son temas tarihi bütün desteklenen kanallardan hesaplanır.
- Kullanıcı iletişim geçmişini anlamak için e-posta/call/LinkedIn modüllerine gitmek zorunda değildir.
- Sistem olayları ve insan iletişimleri görsel olarak ayrılır.
- Timeline filtresi kullanıcı seçimini URL'de korur.

---

## Phase 4 — Pipeline çalışma yüzeyi

**Hedef:** Pipeline'ı yalnız stage panosu değil, günlük karar ve önceliklendirme yüzeyi yapmak.

### Kart içeriği

- Sahip
- Sonraki task ve due date
- Gecikmiş task işareti
- Son temas yaşı
- Stage yaşı
- Öncelik
- Etiketler
- Kişi sayısı

### Filtreler ve görünümler

- Bana ait
- Sahipsiz
- Gecikmiş görevi olan
- Task'ı olmayan
- Son X gündür temas edilmeyen
- Stage yaşı eşiği
- Kaynak, etiket, öncelik
- Kayıtlı kişisel görünüm
- Paylaşılan takım görünümü

### Stage davranışı

- Tek transition servisi
- Stage açıklaması ve hedefi
- Stage giriş/çıkış kriterleri
- Stage'e özel zorunlu alanlar
- Hedef süre ve gecikme uyarısı
- Askı nedeni
- Açık “yeniden aç” aksiyonu

### Kabul kriterleri

- Kullanıcı pipeline'dan ayrılmadan en riskli leadleri bulabilir.
- Kartlar okunabilirliği bozmadan çalışma sinyallerini gösterir.
- Kayıtlı görünüm filtre, sıralama ve görünüm tipini geri yükler.

---

## Phase 5 — Deal/fırsat nesnesi

**Hedef:** Bir şirketin birden fazla ticari fırsatını ayrı yönetmek.

### Ön koşul karar kapısı

Deal modeli şu koşullardan en az biri doğrulanınca açılır:

- Aynı şirket için birden fazla eş zamanlı satış süreci ihtiyacı
- Yenileme/upsell takibi
- Ürün veya ülke bazlı ayrı pipeline ihtiyacı
- Finansal forecast beklentisi

### Değişiklikler

- Deal CRUD ve firma bağlantısı
- Birden çok pipeline desteği
- Deal sahibi, değer, para birimi ve beklenen kapanış
- Deal-person ilişki rolleri
- Deal scoped tasks ve timeline
- Company stage için compatibility görünümü
- Eski şirket stage'lerinden ilk deal oluşturma sihirbazı

### Kabul kriterleri

- Aynı firmada iki aktif deal birbirinden bağımsız stage ve task taşıyabilir.
- Firma görünümü bütün deal'leri özetler.
- Pipeline yalnız deal nesnelerini gösterir.

---

## Phase 6 — İlişki ve qualification zekâsı

**Hedef:** Satış bağlamını serbest metinden eyleme dönüştürülebilir alanlara taşımak.

### Firma/deal alanları

- Lead source
- Öncelik
- Etiketler
- Qualification durumu
- Yapılandırılmış fit score
- Kayıp nedeni taksonomisi
- Rakip ve itiraz notları

### Kişi alanları

- Satın alma rolü: decision maker, influencer, champion, user, blocker
- İlişki durumu
- Aktif/pasif/firmadan ayrıldı
- Tercih edilen iletişim kanalı
- Son temas ve sonraki task

### Kabul kriterleri

- Kullanıcı satın alma komitesindeki boşluğu görebilir.
- Kayıp nedenleri raporlanabilir standart değerlerdir.
- Etiketler liste ve pipeline filtrelerinde çalışır.

---

## Phase 7 — Satış analitiği ve forecast

**Hedef:** Dashboard'u sayım ekranından karar destek ekranına taşımak.

### Operasyon metrikleri

- Açık/gecikmiş task sayısı
- Task tamamlama oranı
- İlk temas süresi
- Son temas yaşı
- Stage'de kalma süresi
- Stage velocity
- Sahip bazlı aktif iş yükü

### Satış metrikleri

- Stage conversion
- Win/loss oranı ve nedenleri
- Kaynağa göre dönüşüm
- Ortalama satış döngüsü
- Pipeline değeri
- Ağırlıklı forecast
- Beklenen kapanış takvimi

### Kabul kriterleri

- Metriklerin tarih ve cohort anlamı ekranda açıklanır.
- Grafik tıklamaları ilgili filtreli liste/pipeline görünümünü açar.
- Forecast yalnız deal veri kalitesi yeterliyse gösterilir.

---

## Phase 8 — Veri düzeni ve ölçeklenebilir kullanım UX'i

**Hedef:** Büyüyen CRM'in aranabilir, temiz ve sürdürülebilir kalması.

### Değişiklikler

- Mükerrer firma/kişi uyarısı
- Birleştirme sihirbazı ve alan bazlı kazanan değer seçimi
- Silmek yerine arşivleme
- Arşivden geri alma
- Bulk edit ve bulk task oluşturma
- CSV export'ta görünüm/filtre korunması
- Kayıtlı görünümler ve paylaşım
- Son kullanılanlar ve favoriler
- Global hızlı oluşturma/komut menüsü

### Kabul kriterleri

- Birleştirme işleminden önce kullanıcı hangi alanın korunacağını görür.
- Arşivlenen kayıtlar varsayılan görünümlerden çıkar fakat geri alınabilir.
- Bulk aksiyonlar etkilenecek kayıt sayısını açıkça gösterir.

---

## 7. Sürümleme ve uygulama sırası


| Release                  | İçerik                                                   | Kullanıcı sonucu                                      |
| ------------------------ | -------------------------------------------------------- | ----------------------------------------------------- |
| R1 — Work foundation     | Phase 0 + Phase 1 temel task modeli ve firma next action | Takipler tamamlanabilir ve gecikme anlamlı hale gelir |
| R2 — My work             | Phase 1 İşlerim + Phase 2 sahiplik                       | Her kullanıcı kendi gününü ve leadlerini yönetir      |
| R3 — Context             | Phase 3 birleşik timeline                                | Firma geçmişi tek yerde anlaşılır                     |
| R4 — Pipeline operations | Phase 4 kartlar, filtreler, kayıtlı görünümler           | Pipeline günlük yönetim yüzeyine dönüşür              |
| R5 — Revenue model       | Phase 5 karar kapısı ve gerekirse deal                   | Çoklu fırsat ve forecast mümkün olur                  |
| R6 — Intelligence        | Phase 6–8                                                | Qualification, analitik ve veri düzeni olgunlaşır     |


### R1 uygulama dilimleri

1. Task migration ve API
2. Firma detayında next-action paneli
3. Task tamamla/iptal akışı
4. Ajanda semantik düzeltmesi
5. Dashboard yaklaşan işler düzeltmesi
6. Global task oluşturma
7. İşlerim sayfası
8. Eski next-step fallback ve ölçüm

Her dilim bağımsız build ve davranış doğrulamasından geçer.

---

## 8. Geçiş ve geriye uyumluluk

### Activities

- Mevcut activity kayıtları değiştirilmez.
- `follow_up` activity tipi geçmiş kayıtları render etmeye devam eder.
- Yeni takip oluşturma UX'i task'a yönlendirilir.
- Activity API silinmez; timeline kaynağı olarak kalır.

### Company next_step

- Alan ilk sürümde silinmez.
- Pending task varsa UI task'ı gösterir.
- Task yoksa eski `next_step` fallback olarak görünür.
- Kullanım ölçümleri yeterli olduktan sonra alan salt okunur hale getirilir.
- Eski metinlerin otomatik task'a dönüşümü kullanıcı onayı olmadan yapılmaz; tarih ve sahip bilinmemektedir.

### Company assigned_to

- Mevcut değerler korunur.
- UUID yerine tenant üyesi ismi/email'i resolve edilir.
- Atanmamış kayıtlar `null` kalabilir ve sahipsiz kuyruğunda görünür.

### Deal geçişi

- Phase 5 öncesi company-stage akışı çalışmaya devam eder.
- Deal açıldığında mevcut stage ilk deal'e kopyalanır.
- Geçiş tenant bazlı feature flag ile yapılır.

---

## 9. UX sözleşmeleri

### 9.1 Task oluşturma

- Firma bağlamında açılırsa firma otomatik seçilir.
- Kişi bağlamında açılırsa kişi otomatik seçilir.
- Varsayılan sahip oturumdaki kullanıcıdır.
- Varsayılan öncelik `normal`dır.
- Son tarih zorunludur.
- Kaydetme sonrası next-action paneli ve ilgili listeler anında güncellenir.

### 9.2 Task tamamlama

- Tek tık “Tamamla” vardır.
- İsteğe bağlı sonuç notu açılabilir.
- Tamamlandıktan sonra “Yeni sonraki aksiyon oluştur” önerilir.
- Yanlış tamamlamada kısa süreli geri alma veya yeniden açma bulunur.

### 9.3 Gecikme

- Yalnız `pending` ve `due_at < now` task gecikmiştir.
- Completed/cancelled task hiçbir yerde gecikmiş görünmez.
- Renk tek başına bilgi taşımaz; metin/ikon da kullanılır.

### 9.4 Empty state

- “Henüz task yok” pasif bir mesaj değildir.
- Firma detayında “Sonraki aksiyon ekle” CTA'sı sunar.
- İşlerim sayfasında görevin nasıl oluşturulacağını ve firma bağlamını açıklar.

### 9.5 Stage transition

- Terminal stage için modal her yüzeyde aynıdır.
- Modal firma adını ve hedef sonucu gösterir.
- İptal edilirse stage değişmez.
- Başarılı transition timeline ve pipeline'ı birlikte günceller.

---

## 10. Ölçüm planı

### North-star davranış metriği

**Haftalık aktif CRM kullanıcısı başına tamamlanan, firma bağlı task sayısı**

### Aktivasyon

- İlk task oluşturma süresi
- İlk task tamamlama süresi
- İlk firma sahibi atama süresi
- Task oluşturulan aktif firma oranı

### Operasyon kalitesi

- Açık task'ların gecikme oranı
- Task tamamlanınca yeni task oluşturma oranı
- Task'sız aktif pipeline kaydı oranı
- Sahipsiz aktif firma oranı
- 14+ gün temassız firma oranı

### Pipeline kalitesi

- Stage'de medyan kalma süresi
- Terminal transition'larda kapanış nedeni doluluk oranı
- Kayıtlı görünüm kullanımı
- Pipeline kartından task oluşturma oranı

### Veri kalitesi

- Ham `next_step` kullanımının zaman içindeki azalması
- Owner doluluk oranı
- Deal modeli sonrası amount ve expected close doluluk oranı

---

## 11. Riskler ve azaltma planı


| Risk                                                | Etki   | Azaltma                                                                             |
| --------------------------------------------------- | ------ | ----------------------------------------------------------------------------------- |
| Task ve follow-up birlikte kafa karıştırır          | Orta   | Yeni oluşturma UX'inde task'ı varsayılan yap, follow-up'ı geçmiş uyumluluk için tut |
| Kullanıcılar her etkileşimden sonra task oluşturmaz | Yüksek | Aktivite sonucu sonrası next-task önerisi ve task'sız pipeline filtresi             |
| Sahiplik ataması eski kayıtlarda boş kalır          | Orta   | Sahipsiz kuyruğu ve bulk assign                                                     |
| Pipeline kartı aşırı yoğunlaşır                     | Yüksek | Bilgi hiyerarşisi, kompakt sinyaller ve kart kişiselleştirmesi                      |
| Deal modeli erken eklenir                           | Yüksek | Phase 5 karar kapısı ve kullanım doğrulaması                                        |
| Timeline kaynakları farklı terminoloji kullanır     | Orta   | Ortak event sunum sözleşmesi ve kanal adapter'ları                                  |
| Eski next_step verisi kaybolur                      | Yüksek | Fallback gösterimi, silmeme ve kullanıcı onaysız otomatik migration yapmama         |


---

## 12. Definition of Done

Her CRM dilimi için tamamlanma koşulları:

- Kullanıcı yolculuğu ve empty/loading/error durumları uygulanmış
- Türkçe ve İngilizce metinler tamamlanmış
- Firma, kişi, pipeline ve global yüzeyler arası davranış tutarlı
- Mobil modal/drawer davranışı doğrulanmış
- Klavye ve görünür focus davranışı korunmuş
- API ve UI type sözleşmeleri eşleşiyor
- Migration ileri yönlü ve geriye uyumlu
- Server ve client build başarılı
- Hedefli testler başarılı
- Graphify grafiği güncellenmiş
- Bu plandaki implementation log güncellenmiş

---

## 13. Başlangıç uygulama kaydı

### 2026-07-10 — R1 / Dilim 1 tamamlandı

Uygulanan değişiklikler:

- `114_crm_tasks.sql`: task veri modeli, indeksler, RLS ve atomik tamamlama fonksiyonu
- `server/src/routes/tasks.ts`: listeleme, oluşturma, düzenleme, tamamlama, iptal, yeniden açma ve silme API'si
- `server/src/lib/validation.ts`: task create/update/complete sözleşmeleri
- `client/src/types/task.ts`: istemci task sözleşmesi
- `TaskForm.tsx`: tarih, öncelik, kişi ve detay destekli create/edit formu
- `NextActionPanel.tsx`: firma detayında pending task listesi, gecikme durumu, oluşturma, düzenleme, tamamlama ve iptal
- `CompanyDetailPage.tsx`: task paneli ve eski `next_step` fallback'i
- Ajanda yalnız `meeting` ve legacy `follow_up` aktivitelerini planlanmış iş kabul edecek şekilde düzeltildi
- Dashboard yaklaşan aktivitelerinden notlar çıkarıldı
- Cold call activity tipi type, ikon, renk, filtre ve istatistik sözleşmesine eklendi
- Aktivite detay girişi çok satırlı hale getirildi
- Firma başlığındaki terminal stage seçimi kapanış raporu akışına bağlandı
- Türkçe ve İngilizce task metinleri eklendi

Doğrulama:

- `npm run build`: başarılı
- `git diff --check`: başarılı
- Locale JSON parse kontrolü: başarılı
- Yeni task bileşenlerinde hedefli ESLint: başarılı
- Genel client lint: repository genelindeki önceden mevcut 78 hata nedeniyle başarısız; yeni task dosyalarında hata yok

R1'de sıradaki dilim:

1. Global “İşlerim” sayfası
2. Tenant üyesi seçici ve gerçek task/firma sahipliği
3. Pipeline kartında sonraki task ve gecikme sinyali
4. Activity sonucu sonrası “sonraki task oluştur” akışı
