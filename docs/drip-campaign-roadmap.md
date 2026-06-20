# Drip Kampanya Yol Haritası — PlusVibe Paritesi

> **Amaç:** Mevcut drip kampanya motorunu, PlusVibe benzeri bir cold-outreach
> platformunun sahip olduğu deliverability ve akış yeteneklerine kavuşturmak.
> Bu belge **tasarım/plan** belgesidir; her faz kullanıcı onayıyla ayrı ayrı
> uygulanır. Kod yazılmadan önce buradaki karar noktaları netleştirilmeli.

**Durum:** Taslak — onay bekliyor
**Mevcut sürüm:** 1.11.0
**Hazırlayan:** Claude + Tunaberk

---

## 0. Bugün elimizde ne var (gerçek kod)

Sistemin **çekirdek mekaniği zaten kurulu**. Sıfırdan inşa etmiyoruz; eksik
PlusVibe yeteneklerini ekliyoruz.

| Parça | Dosya | Özet |
|---|---|---|
| Zamanlayıcı | `server/src/lib/campaignScheduler.ts` | 60 sn'de bir tick; tick çakışmasını engeller |
| Motor | `server/src/lib/campaignEngine.ts` | Enrollment state machine, şablon çözümü, gönderim, ilerletme |
| Gönderim | `server/src/lib/emailSender.ts` | Nango (kullanıcının kendi Gmail/Outlook'u); sağlayıcı limiti (Gmail 450/gün) + 3/sn throttle |
| Takip | `server/src/lib/mailTracking.ts` + `routes/tracking.ts` | HMAC token, açılma pikseli, tıklama yönlendirme, unsubscribe |
| Yanıt durdurma | `campaignEngine.cancelEnrollmentOnReply` | IMAP veya PlusVibe webhook yanıt yakalayınca diziyi durdurur |
| Şema | `supabase/migrations/032_campaigns.sql`, `033_activities_campaign_columns.sql` | 5 tablo (aşağıda) |
| UI | `client/.../CampaignEditorPage`, `SequenceTimeline`, `StepEditor`, `EnrollmentPanel`, `CampaignStatsPanel` | Sıra editörü, enrollment, istatistik |

### Mevcut veri modeli (özet)

- **campaigns** — `status`, `from_name`, `settings` JSONB (`{ daily_limit?, timezone?, cc? }`), `total_enrolled`
- **campaign_steps** — `step_order`, `step_type` (`email`/`delay`/`condition`), email alanları, `delay_days/hours`, **condition alanları zaten var ama kullanılmıyor** (`condition_type`, `condition_wait_hours`, `parent_step_id`, `branch_label`)
- **campaign_enrollments** — `status` (`active`/`completed`/`paused`/`replied`/`bounced`/`unsubscribed`), `current_step_id`, `next_scheduled_at`, `branch_path` (default `/`, kullanılmıyor)
- **campaign_email_events** — `event_type` (`open`/`click`/`bounce`/`reply`), `event_data` JSONB
- **activities** — `campaign_email` tipi, `campaign_id`, `enrollment_id`

### Önemli: şema kısmen "FUP-ready"
`condition_*`, `parent_step_id`, `branch_label`, `branch_path` kolonları **migration'da mevcut** ama motor bunları işlemiyor (`// condition step handling will be added in FUP phase`). Yani Faz 2'nin (dallanma) veri tabanı tarafı büyük ölçüde hazır.

---

## 1. PlusVibe'a göre doğrulanmış eksikler

Aşağıdaki her satır kodda teyit edildi:

| # | Eksik | Kanıt / not |
|---|---|---|
| E1 | **Gönderim penceresi yok** — mailler 7/24 çıkıyor; `settings.timezone` hiç okunmuyor | `campaignEngine.ts:209` (`lte('next_scheduled_at', now)`) |
| E2 | **Kampanya günlük limiti uygulanmıyor** — `settings.daily_limit` UI'da var, motorda okunmuyor (ölü config) | Motorda `daily_limit` geçmiyor |
| E3 | **Inbox rotasyonu yok** — kampanya hep *default* bağlantıdan gönderiyor | `campaignEngine.ts:319` (`sendEmail(tenantId, ...)` adres belirtmeden) |
| E4 | **İnsansı jitter yok** — vadesi gelen 50 kayıt tight loop'ta peş peşe | `campaignEngine.ts:223` |
| E5 | **Koşullu dallanma yok** — şema hazır, motor değil; validation sadece `email`/`delay` kabul ediyor | `campaignEngine.ts:356`, `validation.ts` discriminatedUnion |
| E6 | **A/B varyant yok** — adım başına tek konu/gövde | `campaign_steps` tekil alanlar |
| E7 | **Bounce otomatik yakalanmıyor** — `bounced` durumu ve `bounce` event tipi var ama set eden kod yok | IMAP'te bounce parse yok |
| E8 | **Mail doğrulama yok** — geçersiz adrese gönderim denenip yanıyor | — |
| E9 | **Spintax yok** — metin çeşitleme yok, spam riskini artırır | `applyTemplate` sadece `{{var}}` |
| E10 | **Warmup / ramp-up yok** — yeni kutudan birden yüksek hacim | — |

---

## 2. Faz planı (önerilen sıra)

Sıralama **etki × bağımlılık**'a göre: deliverability güvenliği önce (müşterinin
kendi domain itibarını korur ve PlusVibe'ın kalbidir), sonra akış zekâsı, sonra
liste sağlığı, en son warmup.

```
Faz 1  Gönderim Güvenliği & Teslimat   (E1, E2, E3, E4)   ← en yüksek etki
Faz 2  Akış Zekâsı                      (E5, E6)
Faz 3  Liste & Teslim Sağlığı           (E7, E8, E9)
Faz 4  Warmup & İtibar                  (E10)              ← ileri, opsiyonel
```

> **Sürüm etkisi (ship skill):** Bu, sessizce patch altında birikmemesi gereken
> bir **milestone**. Faz 1 tek başına **minor bump (1.12.0)** hak eder; tüm set
> tamamlandığında kümülatif olarak büyük bir yetenek alanı açılmış olur. Her fazı
> kendi minor'ı ile işaretlemeyi öneriyorum (1.12 / 1.13 / 1.14).

---

## Faz 1 — Gönderim Güvenliği & Teslimat

**Hedef:** Mailler insan gibi, mesai içinde, kutu başına limitli ve birden çok
kutuya yayılarak gitsin. Bu faz müşterinin domain itibarını korur.

### 1.1 Gönderim penceresi (E1)

**PlusVibe karşılığı:** "Sending schedule" — yalnızca seçili günlerde ve saat
aralığında, hesabın/lead'in saat diliminde gönderim.

**Veri modeli:** `campaigns.settings`'e (JSONB, migration gerektirmez ama tip ekleyeceğiz):
```jsonc
sending_window: {
  timezone: "Europe/Istanbul",      // IANA tz
  days: [1,2,3,4,5],                 // 0=Pazar … 6=Cumartesi
  start: "09:00",                    // pencere açılış (yerel)
  end:   "18:00"                     // pencere kapanış (yerel)
}
```
Eski kampanyalar `sending_window` yoksa **"her zaman"** davranışına düşer (geriye uyumlu).

**Motor değişikliği:** Yeni saf yardımcı `nextSendableTime(now, window): Date`.
Bir email adımının `next_scheduled_at`'i pencere dışına denk gelirse, **bir sonraki
pencere açılışına** ötelenir (gönderim yapılmaz). `delay` adımı bittiğinde de hesaplanan
zaman pencereye clamp edilir.

> **KARAR NOKTASI — saat dilimi:** Sunucuda `dayjs` **yok** (sadece client'ta var).
> Yeni bağımlılık eklememek için `Intl.DateTimeFormat(tz, …).formatToParts()` ile
> tz'ye göre yerel saat hesaplayan küçük bir helper öneriyorum (Node'da yerleşik,
> bağımlılıksız). Alternatif: `server`'a `dayjs` + `timezone` plugin eklemek.
> **Öneri:** Intl helper (sıfır bağımlılık).

### 1.2 Kampanya günlük limiti — gerçekten uygula (E2)

**PlusVibe karşılığı:** Kampanya başına günlük gönderim tavanı.

**Motor:** Gönderimden önce, o kampanyanın **bugün** (pencere tz'sinde gün başı)
`outcome='sent'` activity sayısını oku; `daily_limit`'e ulaşıldıysa enrollment'ı
**ertesi pencere açılışına** ötele, gönderme.

**Performans notu:** Her gönderimde sayım pahalı olabilir; tick başında kampanya
bazında bir kez sayıp bellekte tutmak yeterli (tick 60 sn, 50 kayıt). İleride
`idx` gerekebilir: `activities(campaign_id, occurred_at) where outcome='sent'`.

### 1.3 Inbox rotasyonu (E3)

**PlusVibe karşılığı:** Bir kampanyayı birden çok bağlı kutuya yayıp her kutunun
itibarını koruma.

**Veri modeli (migration gerekir):**
- Yeni tablo `campaign_sending_accounts (campaign_id, connection_id, position)` —
  kampanyanın kullanacağı kutular (join tablo; RLS + bütünlük için settings array'inden temiz).
- `email_connections.daily_send_limit INT DEFAULT 50` — kutu başına günlük tavan
  (cold için tipik 30–50).

**Motor:** Gönderim anında, kampanyanın kutuları arasından **müsait** olanı seç
(round-robin / least-recently-used), kutunun kendi günlük tavanı + 3/sn rate-limit'i
altında. `sendEmail` zaten "adrese göre" göndermeyi destekliyor (`options.fromAddress`),
o yüzden gönderim katmanı hazır.

> **KARAR NOKTASI:** Tek kutu bağlı tenant'larda davranış aynı kalmalı (default
> kutu). Rotasyon yalnızca kampanyaya ≥2 kutu atanınca devreye girer.

### 1.4 İnsansı jitter (E4)

**PlusVibe karşılığı:** Gönderimler arasında rastgele aralık → robot gibi
görünmeme, spam filtresi azaltma.

**Motor:** Vadesi gelen kayıtları tight loop'ta peş peşe göndermek yerine, her
gönderimi kutu bazında rastgele aralıkla (ör. 60–180 sn) sırala. Pratik uygulama:
tick başına **kutu başına sınırlı sayıda** gönder; kalanların `next_scheduled_at`'ini
jitter'lı ileri zamana yaz. (`Math.random()` sunucu runtime'ında serbest; yalnızca
workflow scriptlerinde yasak.)

### Faz 1 — dokunulacak yerler
- `server/src/lib/campaignEngine.ts` — pencere clamp, günlük limit, kutu seçimi, jitter
- `server/src/lib/sendingWindow.ts` *(yeni)* — `nextSendableTime`, tz helper (saf, test edilebilir)
- `server/src/routes/email-connections.ts` — kutu başına `daily_send_limit` ayarı
- `server/src/routes/campaigns.ts` + `validation.ts` — `sending_window` ve kutu atama uçları
- `supabase/migrations/049_campaign_sending_controls.sql` *(yeni)* — `campaign_sending_accounts`, `email_connections.daily_send_limit`
- Client: kampanya ayarlarında "Gönderim Programı" paneli (gün/saat/tz) + "Gönderen Kutular" çoklu seçim

### Faz 1 — risk & test
- **Risk:** tz/clamp hatası → mailler yanlış saatte/hiç gitmez. Helper'ı saf tutup
  birkaç senaryoyu manuel doğrula (pencere içi, dışı, hafta sonu, gece yarısı sınırı).
- **Geriye uyum:** `sending_window` yoksa "her zaman"; tek kutu varsa rotasyon kapalı.
- Test runner yok → motor değişikliklerini staging'de gerçek küçük kampanyayla doğrula.

---

## Faz 2 — Akış Zekâsı

**Hedef:** Sıra, lead'in davranışına göre dallanabilsin; aynı adımda A/B test edilebilsin.

### 2.1 Koşullu dallanma (E5)

**PlusVibe karşılığı:** "If opened / not opened / replied → farklı takip adımı."

**Veri modeli:** Şema **zaten hazır** (`condition_type`, `condition_wait_hours`,
`parent_step_id`, `branch_label`, enrollment'ta `branch_path`). Yalnızca **gezinme
modeli** netleştirilmeli.

> **KARAR NOKTASI — dallanma modeli:** Mevcut motor lineer (`step_order > current`).
> Dallanma bunu ağaca çevirir. İki seçenek:
> - **(a) Basit "skip" kuralları:** Her email adımına opsiyonel "açılmazsa N saat sonra
>   şu adıma atla / yanıt gelirse bitir" — lineer sıra korunur, sadece koşullu atlama.
>   Daha az UI/motor değişikliği, PlusVibe'ın %80 faydası.
> - **(b) Gerçek ağaç dallanma:** `condition` adımı + `parent_step_id` ile çok kollu
>   ağaç. Güçlü ama UI (ağaç editörü) ve motor (gezinme) ciddi iş.
> **Öneri:** Önce (a) ile çık (yanıt durdurma zaten var; "açılmadıysa farklı takip"
> en sık istenen). (b) ileride.

**Motor:** `condition` adımı işleme: enrollment koşul adımına gelince `condition_wait_hours`
bekler, sonra `campaign_email_events`'ten ilgili activity'nin durumunu okuyup dallanır.
Validation'da discriminatedUnion'a `condition` eklenir.

### 2.2 A/B varyantlar (E6)

**PlusVibe karşılığı:** Aynı adımda 2+ konu/gövde varyantı, kazananı ölçme.

**Veri modeli (migration):** `campaign_step_variants (step_id, variant_label,
subject, body_html, weight)` veya `campaign_steps.variants` JSONB. Gönderilen
activity'ye `variant_label` yazılır (stats için).

**Motor:** Adım gönderiminde varyant seç (enrollment id hash → deterministik, ya da
round-robin). Stats panelinde varyant kırılımı.

### Faz 2 — dokunulacak yerler
- `campaignEngine.ts` — condition işleme, varyant seçimi
- `validation.ts` — condition step şeması, variant şeması
- `supabase/migrations/050_campaign_variants.sql` *(yeni, A/B için)*
- Client: `StepEditor`'a koşul/varyant editörü, `SequenceTimeline`'da dallanma görseli, `CampaignStatsPanel`'a varyant kırılımı

---

## Faz 3 — Liste & Teslim Sağlığı

**Hedef:** Geçersiz/bounce adreslere gönderimi azalt, spam'e düşmeyi düşür.

### 3.1 Bounce otomatik yakalama (E7)
- **Veri/şema:** Yeni yok (`bounced` durumu + `bounce` event tipi mevcut).
- **Motor:** `imapInbound.ts`'te gelen maili bounce/DSN (mailer-daemon, `Content-Type:
  message/delivery-status`, kalıcı 5.x.x kodları) olarak tanı; ilgili enrollment'ı
  `status='bounced'`, `next_scheduled_at=null` yap; `campaign_email_events`'e `bounce` ekle.

### 3.2 Gönderim öncesi mail doğrulama (E8)
- **Veri:** `campaign_enrollments.email_verified BOOL`, gerekirse `verification_status`.
- **Motor:** İlk gönderimden önce syntax + MX (DNS) kontrolü; geçersizse enroll etme
  ya da `bounced` benzeri terminal duruma al. Harici doğrulama API'si opsiyonel/ileri.

### 3.3 Spintax (E9)
- **Veri/şema:** Yok.
- **Motor:** `applyTemplate` öncesi/sonrası `{seçenek1|seçenek2|seçenek3}` çözücü;
  gönderim başına rastgele varyant. Konu + gövdeye uygulanır.

### Faz 3 — dokunulacak yerler
- `imapInbound.ts` — bounce tanıma
- `campaignEngine.ts` — spintax çözücü, doğrulama kapısı
- `server/src/lib/spintax.ts` *(yeni, saf)*
- `supabase/migrations/051_enrollment_verification.sql` *(yeni, doğrulama için)*

---

## Faz 4 — Warmup & İtibar (ileri, opsiyonel)

**Hedef:** Yeni bağlı kutuların hacmini kademeli artırarak itibar inşa etmek.

- Kutu başına günlük tavanı zamanla artıran ramp-up planı (ör. 1. gün 5, +5/gün, tavan 50).
- Gerçek "warmup pool" (karşılıklı mail ağı) **büyük kapsam** — büyük olasılıkla
  harici servis (Mailreach/Warmupinbox) ile entegrasyon, kendi içinde kurmak yerine.
- **Öneri:** Önce kademeli ramp-up (E10'un kolay yarısı); tam warmup'ı ayrı değerlendir.

---

## 3. Kesişen konular (her fazda dikkat)

| Konu | Not |
|---|---|
| **Multi-tenancy / RLS** | Yeni tablolar (`campaign_sending_accounts`, `campaign_step_variants`) `tenant_id` + RLS ile; mevcut desen takip edilir |
| **Tier kapısı** | Drip zaten `requireTier('pro')`; yeni uçlar da aynı kapı arkasında |
| **Migration numarası** | Sıradaki 049+; numara benzersiz olsun (timestamp version'la apply ediliyor, prefix kozmetik) |
| **Geriye uyum** | Yeni ayarlar opsiyonel; eksikse eski davranış (pencere=her zaman, rotasyon=kapalı, limit=sağlayıcı limiti) |
| **Test** | Test runner yok; saf helper'ları (`sendingWindow`, `spintax`) izole tut, staging'de küçük gerçek kampanyayla doğrula |
| **Sürüm** | Her faz kendi minor bump'ı; Faz 1 → 1.12.0 |
| **Güvenlik** | Yeni gönderim yolları da SSRF/şifreleme/rate-limit disiplinine uyar (mevcut `emailSender` üzerinden gider) |

---

## 4. Önerilen ilk adım

**Faz 1.1 + 1.2** (gönderim penceresi + günlük limit enforcement) birlikte en yüksek
etkiyi/en düşük riski verir ve migration gerektirmez (ikisi de `settings` JSONB +
saf helper + motor). Inbox rotasyonu (1.3) ve jitter (1.4) hemen ardından gelir.

**Onayını beklediğim kararlar:**
1. Faz sırası bu şekilde mi, yoksa önceliklendirmeyi değiştirelim mi?
2. Saat dilimi helper'ı: **Intl (sıfır bağımlılık)** mı, yoksa server'a dayjs mi?
3. Dallanma (Faz 2): önce **basit skip kuralları (a)** mı, yoksa direkt **gerçek ağaç (b)** mi?
4. Faz 1'i tek seferde mi (1.1–1.4) yoksa parça parça mı (önce 1.1+1.2) uygulayalım?
