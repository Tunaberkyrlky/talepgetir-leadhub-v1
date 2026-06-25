# TG-Research v2 — Kullanım & Fiyatlama Modeli

> Bir B2B SaaS gözüyle, en baştan. **Sayılar placeholder** (pilot COGS'u ölçülünce oturur); kalıcı olan **mantık ve kurallar**.
> Karar (sen): birim = **nitelikli lead** (içeride ve dışarıda aynı), **sadece MATCH ücretli**, taban **USD**, paketler **yıllık**, büyük firmada **seat başına ek ücret**.

---

## 0. Neden kullanım bazlı? (Neden düz "koltuk" değil?)

Maliyet **kullanıma bağlı ve çok değişken**: her araştırılan firma gerçek para yakar (proxy bandwidth, LLM token, scrape, enrichment). Düz "kullanıcı başına aylık X" ağır kullanıcıda batar. Saf "ne kullanırsan öde" de alıcıyı korkutur (öngörülemez fatura). Doğru model **hibrit**:

> **Abonelik (içinde aylık lead kotası) + biten kotaya ek paket + büyük firmada seat başı ek ücret.**

Birim **soyut kredi değil, doğrudan "nitelikli lead"** — müşteri neye ödediğini birebir anlar.

---

## 1. Değer metriği: nitelikli lead (MATCH firma)

- **Birim = 1 MATCH firma** (doğrulanmış, uygun, özetlenmiş, iletişimi çıkarılmış aday). İçeride de dışarıda da aynı dil.
- **Sadece MATCH ücretli.** PARTIAL ve ELIMINATED firmalar **ücretsiz** (sana maliyet ama müşteriye "çöp için ödedim" hissi yok). MATCH fiyatı, yanında taranan elenenleri de karşılayacak şekilde konur.
- **Seat:** araştırmayı/CRM'i kullanan kişi sayısı. Küçük firmada dahil; **büyük firmada seat başına ek ücret**.
- **Referans fiyat (varsayımsal, kapatıldı): $1.00 / MATCH lead** (PAYG); tier'da paketlenince efektif ~$0.17–0.25 (§4).
- Başlık: *"Growth ≈ ayda ~X nitelikli lead, k koltuk"*.

---

## 2. Kotayı ne yakar / neyi sınırlar

| Kalem | Maliyet kaynağı | Ücret modeli |
|---|---|---|
| **MATCH firma** (ana birim) | arama + scrape + validasyon (+ yanındaki elenenler) | **Lead kotasından düşer** |
| ICP / pazar / coğrafya kurulumu | LLM | Pakete **dahil** (adil kullanım) |
| **HS Code scrape** (TradeMap/gümrük) | scrape + proxy | **Paket bazlı sayı limiti** (kaç HS code taranabilir) |
| **Enrichment** (kişi/karar verici email) | dış API (BetterEnrich) | **Ayrı ek-paket**, en son öncelik; firma maili = scrape (ucuz, dahil) |
| Re-validation / görülen firma | cache/kütük | **Ücretsiz** (D2) |

İki tip sınır: **(a) lead kotası** (ana), **(b) HS-code scrape limiti** (gümrük tarafı). Enrichment ayrı, sonra.

---

## 3. Senin göremediğin detaylar (B2B SaaS uzmanı notları)

**D1 — Sadece MATCH ücretli (karar verildi).** Elenen/zayıf firma ücretsiz. Net UX: *"yalnız nitelikli lead için ödersin."* Risk: isabet oranı düşükse MATCH başına maliyet artar → **MATCH fiyatını pilot isabet oranına göre koy** (içine elenenlerin maliyeti gömülü).

**D2 — Dedup = ücretsiz (hem adil hem satış argümanı).** Kütük sayesinde aynı firma 2. kez taranmaz → **2. kez kotadan da düşmez.** Açıkça söyle: *"aynı firmayı iki kez faturalamayız."*

**D3 — Başarı-bazlı.** Firma MATCH değilse ücret yok. Enrichment'ta email bulunamazsa ücret yok. Kota **blokla → başarıda düş, başarısızda iade**.

**D4 — Rezervasyon / hold.** Run başlarken tahmini lead'i blokla; bitince gerçekleşeni düş, kalanı iade. Mid-run çift-düşme / eksi bakiye engeli.

**D5 — Kota ortada bitince.** Araştırma uzun (chunk chunk). Kota biterse iş **temiz duraklar**: durum kaydedilir, "şu kadar yapıldı, devam için yükle" denir, top-up'ta **kaldığı yerden devam** — iş kaybolmaz.

**D6 — Çalıştırmadan önce tahmin (pre-auth).** Coverage tahmini (E) → *"≈480 firma taranacak, ≈N MATCH bekleniyor, onaylıyor musun?"*. Öngörülebilir harcama = B2B'de en büyük güven; sürpriz fatura = churn.

**D7 — Süre.** **Abonelik lead kotası aylık** (kullan-yoksa-yanar). **Paketler yıllık** (senin kararın) — yıl boyu devreder.

**D8 — Trial = 50 firma (karar).** Trial kullanıcı "aha"ya (ilk lead'ler CRM'inde) rahat ulaşır. Maliyeti dert etme dedin; yine de **suistimal** (D12) için kart/domain kontrolü.

**D9 — Taban USD (karar).** COGS USD'li (LLM/enrichment/proxy); TR müşteriye TRY tahsilat olsa da **fiyat USD'ye sabit** — kur riski marjı yemez.

**D10 — Vergi / fatura.** Stripe Tax (TR + uluslararası KDV), e-fatura, kurumsal sözleşmeli ödeme.

**D11 — Marj / COGS izleme (içeride).** Tenant başına gerçek maliyet (token + bandwidth + enrichment $) vs düşen lead → **marj paneli**. Tek ağır kullanıcı marjı patlatmasın; tier başına fair-use.

**D12 — Suistimal.** Trial çoğullama (email/domain/kart); bizi bedava scraper gibi kullanma (rate limit); **bir tenant'ın kütüğü asla başka tenant'a görünmez** — sadece ham public web cache paylaşılır (maliyet düşer, veri sızmaz).

**D13 — Auto-recharge & uyarı.** Kota %80/%100 bildirim; eşik altına inince otomatik paket (opt-in). Run ortasında kesinti olmasın.

**D14 — Roller & harcama tavanı.** CRM çok kullanıcılı; kim run başlatıp lead yakabilir, proje/kullanıcı başına tavan.

**D15 — Churn & veri.** Müşterinin biriken kütüğü onun değeri + bizim lock-in. Ayrılınca export hakkı (KVKK/GDPR), saklama süresi, kota iadesi — baştan tanımlı.

**D16 — Fiyatı modelden/sağlayıcıdan ayır.** "1 MATCH = X" sabit; arkada Sonnet→Haiku, enrichment sağlayıcısı değişse müşteri fiyatı değişmez.

---

## 4. Paketleme (varsayımsal — KAPATILDI; pilotla teyit)

> Sayılar **varsayımsal ama tutarlı**; ilerlemek için **kapatıldı**. Pilot COGS'u ölçünce ince ayar.
> Varsayılan COGS ≈ **$0.08–0.12 / MATCH lead** (arama + validasyon + yanındaki elenenler; liste hasadı ucuzlatır). Hedef brüt marj ~%70+.

**Birim referans fiyat (PAYG / overage): $1.00 / MATCH lead.** Tier'larda paketlenince efektif düşer:

| Tier | Aylık ücret | Aylık lead (MATCH) | Efektif $/lead | Seat | HS-code scrape | Enrichment (kişi) |
|---|---|---|---|---|---|---|
| **Free / Trial** | $0 | **50** (tek sefer) | — | 1 | 50 | 10 |
| **Starter** | **$49** | 200 | $0.245 | 2 | 200 | ek-paket |
| **Growth** | **$199** | 1.000 | $0.199 | 5 | 1.000 | 200 dahil |
| **Scale** | **$599** | 3.500 | $0.171 | 10 (+$29/ek seat) | 5.000 | 1.000 dahil + API |
| **Ek paket** | **$79** | 100 | $0.79 | — | — | — |

- **Enrichment add-on:** **$0.25 / doğrulanmış kişi** (BetterEnrich passthrough + marj). Başarısızsa ücret yok.
- **Yıllık:** 2 ay bedava (~%17 indirim); paketler yıl boyu devreder.
- **Büyük firma:** Scale üstü **seat başına ek ücret** (+$29).
- Başlık **sonuç dilinde** ("≈ ayda X nitelikli lead").

---

## 5. Teknik karşılık (kısa)

- **`research_usage_ledger`** — append-only: `tenant_id, delta (+/−), reason, ref_id (firma/job), balance_after, created_at`. Tek doğruluk kaynağı.
- **`research_usage_holds`** — `job_id, reserved, settled, released` (D3/D4).
- **Operation→ücret eşlemesi = config (veri, kod değil)** → fiyat ayarı deploy'suz (D16).
- **Stripe:** abonelik + kota grant + ek paket + webhook → ledger; auto-recharge (D13), Tax (D10).
- **Pre-auth estimate** (D6): coverage E → beklenen MATCH → onay ekranı.
- **Marj paneli** (D11): ledger vs gerçek COGS log'u.

---

## 6. Yürütme önerisi

> Fiyatlar §4'te **varsayımsal kapatıldı**; aşağıdaki pilot bunları **teyit / ince ayar** içindir.

1. **Pilot (1 gerçek müşteri)** → bir uçtan uca run → **gerçek COGS** (MATCH firma başına token + bandwidth + scrape $).
2. O sayıdan **lead fiyatı** ve **tier kotaları**nı sabitle.
3. Trial 50 firmanın maliyetini doğrula (kabul edilebilir CAC mi).
4. HS-code scrape limitlerini gümrük scrape maliyetine göre koy.
