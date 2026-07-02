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

### 4.1 Pilot COGS ölçümü — **İLK ÖLÇÜM** (2026-06-30, codex-revize)

İki **soğuk** (cache'siz, sıfırdan keşif) canlı run — Hollanda + Polonya, German ICP şablonu, kapaklar 6 sorgu / 30 fetch / 40 aday / $2. Gerçek Gemini grounding + DeepSeek doğrulama. Meter **ham token/sorgu** sayımlarını tuttu → gerçek faturayla re-run'sız yeniden hesaplanır.

> **KAPSAM:** Bu rakam SADECE **harvest LLM + fetch COGS'u** (Gemini arama + DeepSeek doğrulama + Jina). **Hariç:** ICP üretimi (Opus, kurulum — pakete dahil/amortize), enrichment (ayrı ek-paket), direct-fetch bant genişliği, başarısız run harcaması, depolama/kuyruk, insan QA, ödeme/vergi. Bunlar fiyatı kilitlemeden önce ayrıca eklenecek.

| | Hollanda | Polonya | Toplam |
|---|---|---|---|
| MATCH | 4 | 14 | **18** |
| Değerlendirilen (verdict alan) | 30 | 31 | 61 |
| **$/MATCH** (grounding $0.007) | $0.076 | $0.022 | **$0.034** |

**COGS bileşimi (grounding $0.007 ile, toplam $0.616):** Gemini grounded arama $0.528 (%86 — çıktı $0.316 [grounded notlar + **thinking token'ları**] + grounding $0.189 [27 sorgu] + girdi $0.023); DeepSeek $0.088 (%14, girdinin %17'si prompt-cache); Jina $0.

**✅ ORAN TEYİDİ YAPILDI (2026-07-02, liste fiyatları):**
- **Gemini 3.1 Pro:** $2/M in, $12/M out (≤200K ctx — çağrılarımız çok altında), **grounding $14/1000 sorgu = $0.014** teyit. Not: Gemini 3 ailesi paylaşımlı **ayda 5.000 ücretsiz grounding prompt'u** var — pilot ölçeğinde grounding fiilen bedava olabilir; fiyatlama ÜCRETLİ orana göre (muhafazakâr).
- **DeepSeek V4 Pro:** in **$0.435/M** (varsayım $0.30 — %45 düşük saymışız), out **$0.87/M** (varsayım $1.20 — yüksek saymışız), **cache-hit $0.003625/M** (≈bedava; 40.064 cached token artık gerçek oranla). `pricing.ts` default'ları güncellendi + cache-aware fiyatlama eklendi (`pricing_version=v2`).

**Teyitli oranlarla yeniden hesap (ham sayımlardan, re-run'sız):**
| | USD | pay |
|---|---|---|
| Gemini (in $0.023 + out $0.316 + grounding $0.378) | **$0.717** | %88 |
| DeepSeek (miss $0.084 + cached $0.0001 + out $0.013) | **$0.098** | %12 |
| **TOPLAM** | **$0.815** | |

→ **$/MATCH = $0.0453** (18 MATCH), $/değerlendirilen = $0.0134. Önceki $0.045 tahminiyle örtüştü (DeepSeek input artışı ↔ output düşüşü + cache indirimi dengeledi). **3 oran artık fiyat-kanıtı kalitesinde; kalan tek büyük belirsizlik İSABET ORANI (n=2).**

**Ham sayımlar (arşiv):** Gemini 12 çağrı / 11.530 in / 26.335 out / 27 grounded sorgu; DeepSeek 67 çağrı / 233.827 in (40.064 cached) / 15.161 out; Jina 54 faturalanabilir fetch.

**Marj (gerçekçi — codex düzeltti):** marj = (fiyat − COGS)/fiyat.

| $/MATCH COGS | Growth eff $0.17 | Starter eff $0.245 | PAYG $1.00 |
|---|---|---|---|
| ölçülen $0.034 | %80 | %86 | %97 |
| gerçek grounding $0.045 | %74 | %82 | %96 |
| kötümser $0.073 | %57 | %70 | %93 |
| çok kötümser $0.102 | **%40** | %58 | %90 |

→ **Olası COGS $0.03–0.05/MATCH** → tüm tier'larda %74+ marj, PAYG %96+. Çok kötümserde (COGS $0.10) en ucuz tier %40'a iner (>%75 DEĞİL — önceki iddia yanlıştı), ama hâlâ pozitif. PAYG her zaman ≥%90.

**✅ İSABET GENİŞLETME PİLOTU (2026-07-02) — n=5 coğrafya / 2 ICP arketipi / 41 MATCH:**

| Run | ICP | İsabet | $/MATCH (soğuk, v2 oranlar) |
|---|---|---|---|
| Hollanda | keskin (tesisat toptancısı) | %13 | $0.076 |
| Polonya | keskin | %45 | $0.022 |
| Fransa | keskin, farklı dil | %13 | $0.110 |
| Çekya | keskin, seyrek pazar | %35 | — (warm cache, COGS temsili değil) |
| İspanya | **bulanık (MRO distribütörü)** | %20 | $0.083 |

- **Harman: isabet %26 (41/158), soğuk $/MATCH = $0.062** ($1.74 / 28 soğuk MATCH). Aralık **$0.02–0.11**; tek-coğrafya en kötüsü Fransa ($0.11 — düşük isabet × yüksek grounding).
- **İsabet dağılımı %13–45** — tek sayı değil bir BANT. Fiyat, bandın KÖTÜ ucuna göre konmalı: $/MATCH ~$0.10 varsayımıyla bile Growth eff $0.17-0.25'te marj %41–60, PAYG $1.00'da %90.
- Çekya run'ı **cross-ICP re-score'u üretimde doğruladı**: 7 mevcut firma cached metinden yeniden skorlandı → 4 match → fatura dedup'u kusursuz (13 match, yalnız 10 yeni tahsilat; 3'ü zaten faturalıydı — çift charge yok).
- Bulanık ICP (İspanya MRO) isabeti %20'ye düşürdü ama felaket değil — ICP kalitesi isabetin ana kaldıracı; ICP Master onay akışı tam bu yüzden değerli.

**Fiyat-kilidi durumu: 3 oran teyitli + isabet bandı ölçüldü → tier kotaları bu veriyle kilitlenebilir.** Kalan (küçük): hariç-tutulan kalemler (ICP-Opus kurulum ~metered artık, başarısız-run COGS'u, ödeme/vergi) fiyata pay olarak eklenmeli.

**COGS kaldıraçları (sırayla):**
1. **Grounded sorgu sayısını azalt** (6 sorgu → daha az, daha hedefli) + **çıktı/thinking token'ını kıs** (Gemini effort/maxTokens) — en ucuz, koddan.
2. **Daha ucuz extraction** (keşif notlarını yapılandırma DeepSeek'te, zaten öyle).
3. **Daha derin hasat** — keşif run-başına sabit, MATCH'lere amortize olur (PL $0.022 @14 vs NL $0.076 @4 — kısmen amortizasyon, **kısmen pazar varyansı**); marjinal isabet korunursa birim maliyet düşer.
4. **Ölçekte self-host arama** (SearXNG/Gosom) — grounding ücretini sıfırlar ama proxy/altyapı/yasal/kalite maliyeti getirir; #1 değil, kademeli.

**Thinking-token düzeltmesi kritikti:** Gemini çıktısının ~%55'i düşünme token'ıydı; düzeltme olmasa COGS **düzeltilmiş toplamın %28'i kadar eksik** sayılırdı → lead'ler yanlış (düşük) fiyatlanırdı.

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

1. **Pilot** → 2 soğuk run (NL+PL, 18 MATCH) → **ilk ölçüm $0.034/MATCH** (grounding $0.007) / **$0.045** (grounding $0.014, daha gerçekçi). ✅ ölçüldü (§4.1). Büyüklük mertebesi varsayım $0.08–0.12'nin altında.
2. **Lead fiyatı + tier kotaları:** ölçülen oranlarda marj sağlıklı (§4.1 tablo). **Kilitlemeden ÖNCE:** (a) 3 oranı gerçek faturayla teyit (Gemini out/grounding, DeepSeek), (b) **üretim isabet oranını** birkaç ICP×ülke daha ile ölç (n=2 yetersiz; $/MATCH isabetle ters orantılı), (c) hariç-tutulan maliyetleri ekle (§4.1 KAPSAM).
3. Trial 50 firma maliyeti: 50 × ~$0.045 ≈ **$2.25 / trial** (grounding $0.014, %30 isabet); düşük isabette artar (~$6 @%10) — yine de kabul edilebilir mertebe.
4. HS-code scrape limitlerini gümrük scrape maliyetine göre koy (Y2 — henüz bağlanmadı).
