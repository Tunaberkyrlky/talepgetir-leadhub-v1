# TG-Research v2 — Sonraki Adımlar

Son güncelleme: **2026-07-13 (6. oturum)** — **Kullanıcının wizard'ı elle incelemesi 2 ürün-akışı boşluğu buldu; WP12 + WP13 olarak plana eklendi (aşağıda).** (1) **Wizard'a geri-dönüş:** `RootRedirect` yalnız proje HİÇ yokken, bir kereliğine `/research`'e düşürüyor — proje adım 1'de oluşur oluşmaz bu kapı sonsuza kadar kapanıyor; yarım kalmış bir kurulumdan sonra `/dashboard`'a dönen müşterinin geri dönüşü yalnız `Layout.tsx`'teki sıradan "Research" nav linkine kalıyor, hiçbir nudge/rozet yok (WP12). (2) **"Company Knowledge":** ICP/Offer/HS Codes zaten `/research/full`'da wizard'dan bağımsız düzenlenebiliyor (mevcut altyapı, WP11 kalıbı) ama profil tek başına kaydedilemiyor (yalnız ICP-yeniden-üret yan etkisiyle), sayfa hiçbir nav'dan linklenmiyor, ve serbest-metin AI-promptla revizyon HİÇBİR alanda yok — yalnız yapısal kalibrasyon-puanı tabanlı revizyon var (WP13). Detay: `04_ILERLEME.md §4.32`. Önceki (5. oturum) özet aşağıda korunuyor.

Önceki son güncelleme: **2026-07-11 (5. oturum)** — **WP11 (Comtrade pivotu) + kalıcı "HS Codes" sekmesi İKİSİ DE SHIP** (detay `04 §4.27-4.28`). **Paralel bir UX incelemesi mevcut wizard'da 2 BLOCKER buldu (ICP kart yığılması + kalibrasyon döngüsü dead-end, `04 §4.29`) — 5. oturumda İKİSİ DE GERÇEKTEN DÜZELTİLDİ + wizard görsel yeniden tasarımı (Stage 1+2) TAMAMLANDI (detay `04 §4.30-4.31`).**

Mevcut durum tek cümle: **Motor + "akıl katmanı" TAMAM ve DEPLOY'LU (WP1-WP5 + enrichment); eksik olan AKIŞIN KENDİSİ — müşteriyi teker teker taşıyan wizard kabuğu ve FAZ 1'in ön-doldurma job'ı. A-1 bunu mevcut fonksiyonları YENİDEN YAZMADAN giydirir.**

---

## A-1. WIZARD-FIRST AKIŞ ÜRETİMİ (2026-07-09) → İŞ PAKETLERİ WP6–WP10 — **YENİ ÖNCELİK**

> **Kaynak:** `tg-research-ana-akis.md` (yeniden kurgu, kanonik akış — akış/mimari çelişirse o dosya kazanır). **İlke: mevcut fonksiyon YENİDEN YAZILMAZ** — wizard, mevcut endpoint/panel/job'ları adımlara giydiren bir KABUKtur. Kod envanteri (graphify + route taraması, 2026-07-09) bu planın zeminidir; detay `04 §4.18`.
>
> **ÜRÜN KARARI — TG-Research = TG-Core'un ilk adımı:** yeni tenant login olduğunda CRM'e değil `/research` wizard'ına iner; CRM sekmeleri ilk lead export'una kadar ikincildir. Bu bir **ürün-akışı** kararıdır, altyapı birleşmesi DEĞİLDİR — **K10 aynen geçerli** (TG-Research ayrı Railway projesi + izole DB; TG-Core prod'a dokunan tek yüzey export + auth). Client tek repo olduğundan yönlendirme `App.tsx`/`Layout.tsx` seviyesinde yapılır; canlı doğrulama `tg-core-staging`'de.

**Hazır zemin (envanterden — yeniden yazım YOK):**
- `research_projects` zaten faz makinesi taşıyor: `status CHECK ('setup','icp','calibration','scaling','enrichment','handoff','paused','archived')` — wizard FAZ'ları birebir bunlara oturur; `profile JSONB` (A1) ve `scale_target` (adım 17) kolonları 055'ten beri VAR.
- `research_jobs.progress JSONB` var → bekleme ekranlarının "canlı anlatım"ı için altyapı hazır; handler'lara insan-dili progress satırı yazdırmak ADDITIVE (davranış değişmez).
- Adım ↔ mevcut yüzey eşlemesi: **1-6** projects POST/PATCH (profile) + YENİ `profile:crawl` · **9** icps generate/list/PATCH/approve + geographies POST (create-or-reuse) · **10** geographies analyze/PATCH/approve · **11** trade preview/import (TradeImportsPanel aynen) · **12-15** icps calibrate/feedback/revise/apply-revision/mark-calibrated (CalibrationDrawer) · **16** offers generate/PATCH/approve/reject (OffersPanel aynen) · **17** projects PATCH `scale_target` + geographies list (E toplamı) + harvest credits · **18** channels discover/:id/harvest + harvest run + trade batches/:id/research + jobs GET (poll) · **19** harvest companies + channels coverage (CompaniesPanel + CellCoveragePanel) · **20-21** enrichment buckets/status/run/contacts (EnrichmentPanel aynen) · **22** harvest companies/export · **23** feedback:aggregate + icps :id/outcomes (zaten otomatik).
- **Gerçekten eksik olanlar (yeni yazılacak):** wizard kabuğu + adım-içi durum işaretçisi, `profile:crawl` job'ı, sub-ICP kart-kart UI, kalibrasyonun firma-başına-ekran hali, ölçek ekranı, derin-araştırma orkestratörü (kondüktör job), müşteri-yüzü "istemiyorum" route'u, onboarding yönlendirmesi. HS/TradeMap (adım 7-8) ERTELENDİ — tablolar 056'da hazır, handler sonra.

### WP6 — Wizard iskeleti + "TG-Core'un ilk adımı" girişi — ✅ **SHIP** (04 §4.19)
- **Migration 105:** `research_projects.flow_state JSONB DEFAULT '{}'` — adım-içi işaretçi + tamamlanan kapılar (`{step, completed_gates[]}`); faz zaten `status`'ta. Başka şema değişikliği YOK.
- **Client:** `ResearchFlowPage` (yeni, `/research` default'u) — tek-ekran çerçevesi: ilerleme çubuğu, tek birincil CTA, geri dön, otomatik kayıt, `flow_state`'ten resume. Mevcut sekmeli `ResearchPage` `/research/full`'a taşınır ve "gelişmiş görünüm" olarak AYNEN kalır (internal + power-user); paneller import edilir, YENİDEN YAZILMAZ.
- **Giriş:** yeni tenant (CRM'i boş / ilk export yok) login → `/research` wizard'a yönlendirme (`App.tsx` route + `Layout.tsx` nav vurgusu). K10 dokunulmaz.
- **Kabul:** staging'de yeni test tenant'la login → wizard adım 1'e iner; sayfa yenile → aynı adımda devam; `tsc -b` + codex review.

### WP7 — `profile:crawl` + FAZ 1 ekranları (adım 1-6) — ✅ **SHIP** (04 §4.20, 9 review turu)
- **Worker:** yeni handler `profile:crawl` (jobTypes yorumunda zaten planlı slice) — girdi: website + sosyal linkler; **mevcut** `fetch.ts` (`fetchPage`, SSRF-korumalı) + `runLlmJson` (reading role) + meter/pricing AYNEN kullanılır; çıktı: firma özeti + ürün/hizmet listesi + farklılaştırıcı ön-doldurması → `research_projects.profile` JSONB'ye fenced persist (mevcut RPC kalıbı). Kredi DÜŞMEZ (kurulum COGS'u admin panelde setup-cost satırına girer — meter zaten var).
- **Client:** adım 1 formu (4 alan) → adım 2 bekleme (jobs poll + progress anlatımı) → adım 3 özet onayı → adım 4 ürün/hizmet listesi → adım 5 farklılaştırıcılar → adım 6 ipuçları. Hepsi `projects PATCH` (profile) ile kaydeder.
- **Kabul:** gerçek website ile canlı smoke (özet + ürünler dolu gelir, müşteri düzenleyip onaylar); codex review.

### WP8 — FAZ 2-3 giydirme: sub-ICP kartları + geo onayı + kalibrasyon teker-teker (adım 9-15) — **WP8a/WP8b'ye bölündü**
- **WP8a — sub-ICP kartları + ülke chip'leri + geo hücre kartları (adım 7-10) — ✅ SHIP** (04 §4.21, 4 review turu). `IcpCard` AYNEN reuse edildi; yeni `IcpCountryChips` (ekle-only, geographies POST create-or-reuse); `GeographiesPanel`'in Drawer içeriği yeni `GeoCellDetail`'e çıkarıldı (GeographiesPanel kendisi dokunulmadan ince bir Drawer sarmalayıcısına indirgendi) + wizard adım 10'da AYNEN reuse. `icp_card_index`/`geo_card_index` cursor'ları `flow_state`'te persist. **Tekrarlayan hata sınıfı (4 kez bulundu, hepsi kapandı):** auto-advance effect'lerinin explicit-Back latch'lerini atlaması — her adım sınırı için (`explicitBackNav`, `explicitBackToStep7/9/10`) ayrı bir one-shot latch kalıbı kurdu.
- **WP8b — kalibrasyon teker-teker (adım 11-15) — 🟡 KOD TAMAM, 8 codex xhigh round'u geçti, round 9 DURAKLATILDI (kullanıcı talebi).** Detaylı round-round bulgu/düzeltme özeti + `CalibrationDrawer.tsx`'in tam iç yapısı `04_ILERLEME.md §4.22`'de. `tsc -b`+`eslint` temiz ama codex'ten nihai "clean" onayı YOK. Bu turda ayrıca research-dışı, app-geneli bir tenant-izolasyon fix'i yapıldı: `client/src/contexts/AuthContext.tsx`'in `switchTenant`'ı artık `queryClient.cancelQueries()` çağırıyor (tenant flip'inden önce) — `api.ts`'in tenant header'ı mutable localStorage'dan okuma şeklinden kaynaklanan bir cross-tenant cache-poisoning riskini kapatıyor.
- **Kabul (WP8b):** codex round 9 (ya da eşdeğeri) temiz gelmeden SHIP işaretlenmesin. Temiz gelince izole DB'de e2e: calibrate → 👍/👎 (teker-teker) → resample → revise diff → apply → mark-calibrated, hepsi wizard içinden.

### WP9 — Ölçek ekranı + derin-araştırma orkestratörü + canlı anlatım (adım 16-18) — ✅ **KOD TAMAM, 2 Fable round'u geçti ("clean enough to trust"), canlı smoke BEKLİYOR** (2026-07-10, 4. oturum, detay `04 §4.23`)
- **Kapsam genişletmesi (oturum başında bulundu):** ana-akış adım 16 (offer/açı kartları) WP6-10 iş paketlerinin HİÇBİRİNE atanmamıştı — motoru WP4'te bitmiş (OffersPanel), wizard giydirmesi unutulmuştu. WP9'a eklendi (adım 15-16 = offer üretimi+teker-teker kart; adım 17 = ölçek; adım 18 = orkestratör), placeholder adım 19'a kaydı.
- **Ölçek ekranı (adım 17) — ✅:** geographies list'ten hücre E toplamı + `GET /harvest/credits` + `scale_target` PATCH (kolon 055'ten beri hazır, migration GEREKMEDİ) + "en fazla X kredi" üst-sınır önizlemesi (kredi = MATCH; dolar YOK).
- **Orkestratör — ✅ (kapsam KARARI, aşağıya bkz.):** yeni job `research:orchestrate` (server/src/lib/research/worker/handlers/orchestrate.ts) — TEK onaylı icp×geo hücresi için **mevcut** job'ları enqueue+poll eden KONDÜKTÖR: pending kanal varsa channels:harvest → rule-A açıksa channels:discover → rule-B açıksa harvest:run (Y3) → fully_covered'da dur. `scale_target`/kredi her turda CANLI okunur (yarı-yolda hedef değiştirmek anında etkili). Durma nedenleri: `credits_exhausted`/`scale_target_reached`/`fully_covered`/`time_budget` (25dk)/`iteration_cap` (40)/`child_failed` — hepsi "temiz" successed job (harvest:run'ın kendi felsefesi). Mevcut handler'lara DOKUNMAZ, salt okur+enqueue eder; mevcut "ICP başına tek harvest" in-flight guard'ını (harvest.ts/channels.ts) kendi enqueue'larından ÖNCE de kontrol eder (foreign bir job varsa adopte eder, race etmez). `maxAttempts:1`.
  - **Kapsam kararı (KULLANICI ONAYI YOK, sonraki review'de doğrulanmalı):** orkestratör TEK HÜCRE çalışır (channels:discover/harvest + harvest:run'ın zaten tek-hücre olmasıyla aynı desen) — ana-akış'ın "hücre sırasıyla" niyeti WIZARD seviyesinde karşılanır (müşteri onaylı her hücre için ayrı ayrı adım 17-18'i tekrar çalıştırabilir), TEK job'un içine gizli çok-hücreli bir döngü GÖMÜLMEDİ. Y2 (gümrük) orkestratöre dahil EDİLMEDİ — batch-scoped olduğu için hücre-döngüsüne oturmuyor, adım 11'in elle "Araştır" butonu olarak kalıyor.
  - **Yeni route:** `POST /api/research/orchestrate/run` (server/src/routes/research/orchestrate.ts) — onaylı ICP+hücre gate + in-flight adopt (200) + kredi gate (402) + `maxAttempts:1` enqueue (202). `routes/research/index.ts`'e mount edildi.
- **Canlı anlatım — ✅:** step 18 kendi `progress.stage` alanını (`deciding`/`discovering_channels`/`harvesting_channel`/`harvesting_web`) insan-dili satıra çevirir (step 7/9'un `ICP_GEN_STAGES` kalıbı); coverage rozetleri (Found/E, Rule A/B, Fully covered) WP8a'nın `GeoCellDetail`'i AYNEN yeniden kullanılarak (yeni kod YOK) canlı gösterilir.
- **Offer kartları (adım 15-16, kapsam eklentisi) — ✅:** `OfferCard.tsx` yeni (OffersPanel.tsx'in Card'ı WP8a `GeoCellDetail` emsaliyle çıkarıldı, OffersPanel AYNEN kalır) + adım 15 (offer:generate bekleme ekranı, step 7 kalıbı) + adım 16 (teker-teker kart, step 8 kalıbı, persist `offer_card_index` cursor'ı — WP8a/8b'nin AYNI `icpCardIndexOverride` deseniyle).
- **Round 1 review sonucu (Fable, background, 2026-07-10) — 3×P1 + 4×P2, hepsi gerçek, hepsi düzeltildi (tam liste `04 §4.23`):** en ciddisi, conductor'ın `pollJobToTerminal`'ının kendi içinde deadline kontrolü OLMAMASI — worker'ın TÜM concurrency slotları orkestratörle dolarsa (ya da concurrency 1 ise) child job'lar hiç claim edilemez, worker process-restart'a kadar kilitlenirdi; artık `deadlineAt` zorunlu parametre + kendi döngüsü içinde kontrol ediliyor. Diğerleri: adım 15 + (bu turda bulunan, ÖNCEDEN VAR OLAN) adım 7'nin job-success sonrası liste sorgularını hiç invalidate etmemesi (ölü spinner); adım 17'nin E tahmininin TÜM onaylı hücreleri toplaması ama orkestratörün TEK hücre araştırması (yanlış hedef beklentisi); route'un kendi kopyasıyla çelişen bir 409; hedefi bitmiş koşudan sonra yükseltmenin yeniden tetiklememesi; 15→16 auto-advance'in `calibStepToken` koruması olmaması; `calibIcpId` self-heal aralığının dar olması.
- **Kabul (henüz canlı doğrulanmadı):** 1 hücrede canlı smoke: orchestrate → Y1 keşif+hasat → Y3 → coverage rozetleri wizard'da canlı; kredi biterse temiz durma (402/exhaustion yolu); **round 2 (verify) temiz dönmeden SHIP işaretlenmez.**

### WP10 — Sonuçlar + müşteri-yüzü "istemiyorum" + FAZ 6-7 giydirme (adım 19-24) — ✅ **KOD TAMAM, 1 Fable review turu geçti (P1 yok, 2×P2 düzeltildi), canlı smoke BEKLİYOR** (2026-07-10, 4. oturum, detay `04 §4.24`)
- **Yeni küçük route — ✅:** `POST /harvest/companies/:id/suppress` (müşteri "istemiyorum") — **mevcut** fenced `research_suppress_company` RPC + best-effort 👎 feedback kaydı; `GET /harvest/companies`'in her iki yolu da artık suppressed firmaları dışlıyor (öncesinde yalnız re-harvest'te dışlanıyordu, ekranda kalmaya devam ediyordu).
- **Giydirme — ✅ (extraction YOK, seed-prop enjeksiyonu):** adım 19 = `CompaniesPanel` (yeni "İstemiyorum" satır butonuyla) AYNEN gömülü; adım 20 = `EnrichmentPanel` AYNEN gömülü — ikisi de yeni opsiyonel `initialProjectId`/`initialIcpId` prop'larıyla wizard'ın bildiği proje/ICP'ye pre-seed edildi (mevcut `/research/full` çağrı noktaları prop'suz, byte-aynı davranıyor); adım 21 = kapanış ekranı + "yaşayan döngü" 4 butonu (ülke ekle→8, yeniden kalibre et→**mevcut** `restartCalibLoop()`, ölçeği ayarla→17, daha fazla kişi→20) — hepsi saf yerel navigasyon, PATCH yok. `KNOWN_STEPS` 19→21. **Bilinçli ödün:** panellerin kendi proje/ICP seçicileri gizlenmedi (görünür ama pre-seed'li) — tam gizleme daha derin cerrahi ister, ertelendi.
- **Kabul:** uçtan uca wizard turu (adım 1→21) izole DB'de canlı smoke YAPILMADI; suppress edilen firma re-harvest'te gelmiyor iddiası kod-seviyesinde doğru ama canlı doğrulanmadı; **review round 2 temiz dönmeden SHIP işaretlenmez.**

**Sıra: WP6 → WP7 → WP8 → WP9 → WP10.** Her WP: migration (SADECE izole research test DB) + `tsc -b` + smoke + review (codex müsait değilse Fable/Claude adversarial agent, WP7-8a-9-10'da yapıldığı gibi) → düzelt → SHIP. Kilitli invariant'lar (04 §5) aynen: billing ömürde-bir + fenced RPC'ler + suppression>dedup + müşteri dolar görmez + K10.

### WP11 — UN Comtrade public API: HS eşleme + dünya ithalatı + satıcı-ülkesi bilateral ihracat — ✅ **BİTTİ → SHIP (2026-07-11, 5. oturum, detay `04 §4.27-4.28`, UNCOMMITTED)**
> Kaynak: kullanıcı talimatı (2026-07-11) — "trade map api yerine UN Comtrade public api üzerinden ürünleri anlayıp HS code önerdikten sonra o HS code'daki [ürünü] şirketin bulunduğu ülke (default:TR) ve dünya genelinden en çok import yapan firmaları çekmemiz lazım". `tg-research-ana-akis.md` adım 7-8-10 hâlâ geçerli — yalnız veri kaynağı TradeMap→UN Comtrade değişti (TradeMap'in ücretli plan/erişim açık konusu bu pivotla KALKTI: Comtrade'in `preview` uç noktası key'siz, ücretsiz çalışır). **WP6-10'dan SONRA sıraya girer.**
> **ÖNEMLİ NETLEŞTİRME (Fable, strateji kararı 2026-07-11):** UN Comtrade FİRMA-seviyesinde veri sağlamaz — yalnız ülke×ülke resmi gümrük agregatları (reporter/partner/HS/flow). "En çok import yapan firmalar" hedefi WP11'in TEK BAŞINA yapabileceği bir şey değil; WP11 (a) doğru HS kodunu bulur, (b) o koddaki gerçek ticaret hacmiyle EN GÜÇLÜ aday ÜLKELERİ sıralar (dünya ithalatı + satıcı-ülkesinden bilateral ihracat kanıtı). Gerçek FİRMA isimleri iki noktadan gelir: zaten var olan adım 17+ arama-tabanlı harvest motoru (Y1/Y3, bu ülkelerde) VE zaten var olan Y2 customs-CSV ingest'i (`trade.ts` — müşteri gerçek gümrük mikro-verisi yüklerse firma-seviyesi kayıt orada zaten var). WP11'in ürün kopyası bunu müşteriye AÇIKÇA anlatmalı ("en çok ithalat yapan ülkeleri buluyoruz — sıradaki adımda bu ülkelerdeki gerçek firmaları arıyoruz"), sahte bir "Comtrade'den firma listesi" vaadi VERİLMEMELİ.

- **Amaç — adım 7 (`hs:match`, yeni job):** onaylı ürün listesinden (client'ın adım 5'te `profile`'a yazdığı onaylı alan — kesin key adı grep ile teyit edilecek, tahmin edilmeyecek) strategy modeli (Opus, mevcut `runLlmJson('strategy', …)` kalıbı) HS 6-haneli kod adayları önerir; her aday, Comtrade'in ücretsiz/key'siz HS nomenklatür referans listesine (`comtradeapi.un.org/files/v1/app/reference/...` — canlı doğrulanacak) karşı DOĞRULANIR — var olmayan/halüsinasyon kod müşteriye asla gösterilmez. Yalnız fiziksel ürünler için kod üretilir (LLM kendi karar verir — ayrı bir "fiziksel mi hizmet mi" alanı EKLENMEZ; hizmet-ağırlıklı firmada 0 aday dönerse client adım 7'yi otomatik atlar). Adaylar `research_hs_codes`'a `source:'ai', status:'candidate'` yazılır; müşteri eler/onaylar (mevcut `research_icps` approve kalıbıyla aynı UX).
- **Amaç — adım 8 (`market:analyze`, yeni job):** onaylı HS kodlarından Comtrade public API ile (a) **dünya geneli ithalat** — sabit, ~35-40 ülkelik "major trade economy" kısa listesi üzerinden (Comtrade'in kendi `reporterAreas` referansından türetilir, `COMTRADE_MAX_REPORTERS` env ile ayarlanabilir cap — TÜM ~200 UN üyesini dönmeye ASLA çalışılmaz, ücretsiz katmanın günlük çağrı kotasını anında tüketir), HS koduna göre ithalat hacmi + (varsa önceki yıla göre) büyüme, ülkeye göre sıralanır; (b) **satıcı ülkesinden** (`profile.company_country`, boşsa **default 'TR'**) bu sıralamanın TOP-N (örn. 15) adayına bilateral ihracat hacmi + büyüme — "Türkiye zaten bu HS koduyla Almanya'ya X$ ihracat yapıyor, %Y büyüyor" kanıtı. `research_markets`'e persist edilir. HS kodu burada akıştan çıkar (ana akış §8'deki davranış AYNEN korunur); kanıt adım 9'un ülke chip'lerini ve adım 10'un (`geo:analyze`, WP2, mevcut) onay kartını besler.
- **Bağımlılık:** `profile.company_country` zaten var (WP7 `profile:crawl` doldurur, adım 3'te müşteri teyit eder) — **default TR** kullanıcı talimatıyla eklendi (alan boşsa Comtrade sorgusu TR'yi satıcı ülkesi varsayar, sessizce atlamaz).
- **Comtrade erişim notu (TradeMap'in açık konusunun yerini alır):** `public/v1/preview` uç noktası key GEREKTİRMEZ ama ağır rate-limitli (küçük sonuç sayısı, düşük qps) — MVP + canlı smoke için yeterli. `COMTRADE_SUBSCRIPTION_KEY` env opsiyonel (ücretsiz kayıtla daha yüksek günlük kota) — Hunter'ın `HUNTER_API_KEY` kalıbıyla aynı: yoksa preview'a düşer, sistemi bloklamaz. Coding ajanı gerçek uç nokta/parametre şeklini (reporter/partner M49 kodları, cmdCode, flowCode, period) CANLI doğrulamalı (WebFetch/curl) — bu belgedeki isimler eğitim-verisi hafızasından, teyitsiz.
- **Migration (bir sonraki numara — başlarken `ls supabase/migrations | sort | tail` ile TEYİT ET, 2026-07-11 itibarıyla 116 bekleniyor):** `research_markets`'e `kind TEXT NOT NULL DEFAULT 'world_import' CHECK (kind IN ('world_import','bilateral_export'))` + `reporter_country TEXT` (nullable, yalnız bilateral satırlarda dolu) eklenir. `research_hs_codes` şeması yeterli (source zaten serbest TEXT, migration gerekmez).
- **Server:** (1) yeni `server/src/lib/research/trade/comtrade.ts` — Comtrade istemcisi: HS-referans doğrulama + ülke-kodu (ISO2↔M49) çözümleme + dünya-ithalat sorgusu + bilateral sorgu, rate-limit/backoff, önbellek. (2) yeni job type'lar `hs:match` + `market:analyze` (`jobTypes.ts` + worker `handlers/index.ts` kaydı). (3) yeni handler'lar `handlers/hsMatch.ts` + `handlers/marketAnalyze.ts` — mevcut `geoAnalyze.ts`/`icpGenerate.ts` kalıbı (heartbeat stage'leri, `withLlmMeter`, fenced RPC persist). (4) yeni route (`routes/research/hs.ts` veya mevcut `icps.ts` kalıbına uyan bir dosya) — enqueue + candidate list/approve/reject. (5) `pricing.ts`'e `COMTRADE_PER_REQUEST_USD = envNum(...,0)` satırı (Hunter kalıbı — Comtrade ücretsiz, ama çağrı SAYISI admin panelde görünür kalmalı rate-limit bütçesi için). (6) `geo:analyze`'a KÜÇÜK ek: o geo.country için approved HS kodların `research_markets` satırlarını çekip LLM prompt'una kanıt olarak VE/VEYA client'a ham sayı olarak geçir (LLM'in sayıyı uydurmaması için ham veri LLM'DEN GEÇMEDEN direkt render edilmesi TERCİH EDİLİR — K5/D16 ruhu).
- **Client:** adım 7 = yeni HS kod aday inceleme ekranı (yalnız aday varsa görünür, yoksa otomatik atla); adım 8 = mevcut canlı-anlatım bileşeni (WP7/WP9 kalıbı); adım 9/10 kartlarına hacim+büyüme+kaynak rozeti ("UN Comtrade") satırı.
- **Kalıcı düzenleme yeri — WP11 kapsamına EKLENDİ (2026-07-11, kullanıcı onayı):** paralel bir agentın `/research/full` (`ResearchPage.tsx`) taramasında bulduğu gerçek bir boşluk — ürünler (ICP Master), sub-ICP'ler (Geographies) ve sales angle'lar (Offer angles) wizard'dan SONRA da kalıcı, tekrar-düzenlenebilir bir sekmede yaşıyor; HS kodlarının böyle bir yeri YOK, yalnız wizard'ın adım 7'sine gömülü — müşteri o adımı geçtikten sonra HS kodlarını bir daha hiç göremiyor/ekleyemiyor. **Fix:** `ResearchPage.tsx`'e yeni bir "HS Codes" sekmesi eklenir — mevcut `hs.ts` route'larını kullanır (`GET /api/research/hs?project_id=...`, `POST /api/research/hs/match`, `PATCH /api/research/hs/:id`), `HsCodeCandidates.tsx`'i (adım 7'nin bileşeni) bu sekmede DE render eder (tek bileşen, iki yerden kullanılan — wizard'a özel kopya YOK), müşteri istediği an yeni bir `hs:match` koşusu tetikleyebilir + var olan kodları onaylayabilir/reddedebilir/görebilir — ICP Master'ın "Products" sekmesinin hemen yanına, aynı CRUD-panel kalıbıyla. Bu, ayrı bir migration/job/route GEREKTİRMEZ (hepsi WP11'in geri kalanında zaten var) — salt client-side bir ekleme.
- **Kabul:** migration YALNIZ izole test DB'de (`iehqsuludghrhosgxhnr` — **ASLA** `ehnbhkxmsdticaodndvy`/TG Core prod'a dokunma); `tsc -b` + eslint temiz; 1 HS kodu × TR→gerçek bir aday ülke için CANLI Comtrade smoke (gerçek sayı, key'siz preview ile) → `research_markets`'te görünür → geo onay kartında görünür; yeni "HS Codes" sekmesi `/research/full`'da görünür ve wizard adım 7 ile aynı veriyi gösterir/düzenler; codex/gpt-5.6-sol high review (tenant-izolasyon + COGS-görünürlük + halüsinasyon-koruması + K10 odaklı).

> ~~**DEPLOY NOTU (kritik)**~~ ✅ **DEPLOY EDİLDİ (2026-07-09, detay `04 §4.14`):** worker `2b0b982b` + research-api `05bb9f5e` @ commit `52569e2`; migrations 090-100 önceden DB'de teyitli; clean-HEAD-archive stage (LinkedIn WIP dışarıda); 2 import-crash fix'i (`161d113` keyless PostHog, `52569e2` lazy CRM client — codex xhigh PASS 0 bulgu); post-deploy `feedback:aggregate` smoke succeeded. İleride ayrı prod research DB açılırsa "migrations önce, server sonra" sırası geçerli kalır.
> **SIRADAKİ ADAYLAR (A-1 wizard'dan SONRA — öncelik yukarıdaki A-1'e geçti, 2026-07-09):** (1) tier kota SAYILARI; (2) Y3 saturasyon/directory tuning (**kullanıcı onayı VAR: canlı+ücretli koşu serbest**, 2026-07-09); (3) ~~enrichment fazı~~ ✅ **HUNTER ENRICHMENT SHIP** (2026-07-09, `2d27d85`, detay `04 §4.15`) — kalan uçlar: domainless review firmaları hâlâ kapsam dışı (strict domain match ister), Hunter allowance ~47/50 kredi, ~~admin panelde hunter_requests COGS satırı yok (P3)~~ ✅ **HUNTER COGS GÖRÜNÜRLÜĞÜ SHIP** (2026-07-09, migration 103, codex xhigh 0-bulgu, detay `04 §4.16`, UNCOMMITTED); (4) ~~WP5 follow-up: export-anı ICP pinleme (P3, 04 §4.13)~~ ✅ **EXPORT-ANI ICP/GEO PİNLEME SHIP** (2026-07-09, migration 104, codex 1×P2→fix→verify RESOLVED, detay `04 §4.17`, UNCOMMITTED); (5) SearXNG public domain kapalı — lokal smoke'lar Gemini fallback'le koşar (Railway worker internal URL ile SearXNG'yi normal kullanır); (6) WP5 prod-mimarisi notu: gerçek prod ayrışmasında CRM outcome okuması worker'da değil (prod cred yok) — ya research-api'de koşacak ya worker'a salt-okunur scoped prod erişimi tanımlanacak (kullanıcı kararı).

---

### WP12 — Wizard'a geri-dönüş: kurulum yarım kalırsa keşfedilebilirlik — ✅ **BİTTİ → SHIP** (2026-07-13, insan incelemesi bulgusu; commit `bf4ea08` worktree `ssalihyetim/TG-Research-wp12-13`, henüz ana branch'e merge edilmedi, detay `04_ILERLEME.md §4.35`)
> Kaynak: kullanıcının wizard'ı elle incelemesi (2026-07-13) — "Research wizardı TgCore arayüzünde herhangi bir butonla veya widgetla göremiyoruz. Wizard tamamlanmadan dashboard'a geçildiğinde tekrar nasıl geçilecek planda bu belli mi?"

**Kod-doğrulanmış teşhis:** `RootRedirect.tsx` (WP6) yalnız `/` yolunda ve yalnız BİR KEZ iş görüyor: `hasProject = research_projects.length > 0` false ise `/research`'e, true ise `/dashboard`'a yönlendiriyor. `hasProject` "proje TAMAMLANDI mı" değil "proje VAR mı" sorusuna bakıyor — wizard adım 1'de oluşturulan proje satırı bunu sonsuza kadar `true` yapıyor. Adım 5'te ayrılıp sonra login olan bir müşteri bir daha ASLA otomatik `/research`'e düşmüyor. Geri dönüşün tek yolu `Layout.tsx` navItems'ındaki sabit "Research" linki (`Layout.tsx:134`, tüm rollere açık ama hiçbir koşulla vurgulanmıyor/rozetlenmiyor) — CompaniesPanel/Pipeline gibi sıradan bir modül linki gibi duruyor, "kurulumunuz yarım" demiyor. Wizard'ın kendisi doğru adımdan resume ediyor (`flow_state`, WP6 kabul kriteri zaten kanıtlı) — sorun SADECE oraya geri götüren giriş noktasında.

**Kapsam:**
1. **"Tamamlandı" eşiğini netleştir (ürün kararı gerekiyor).** Aday sinyaller: (a) `flow_state.step` bilinen son adıma ulaştı, (b) en az bir ICP `calibration_state='calibrated'`, (c) en az bir orchestrate/harvest koşusu bitti. **Öneri: (b)** — kalibrasyon dead-end fix'i (§4.30) sayesinde artık güvenilir, VE ürünün "yaşayan döngü" felsefesiyle uyumlu (adım 21 sonrası müşteri zaten sürekli geri dönüp yeniden kalibre ediyor — "tamamlandı" mutlak bir kapı değil, akıcı bir eşik).
2. **Dashboard nudge:** `DashboardPage.tsx`'e, eşik geçilmediyse görünen sakin bir banner/kart — "Kurulumunuzu tamamlayın" + `/research`'e CTA. Kalıcı kapatma yok ama saldırgan bir modal/interstitial da değil.
3. **Nav vurgusu:** `Layout.tsx` navItems'daki "Research" öğesine eşik geçilmediyse küçük bir nokta/rozet (Mantine `Indicator`) — metin DEĞİŞMEDEN, salt görsel sinyal.
4. **(Tartışmalı, ayrı karar) `RootRedirect.tsx`'i güçlendirmek:** `hasProject`'i `hasIncompleteProject` eşiğine çevirip HER login'de yarım kurulumu `/research`'e düşürmek — unutmayı imkânsız kılar ama daha agresiftir (müşteri bilinçli CRM'i önce gezmek isteyebilir). **Öneri: şimdilik yapma** — 2-3. madde yeterince görünür kılıyor; şikayet gelirse eklenir.

**Dosya dokunma yüzeyi:** `DashboardPage.tsx` (yeni), `Layout.tsx` (navItems'a Indicator — bu dosyayı WP13 de değiştiriyor, birlikte planlanmalı, bkz. WP13 (c)), `RootRedirect.tsx` (yalnız 4. madde onaylanırsa), locales. Migration muhtemelen GEREKMEZ (mevcut `status`/`calibration_state` yeterli sinyal). **Wizard görsel-yeniden-tasarım diff'i artık commit'li** (`ea1db00`, dikkat: commit mesajı yanıltıcı — bkz. `04_ILERLEME.md §4.34`) — dosya-çakışması engeli kalktı, WP12 başlayabilir.

**Kabul:** yeni tenant login → wizard'a iner (mevcut davranış, değişmez) → adım 5'te ayrılıp `/dashboard`'a git → dashboard'da nudge + nav'da rozet görünür → "Research"e tıkla → wizard tam adım 5'te açılır (flow_state resume, zaten çalışıyor) → kalibre et → nudge/rozet kaybolur.

### WP13 — "Company Knowledge": wizard dışı manuel + AI-promptlu revizyon yüzeyi — ✅ **BİTTİ → SHIP** (2026-07-13, kullanıcı talebi; kapsam aynı gün 4 paralel agent'lı TAM domain denetimiyle genişletildi, kanıt `04_ILERLEME.md §4.33`; implementasyon+3-tur codex review detayı `04_ILERLEME.md §4.35`, commit'ler `7cc9ba5`/`fb27aec`/`689244d` worktree `ssalihyetim/TG-Research-wp12-13`, henüz ana branch'e merge edilmedi)
> Kaynak: kullanıcı talebi (2026-07-13) — "daha önce tanımlanmış bilgi alanları SADECE wizard üzerinden değil company knowledge diye göstereceğimiz bi' alan üzerinden de elle revize ve ai'a promptla revize edilebilir olmalı." + takip şartı: "Bunların hepsi tek tek geliyor mu?... onaylanması, manuel veya AI'ye prompt yazdırarak yeniden düzenlenmesi... Her birinden emin ol, benim düşünmediğim eksik... alan varsa onu da ekle." **Karar (2026-07-13): yüzey `/research/full`'un yeniden çerçevelenmesi olacak, yeni bir route DEĞİL.**

**Wizard'ın 8 veri domain'i tek tek, kod-kanıtlı denetlendi (dosya:satır kanıtları `04 §4.33`):**

| Domain | Adım(lar) | Tek-tek mi? | Onay | Elle düzenle | AI-prompt revize | Wizard-dışı yüzey |
|---|---|---|---|---|---|---|
| Şirket profili | 1-6 | ✅ | ❌ yalnız "İleri" | ✅ (wizard içi) | ❌ | 🟡 kısmi — differentiators/lookalike **HİÇ YOK** dışarıda |
| Ölçek hedefi | 17 | ✅ | n/a | ✅ | n/a | ❌ **hiç yok** |
| HS kodları | 7 | ❌ toplu liste | ✅ aday-başına | ❌ elle ekleme/kod düzenleme yok | ❌ yalnız toplu yeniden-üret | ✅ aynı bileşen + geçmiş |
| Pazar kanıtı | 8 | n/a (bilgi) | n/a (geo onayına gömülü) | ✅ yalnız `market_notes` | n/a (doğru) | n/a (doğru tasarım) |
| Alt-ICP'ler | 8, 14 | ✅ wizard; ❌ full'da grid | ✅ 2-adım CAS | ✅ ama 2 ölü alan (`neutral_signals`,`code`) | ❌ yapısal-only; **not alanı revize'e hiç gitmiyor (bkz. aşağı)** | ✅ ama farklı UX (grid) |
| Kalibrasyon | 11-14 | ✅ wizard; ❌ full'da tablo | ✅ diff her zaman gösterilir | ✅ (puanlama) | ❌ (ICP'yle aynı) | ✅ farklı UX |
| Coğrafya | 8, 10 | ✅ hücreler | ✅ CAS'lı | ✅ zengin (estimate/terms/sinyaller/buyer_titles) | ❌ toplu yeniden-analiz only | ✅ aynı bileşen; **silme YOK** |
| Offer/açı | 15-16 | ✅ | ✅ CAS'lı + red | ✅ zengin | ❌ **hiç yok** (ICP'nin yapısalı bile yok) | ✅ aynı bileşen |

**Çapraz-kesen bulgular (tek tek boşluklardan daha önemli):**
1. **Serbest-metin AI-promptla revizyon SIFIR domain'de var.** WP13'ün asıl işi "birkaç alana ekle" değil "yeteneği ilk kez inşa et, sonra ICP/offer/profil/coğrafya/HS'e bağla."
2. **Bağımsız bug (WP13'ü beklemeden düzeltilebilir):** ICP kartının "not" alanı düzenlenebilir görünüyor ama `icpRevise.ts` bu kolonu hiç seçmiyor — müşteri revizyon için yazdığı yönlendirme AI promptuna sessizce hiç ulaşmıyor. Müşteri "yönlendirdim" sanıyor, aslında hiçbir etkisi yok — bu bir eksiklikten çok, güveni kıran sessiz bir davranış.
3. **"Tek tek" deseni YAMALI:** HS kodları toplu liste; ICP+kalibrasyon wizard'da tek-tek ama `/research/full`'da grid/toplu-tablo'ya dönüşüyor. Company Knowledge tek bir tutarlı deseni (öneri: hep kart-tek-tek) mi dayatsın, yoksa mevcut yamalı deseni mi taşısın — açık karar.
4. **Silme/elle-ekleme boşlukları gerçek:** coğrafya hücresi silinemiyor (kod içinde bilinçli belgelenmiş), HS kodu elle eklenemiyor/düzenlenemiyor. "Elle revize" yalnız "var olanı düzenle" değil, muhtemelen "yanlışı çıkar" + "AI'ın atladığını ekle" de demek.
5. **Sıfır kalıcı yüzeyi olan 3 alt-alan:** profilin differentiators + lookalike_customers/target_markets-ipuçları, ve `scale_target` — wizard dışında şu an müşteriye hiçbir şekilde görünmüyor.
6. **Yeni bir veri domain'i ihtiyacı BULUNAMADI** — mevcut 8 domain satış-hunisi girdisi olarak kavramsal bütünlüğe sahip (`buyer_titles` zaten karar-verici alanını karşılıyor). Eksik olan yeni bir alan değil, yukarıdaki 5 boşluk.

**Kapsam (öncelik sırasıyla, küçükten büyüğe):**
1. **Bağımsız bug-fix (WP13'ten AYRI, hemen yapılabilir):** ICP `note`'unu `icpRevise.ts`'in kolon seçimine + prompt'una ekle.
2. **Sıfır-yüzey 3 alt-alanı `/research/full`'a taşı:** profil differentiators/lookalike + `scale_target` — düşük efor.
3. **Profil bağımsız kaydet** — endpoint zaten var (`PATCH /research/projects/:id`), `ResearchPage.tsx`'e ICP-regen'den AYRI "Kaydet" butonu.
4. **Silme/elle-ekleme boşluklarını kapat:** geo hücre kaldırma (reddet/sil), HS kodu elle ekleme + kod/açıklama düzenleme.
5. **`/research/full`'u "Company Knowledge" olarak çerçevele + linkle** — `Layout.tsx` navItems'a yeni öğe (WP12 ile PAYLAŞIMLI dosya, birlikte planlanmalı), copy/başlık güncellemesi. CompaniesPanel/EnrichmentPanel sekmeleri (sonuç verisi, wizard adım 19-20'de zaten gösteriliyor) knowledge yüzeyinde TEKRARLANMAZ — yalnız profil+ICP+offer+HS Codes+coğrafya (tanımlayıcı veri) odak.
6. **AI-promptla revizyon (asıl büyük iş):** hedef alan + serbest-metin talimat kutusu → mevcut `runLlmJson` kalıbıyla (meter/pricing/COGS-görünürlük AYNEN — bu modülün hiçbir AI çağrısı ölçümsüz geçmiyor, invariant) TASLAK üretir → mevcut onay kalıbıyla (offer'ın `ai_draft`'ı, kalibrasyon revizyon diff'i gibi) müşteri inceler/onaylar — asla sessiz overwrite yok. Sıra: önce ICP/offer'ın serbest-metin alanları (segment/note, pain_hypothesis/value_prop) — ICP için zaten yapısal bir revize deseni var, üzerine inşa edilir; offer'ın hiç yok, sıfırdan; sonra profil; coğrafya/HS'e genişleme sonraya bırakılabilir (yapısal veri ağırlıklı, düşük öncelik).

**Açık ürün kararları (kullanıcı onayı gerekiyor):**
- (a) ~~`/research/full` mü, yeni route mü~~ ✅ **KARAR: `/research/full` yeniden çerçevelenecek** (2026-07-13).
- (b) AI-promptla revizyon hangi alanlarda önce açılsın (öneri: madde 6'daki sıra) ve COGS müşteri kotasından mı düşsün yoksa admin-only setup-cost satırı mı olsun.
- (c) Company Knowledge tek bir tutarlı etkileşim deseni mi dayatsın (öneri: hep kart-tek-tek) yoksa mevcut yamalı deseni mi taşısın.
- (d) Silme/elle-ekleme boşlukları (madde 4) WP13'e dahil mi, ayrı küçük bir dilime mi.

**Dosya dokunma yüzeyi (genişledi):** `ResearchPage.tsx`, `Layout.tsx` (WP12 ile PAYLAŞIMLI), `GeoCellDetail.tsx`/`geographies.ts` (silme), `HsCodeCandidates.tsx`/`hs.ts` (elle ekleme/düzenleme), `icpRevise.ts` (bağımsız bug-fix), yeni AI-prompt-revizyon servis/route(lar), muhtemelen küçük migration(lar) (revizyon geçmişi/COGS — Hunter COGS/mig 103 kalıbı). **Wizard görsel-yeniden-tasarım diff'i artık commit'li** (`ea1db00`, dikkat: commit mesajı yanıltıcı — bkz. `04_ILERLEME.md §4.34`) — dosya-çakışması engeli kalktı, WP13 başlayabilir.

**Kabul:** müşteri `/research`'i tamamladıktan gün(ler) sonra geri döner → profildeki bir cümleyi düzeltir → "Kaydet" (ICP yeniden üretilmez) → yanlış eklenen bir coğrafya hücresini kaldırır → bir HS kodunu elle ekler → bir ICP kartında "AI ile revize et" → serbest metin talimat yazar → taslak görünür → onaylar → `PATCH` ile kaydolur; ICP'nin "not" alanına yazılan yönlendirme artık gerçekten revizyona ulaşır; COGS admin panelde görünür, müşteride görünmez (mevcut K5 invariant'ı).

---

## A-0. VİZYON DEĞERLENDİRMESİ (2026-07-08) → İŞ PAKETLERİ WP1–WP5 — ✅ **TAMAMI SHIP (2026-07-09)**

> **Kaynak:** uçtan uca olgunluk değerlendirmesi (2026-07-08). Hedef son durum: (1) ürün/hizmet + hedef coğrafyayı doğru anlayıp coğrafya-bazlı doğru **sub-ICP** profilleri çıkarmak, (2) her sub-ICP'ye doğru **offer/messaging açısı**, (3) coğrafya bazlı araştırmada **gerçek doygunluk** garantisi, (4) hedef firma × mesaj-açısı eşleştirme. Bulgu: motor/billing/fence katmanı 8-9/10; "akıl katmanı" eksik — ICP coğrafya-körü (geo = harvest-anı serbest metin), sub-ICP kavramı yok, `research_geographies`/`research_chunks`/`research_channels` şema-var-kod-yok, Y3 saturasyon bayrağı default'ta ölü (min 32 sorgu > cap 11) ve persist edilmiyor, offer/messaging katmanı hiç yok (F1 iptal edilmişti), geri-besleme yok.
>
> **Plan revizyonları (bu değerlendirmeyle):** (a) **sub-ICP** kavramı plana eklendi = ICP'nin coğrafyaya *instantiate* edilmiş hali; (b) **F1 iptali revize**: mesaj METNİ TG-Core'da kalır ama **angle haritası + firma-başı kişiselleştirme kancaları research çıktısıdır** (WP4); (c) **geri-besleme** plana eklendi (K8 tek-yön sınır korunur — research CRM'den yalnız AGREGAT okur, research-owned tabloya yazar).
>
> **Sıra: WP1 → WP2 → WP3 → WP4 → WP5.** Her WP: migration (SADECE izole research test DB) + server + client + `tsc -b` + smoke + **codex gpt-5.5 xhigh review** (bloklanırsa Claude ikincil adversarial review) → düzelt → SHIP. Kilitli invariant'lara (04 §5) DOKUNMA: billing ömürde-bir + fenced RPC'ler + suppression>dedup + müşteri dolar görmez. Migration numaraları (gerçekleşen): WP1=084+085+087, WP2=086+090 (088/089 coldcall), WP3=091-094, WP4=096+098 (095/097 linkedin aldı). **WP5→099** (çakışırsa kaydır — paralel oturumlar numara kapıyor, eklemeden önce `ls migrations` kontrol et).

### WP1 — Kalibrasyon döngüsü (plan C1–C2) — ✅ **BİTTİ → codex SHIP** (2026-07-08, detay `04 §4.9`; migrations 084+085+087)

**Amaç:** ölçeklemeden önce (ICP × geo) başına küçük örneklem → insan firma-bazlı "iyi/değil" → LLM'in ICP revizyon önerisi → insan onayı (ruleset bump) → tekrar örneklem → "araştırma mantığı onaylandı". Mevcut ruleset_version CAS + cross-ICP re-score altyapısı bunun için hazır; eksik olan ürün akışı.

- **Migration 083:** `research_company_feedback` (tenant_id, company_id, icp_id, ruleset_version, verdict_id NULL, rating `good|bad`, note, created_by, created_at; RLS user SELECT-only, yazım API service-role tenant-scoped) + `research_icps.calibration_state` (`none|sampling|feedback|revised|calibrated`) + `research_icps.revision_draft` JSONB (LLM önerisi; canlı kolonlara DOKUNMAZ) + `calibrated_at`.
- **Server:** `calibrate:run` job = mevcut harvest spine'ı küçük cap'lerle (örn. maxCandidates=12, maxQueries=6) koşan ince sarmalayıcı — **billing aynen** (MATCH normal faturalanır; trial 50 kredi bunu emer; ömürde-bir invariant'ı bozulmaz). `icp:revise` job = strategy (Opus): girdi ICP + feedback satırları (good/bad + o firmaların evidence/summary'leri) → çıktı `revision_draft` (signals/negative_signals/elimination_rules değişiklikleri + gerekçe). Route'lar: `POST /icps/:id/calibrate`, `POST/GET /icps/:id/feedback`, `POST /icps/:id/revise`, `POST /icps/:id/apply-revision` (draft'ı canlı kolonlara PATCH'ler → mevcut trigger ruleset bump + approved→draft → insan yeniden approve).
- **Client:** ICP kartına "Kalibrasyon" akışı: örneklem tablosu (firma + kanıt + skor) → satır başına 👍/👎 + not → "Revizyon öner" → diff görünümü (mevcut vs öneri) → "Uygula" → yeniden approve → "Tekrar örnekle" → "Mantığı onayla" (`calibration_state='calibrated'`).
- **Kabul:** izole DB'de e2e smoke (örneklem → 2+ feedback → revise → apply → ruleset bump doğrulaması → re-sample'da cross-ICP re-score'un eski firmaları yeni ruleset'te yeniden skorladığı); `tsc -b` temiz; codex review.

### WP2 — Pazar yapısı araştırması → sub-ICP türetme (geo-instantiation) — ✅ **BİTTİ → codex SHIP** (2026-07-08, detay `04 §4.10`; migrations 086+090)

> **KAPANIŞ (2026-07-08):** İlk codex FIX FIRST'ün 3 bulgusu düzeltildi; verify turunda codex 4 yeni/kalan bulgu verdi (2 P1 + 2 P2), onlar da düzeltildi ve ikinci verify **SHIP** döndü. Yapılanlar: (1) approve artık **zorunlu** `updated_at` CAS token'ı ile — spec'i her yazan (PATCH veya fenced RPC) trigger'la `updated_at`'i bump'lar, bayat drawer 409 + `current_updated_at` alır; client token'ı gönderir, iki 409 türünü ayırt eder, PATCH/approve yanıtları react-query cache'e yazılır ve drawer `id:updated_at` ile remount olur (Save→Approve bayat token yarışı kapandı). (2) `research_persist_geo_analysis` doğrudan atama (COALESCE değil) — DB'de `research_geo_persist_projection` migration'ı olarak zaten uygulanmıştı, lokal dosya **090** olarak eklendi (089 coldcall'a gitti). (3) Create route reuse-FIRST; 25-hücre tavanı yalnız gerçek CREATE'e; tavan tetiklenirse aynı-ülke yarışına karşı re-check → reuse. Smoke: geo-smoke.sql ALL_PASS (P1–P4, null-re-analiz projeksiyon temizliği dahil); `tsc -b` server+client temiz.

**Amaç:** her (onaylı ICP × hedef ülke) için kanal yapısını araştırıp ICP'yi coğrafyaya uyarlamak: yerel sinyaller, yerel dil terimleri, yerel eleme kuralları, anahtar kanallar, sertifikalar, alıcı unvanları (persona tohumu), E tahmini. `research_geographies` canlanır.

- **Migration 084:** `research_geographies`'e `spec` JSONB (local_terms[], localized_signals[], localized_negative_signals[], key_channels[], certifications[], buyer_titles[], market_notes), `status` (`draft|approved|rejected`), `human_score`, `notes`, `generated_by_job_id`, `ai_draft` JSONB (ICP kalıbıyla aynı).
- **Server:** `geo:analyze` job: (1) deterministik SearXNG sorgu şablonları (dernek/dizin/fuar/oda + "{sector} distributors {country}" + yerel dil) → ham pazar notları (reading role okur/özetler); (2) strategy role sub-ICP spec üretir → `research_geographies` draft. Onay akışı ICP kalıbıyla aynı (approve route + insan skoru). **Harvest entegrasyonu:** `harvest:run`/`maps:harvest` opsiyonel `geo_id` alır; `buildQuerySpecs`/`buildMapsKeywords` spec'in yerel terim/sinyallerini kullanır (yoksa mevcut davranış — geriye uyumlu). Verdict prompt'una sub-ICP bağlamı eklenir. **Billing bağlantısı YOK:** verdict anahtarı (icp, ruleset_version) olarak kalır — geo spec değişikliği discovery'yi etkiler, fatura semantiğini DEĞİL.
- **Client:** ICP altında "Coğrafyalar" bölümü: ülke ekle → analiz job → sub-ICP kartı (düzenlenebilir + onay) → "Lead bul" artık geo_id ile.
- **Kabul:** 1 ülke için canlı `geo:analyze` smoke (SearXNG $0) + geo_id'li harvest'in yerel terimleri kullandığının doğrulanması; codex review.

### WP3 — Y1 kanal keşfi + liste hasadı + KALICI saturasyon/coverage — ✅ **BİTTİ → codex SHIP** (2026-07-08, detay `04 §4.11`; migrations 091+092+093+094)

> **KAPANIŞ (2026-07-08):** `channels:discover` + `channels:harvest` (mevcut fenced spine'a `channelListSource` olarak takıldı, `source_path='Y1'` + `channel_id` provenance) + kümülatif hücre saturasyonu (Y3 32-sorgu minimumu artık HÜCRE başına; kural-A persist; `fully_covered=A&&B` RPC-içi) + CellCoveragePanel canlı. Review zinciri: 2-lens (1×P1+3×P2) → codex xhigh FIX FIRST (3×P1+2×P2: üye-website kod-içi grounding, chunks DML revoke [094], ICP-genelinde 4-tip harvest guard'ı [harvest/trade/channels/icps-calibrate], SearXNG `complete`-duyarlı round geçerliliği, taze-rol caps) → hepsi düzeltildi → **verify-2 SHIP**. Canlı e2e ×3 geçti (keşif ≥11 kanal → hasat ≥11 üye → coverage persist → 2. Y3 koşusu kümülatif devraldı). **DEPLOY SIRASI: 091-094 hedef DB'ye uygulanmadan server deploy ETME** (p_channel named-arg eşleşmesi tüm upsert'leri düşürür).

**Amaç:** plandaki 🥇 kaynak (dernek/fuar/dizin üye listeleri) gerçekten inşa edilir; doygunluk run-aşırı kalıcı hale gelir; müşteriye coverage görünümü.

- **Migration 085:** `research_channels`'a eksik alanlar (discovery_round, harvest durumu zaten var — kontrol et), `research_chunks`'a kümülatif alanlar: `angle_stats` JSONB (Y3 açı başına koşulan sorgu + yeni-domain sayıları, run-aşırı), `channels_found/harvested`, `n_found`, `estimate` (WP2 E'den), `saturation_a` / `saturation_b` / `fully_covered` persist. Gerekirse `research_update_chunk_coverage()` RPC (service-role; billing'e dokunmaz).
- **Server:** `channels:discover` job (sub-ICP × ülke; çok-dilli keşif şablonları 00 §3 + WP2 key_channels tohumu → SearXNG → reading role kanal sınıflandırır: tip/ad/url/üye-liste-url → `research_channels` upsert, url-dedup; durma kuralı A: tüm keşif açıları koşuldu + son 2 turda yeni kanal yok + kanonik kategoriler kapandı). `channels:harvest` job (üye-liste URL → mevcut `fetch.ts`/Jina → reading role üye firmaları çıkarır (ad+website+şehir) → **mevcut fenced candidate spine** (canonical dedup → validate → verdict → bill), `source_path='Y1'` + `channel_id` ref; websitesiz üyeler domainless `review` park — mevcut yol). **Kümülatif saturasyon:** Y3 stop-condition chunk'ın tarihsel açı istatistikleriyle tohumlanır (`fully_covered` chunk'ta persist; 32-sorgu minimumu artık RUN başına değil HÜCRE başına kümülatif değerlendirilir). Y1 için kural-A durumu chunk'a yazılır.
- **Client:** Coverage görünümü (ICP × geo hücresi): N bulunan / E tahmin, açı kapsaması, kanal tablosu (tip/durum/hasat), doygunluk rozeti (devam/boşluk/bitti).
- **Kabul:** 1 ülke canlı smoke: keşif ≥5 kanal bulur → 1 kanal hasadı ≥10 aday → spine'dan geçer → chunk coverage güncellenir → ikinci run kümülatif istatistiği devralır; codex review.

### WP4 — Offer/angle katmanı + firma-başı hook'lar + export genişletme — ✅ **BİTTİ → codex SHIP** (2026-07-09, detay `04 §4.12`; migrations 096+098)

> **KAPANIŞ (2026-07-09):** research_offers (insan-onaylı açı kartları, MAX 20/ICP + reject yolu) + offer:generate (Opus, kanıt örnekleri suppression/ruleset-filtreli FAIL-CLOSED) + verdict şemasına hooks/angle_suggestion (AYNI reading geçişi, MATCH-only, clamp+hijyen+çifte grounding) + persist_verdict 14-arg (faturalı-match dokunulmazlığı verdict-smoke P1-P10+P10b ile yeşil) + export custom_fields üçlüsü (reddedilen angle 098 ile export'tan düşer). Review zinciri: 2-lens → codex FIX FIRST (1P1+2P2) → verify (1P1+2P2) → düzeltildi → SHIP. Canlı e2e ×2 geçti.

**Amaç:** sub-ICP başına kanıt-bağlı değer önerisi/açı haritası (mesaj METNİ değil — o TG-Core'da) + her MATCH firmaya kişiselleştirme kancaları + hepsinin CRM köprüsünden geçmesi.

- **Migration 086:** `research_offers` (tenant, project, icp_id, geo_id NULL, angle_code, pain_hypothesis, value_prop, proof_points[], objections[], language, status draft/approved, human_score, notes, ai_draft) + `research_company_verdicts`'e `hooks` JSONB + `angle_code` TEXT (NULL) — **`research_persist_verdict` RPC imza güncellemesi DİKKAT: faturalı-match dokunulmazlığı + row-of-record semantiği aynen korunur** (hooks yalnız verdict yazımı anında girer; mevcut satır korunuyorsa dönen satır kazanır). Exportable RPC + export route yeni alanları taşır.
- **Server:** A1 profil formuna **farklılaştırıcılar** bölümü (MOQ, termin, sertifikalar, kapasite, referanslar, diller — profile JSONB'ye yapılandırılmış anahtarlar, geriye uyumlu). `offer:generate` job (strategy role; girdi: profil+farklılaştırıcılar, ICP, WP2 market_notes, örnek MATCH evidence'ları → 3-5 angle draft). `validate.ts` verdict şemasına `hooks[]` (≤3 kısa string: taşıdığı markalar/kategoriler/pazarlar) + onaylı angle listesi verilirse `angle_suggestion` eklenir — **ek fetch/LLM çağrısı YOK** (aynı reading geçişi, birkaç yüz ek çıktı token'ı). Export: custom_fields'a `Research ICP`, `Research Angle` (code + value_prop), `Research Hooks` eklenir.
- **Client:** ICP altında "Offer/Açılar" sekmesi (kart + onay + düzenleme); CompaniesPanel satırında hook/angle chip'leri; export önizlemesinde yeni alanlar.
- **Kabul:** canlı smoke: offer üretimi → approve → küçük harvest'te hooks+angle_suggestion dolu → export'ta custom_fields'ta görünür; faturalı-match dokunulmazlık smoke'u (verdict-smoke.sql) YEŞİL kalır; codex review.

### WP5 — Kampanya geri-besleme agregatı — ✅ **BİTTİ → codex SHIP** (2026-07-09, detay `04 §4.13`; migrations 099+100)

> **KAPANIŞ (2026-07-09) — A-0'IN SON PAKETİ:** feedback:aggregate (günlük idempotent tick + admin run-now; K8 sınırı: CRM salt-okunur+savunmacı) → research_outcome_stats (ICP×geo×açı, yalnız sayılar) + opt-out→suppression senkronu + icp:revise'a ölçülmüş-outcome kanıtı + IcpCard yanıt-oranı rozeti + OffersPanel açı statları. Review zinciri: 2-lens (1P1+3P2) → codex (2P1+3P2) → hepsi düzeltildi → verify SHIP. Smoke paylaşılan-CRM temsilci bug'ını yakalayıp düzelttirdi.

**Amaç:** "doğru offer" iddiasını ölçümle kapatmak. K8 tek-yön sınır korunur: research CRM tablolarını YALNIZ OKUR (READ-ONLY zaten izinli), research-owned tabloya agregat yazar.

- **Migration 087:** `research_outcome_stats` (tenant, icp_id, geo_id NULL, angle_code NULL, period, exported, sent, replies, positive, optouts, updated_at; UNIQUE(tenant,icp,geo,angle,period)).
- **Server:** `feedback:aggregate` job (worker tick günlük + admin "şimdi çalıştır"): `crm_company_id` set olan research firmaları için TG-Core kampanya/yanıt tablolarından (`email-replies`, reply-stats migration 046) SAVUNMACI agregat sorgu → stats upsert. Opt-out senkronu: CRM'de opt-out olan exported firma → `research_suppress_company` RPC (zaten research-owned). `icp:revise` prompt'una (WP1) outcome stats kanıt olarak eklenir.
- **Client:** ICP kartında yanıt-oranı rozeti; offer kartında angle bazlı istatistik.
- **Kabul:** izole DB'de sentetik CRM yanıt satırlarıyla agregat smoke (savunmacı: tablo/kolon yoksa sessiz atlar, job fail etmez); opt-out→suppression akışı doğrulanır; codex review.

---

## A. ÖNCELİK SIRASI (yapılacaklar)

### 0. Maps discovery + M1.5 enrichment — ✅ **BATI TAMAMLANDI** (2026-07-06)

- Gosom servisi Railway'de çalışıyor; worker `RESEARCH_GOSOM_URL` ile Batı `maps:harvest` kaynağına bağlı.
- Migration `075_research_company_maps_enrichment.sql` test research DB'ye uygulandı; `research_companies.phone/address` ve 21 argümanlı `research_upsert_company` doğrulandı.
- NL smoke: 14 aday, 3 şirket, 1 verdict; 3 şirketin tamamında telefon/adres dolu, job başarılı.
- **2GIS/CIS en sona ertelendi:** kod/servis iskeleti hazır fakat `TWOGIS_API_KEY` ve worker `RESEARCH_TWOGIS_URL` ayarlanmayacak.

### 0b. Y2 manuel gümrük CSV ingest + Araştır — ✅ **TAMAMLANDI** (2026-07-07)

- Migration `076_research_trade_ingest.sql` + direct-SELECT kapatan hardening `077`: tenant/project-scoped batch, normalize kalite/review alanları ve şirket bağlantısı test research DB'ye uygulandı.
- Sade müşteri CSV'si (firma, HS/GTIP, tutar, website, ülke, email/tel) + v1 `duzenle.py` içerik kurallı ham gümrük CSV normalizer'ı eklendi.
- UI: **Gümrük Verisi** sekmesi; proje seçimi, preview, kabul/review/red özeti, açık import ve batch geçmişi.
- `trade:ingest` worker satırları `source_path=Y2`, yeni firmaları `review` olarak kütüğe taşır; suppression/fence korunur, mevcut verdict rollup'ı düşmez, **kredi harcanmaz**.
- Ham 5.961 satırlık v1 dosya smoke: 4.460 alıcı adayı, 1.501 alıcısı açıklanmayan satır red. Railway end-to-end smoke: 1 processed + 1 rejected, `review/Y2`, `billed_at=NULL`, billable event=0.
- Migration `078_research_trade_harvest_candidates.sql` + batch'ten seçili ICP ile açık **Araştır** komutu tamamlandı. Veri-only import ücretsiz kalır; **Araştır** normal harvest spine'ında yalnız MATCH için kredi düşer. Smoke: ilk run 1 MATCH / 1 bill / kredi 10→9; aynı batch+ICP rerun 0 candidate / 0 yeni bill / kredi 9'da kaldı.

### 0c. Y3 açık-web 11 açı + saturation — ✅ **CANLI, TUNING DEVAM** (2026-07-07)

- Web `harvest:run` artık v1 framework'teki 11 açık-web açısını deterministic `buildQuerySpecs` ile üretir; future web firmaları `source_path=Y3`.
- Default `maxQueries=11`: her açıdan bir sorgu. Internal ceiling `33`: tam saturation için 3 sorgu/açı koşulabilir; fetch/candidate/spend cap maliyeti sınırlar.
- Job result `source_meta`: `angles_covered`, per-query result/new-domain sayıları, `last_two_new_domains`, `fully_covered`.
- Smoke job: 11/11 açı, 176 raw / 108 unique domain, 1-candidate cap ile 1 MATCH / 1 bill / kredi 9→8; `fully_covered=false` beklenen, çünkü tam saturasyon için >=22 sorgu gerekir.
- Directory/local-language tuning: ülke/dizin bazlı sorgular eklendi (`Wer liefert was`, `wlw`, `Industrystock`, lokal sektör terimleri). Zero-domain koşu artık `fully_covered=true` olamaz; directory + local-language en az 3 sorgu ister.
- SearXNG proxy canlı: Railway `searxng` üzerinde `ROTATING_PROXY` secret var; entrypoint runtime'da geçici settings dosyası üretir, URL scheme eksikse `http://` ekler, credential dosyaya bake edilmez. SearXNG deploy `5f1ae282-e0b5-44f1-8fda-0a93451dfc77`.
- Proxy smoke: iki dahili SearXNG sorgusu da 30 sonuç döndürdü; bazı engine'ler hâlâ intermittently unresponsive/CAPTCHA gösteriyor ama Y3 paid fallback'e düşmedi.
- Full 33-query proxy smoke `f1d4cce6-a1a7-481f-993a-1fec6286d7f0`: 610 raw / 317 unique candidate, tüm 11 açı x3; directory 69 sonuç / 52 yeni domain, local-language 29 / 14; `searchUsd=0`, `totalGroundedQueries=0`, kredi 8→8, 0 yeni bill. `fully_covered=false` çünkü son 2 sorgu hâlâ 9 yeni domain üretti: Alman plumbing pazarı 33 sorguda doymadı.
- Audit smoke `bf39e9c5-76d4-4fba-93ee-8d0e81741db5`: `research_search_log.engine=searxng`, 77 sonuç, `$0` search cost.
- Gemini fallback artık normal empty-result için açık değil; yalnız SearXNG incomplete/error path'inde ve ayrı `gemini-fallback` cache key'iyle çalışır (`RESEARCH_SEARXNG_GEMINI_FALLBACK_ON_EMPTY=1` verilmezse empty fallback yok).
- Codex review bulguları kapandı: Gosom timeout 1-300 clamp, Gosom `web_site` parse, fallback cache reuse, maps query accounting, trade importer kolon önceliği, trade research/rescore flag ayrımı. Son re-review + server/client build temiz. Clean `HEAD` archive worker deploy `8f57a95b-a12b-47b1-a492-dd42d35fd204` canlı.
- **Kalan Y3 tuning:** 2GIS yok; öncelik full saturation kalitesi, directory/local-language kaynak listesini ülke/vertical bazında genişletme ve SearXNG engine miksini proxy ile stabilize etme.

### 1. Pilotu ölçeklendir → gerçek MATCH-başı COGS — ✅ **İLK ÖLÇÜM ALINDI** (2026-06-30)

- LLM usage meter (`llm/meter.ts`) + `temp/scale-pilot.ts` (parametrik ICP×coğrafya, ham token raporu) eklendi; 3 review turu → SHIP. Detay: `04 §4.1`.
- Soğuk run (NL+PL, 6q/30f/40c/$2): **18 MATCH,$/MATCH = $0.034 (grounding$0.007) / $0.045 (grounding$0.014)**. Gemini grounded arama %86. `01 §4.1` (marj + isabet duyarlılığı + kapsam). Büyüklük mertebesi varsayımın altında ama **fiyat-kanıtı DEĞİL** (n=2).

### 1b. Fiyatı kilitlemeden önce — **EN ÖNCELİKLİ (kalanlar)**

- ~~**3 oranı teyit**~~ ✅ **BİTTİ (2026-07-02):** Gemini $2/$12 + grounding $0.014 doğru; DeepSeek in$0.435 / out $0.87 / cache-hit$0.003625. `pricing.ts` **v2** (cache-aware). Yeniden hesap: $/MATCH =$**0.0453** (Gemini %88 / DeepSeek %12). Detay `01 §4.1` + `04 §4.5`. Not: Gemini-3 ailesinde ayda 5.000 ÜCRETSİZ grounding prompt'u — fiyat ücretli orana göre (muhafazakâr).
- ~~**Üretim isabet oranını ölç**~~ ✅ **BİTTİ (2026-07-02):** genişletme pilotu FR (farklı dil, %13) + CZ (seyrek pazar, %35, cross-ICP re-score üretimde doğrulandı) + ES (bulanık MRO ICP'si, %20). **n=5 coğrafya / 2 arketip / 41 MATCH: isabet bandı %13–45 (harman %26), soğuk **$/MATCH$**0.02–0.11 (harman $0.062).** Detay `01 §4.1`. **Fiyat kilidi artık veriyle mümkün** — tier kotaları bandın kötü ucuna ($0.10) göre konabilir.
- **Hariç-tutulan maliyetleri ekle:** ICP-Opus/kurulum (meter'ı ICP handler'ına da tak → admin panelde setup-cost satırı), **başarısız run COGS'u kalıcılaştır** (şu an sadece log — admin panel `failed_runs` sayısını gösteriyor ama dolarını toplayamıyor; job fail path'inde partial usage'ı `result`'a yaz), enrichment (ayrı), direct-fetch bant, QA, ödeme/vergi (§4.1 KAPSAM).

### 1c. COGS kaldıraçları (sırayla — pilot ışığında)

- **Ucuz/koddan:** grounded sorgu sayısını azalt + Gemini çıktı/thinking token'ını kıs (effort/maxTokens). Gemini içinde çıktı ($0.316) > grounding ($0.189).
- **Derin hasat:** keşif run-başına sabit, MATCH'lere amortize (PL $0.022 @14 vs NL$0.076 @4 — **kısmen amortizasyon, kısmen pazar varyansı**); marjinal isabet korunursa birim düşer. Pilotta ikisi de fetch_cap(30)'a takıldı → `RESEARCH_MAX_FETCHES_CEILING` yükselt.
- **Ölçekte self-host arama** (SearXNG/Gosom): grounding ücretini sıfırlar ama proxy/altyapı/yasal/kalite maliyeti getirir — #1 değil, kademeli.

### 2. Kota / tier ENFORCEMENT (pre-run holds) — ✅ BİTTİ (064-066, codex 3 tur → SHIP)

- `research_reserve_hold` (admission, advisory kilit, `available = balance − Σ açık holds`, `LEAST(estimate, available)`, iş başına idempotent) + `research_settle_hold`/`research_release_hold` + `research_available_credits` + `research_release_stale_holds` (reaper). Holds tablosu sadece RPC yazar.
- `research_bill_match` **hold-aware + lease-fenced**: taze charge holdu artımlı tüketir + tükenince reddeder + sert taban backstop; `(job,worker,lease)` ile fence (zombie billing yok); taze charge **hold ŞART** (yapısal); exhaustion `DETAIL='RESERVATION_EXHAUSTED'`.
- Handler run başında rezerve eder, her bill'i fence+hold ile geçer, başarıda settle / hata/abort'ta release; reaper tick stale holdları serbest bırakır. Route'ta `availableCredits < 1 → 402` + `GET /credits`.
- Smoke (3 suite) + canlı pilot (hold={8,3,5}, 50→47) yeşil. Detay: `04_ILERLEME.md` §1/§5, `temp/holds-smoke.sql`.
- **Açık kalan (tier):** şu an reserve "≥1 kredi varsa çalış" + estimate'i `RESERVE_ESTIMATE` (default 25) ile sınırlar. Gerçek **tier kotaları** (paket başına lead, dönemsel reset) bağlanınca reserve estimate'i tier'a göre boyutlandır + bakiye/tier'i grant/reset RPC'lerine bağla.

### 1d. A.3 ikincil-göz review — ✅ TAMAMLANDI + 3 FIX → SHIP (detay `04 §4.2`)

### 1e. Verdict hardening (067-070) — ✅ **BİTTİ** (2026-07-02, detay `04 §4.3`)

- `research_persist_verdict` fenced RPC (row-of-record + faturalı-match dokunulmazlığı, 069'da `verdict_id` ile hassas) + SQL reconciliation + settle/release fence + `research_upsert_company` fence (070, son unfenced yazar) + rollup-repair + ICP başına tek in-flight harvest guard'ı. codex 067-review (4 bulgu → 069) + 14-agent Workflow adversarial review (2 confirmed → 070+repair+guard). `temp/verdict-smoke.sql` 9/9 ALL_PASS; canlı pilot fence zinciriyle yeşil (4 MATCH, 50→46).

### 1f. COGS görünürlük ayrımı + admin marj paneli + companies UI — ✅ **BİTTİ + codex SHIP** (2026-07-02, detay `04 §4.4/4.7`)

- **Kural: admin dolar görür, müşteri ASLA.** 068+072 kolon-grant'ları (DB) + `sanitize.ts` (API: cost alanları + ham error metni) + `freshRole.ts` (60s rol-cache indirme penceresi kapalı, tenant-scoped, fail-closed) + `/api/research/admin/*` (costs/runs/grant, internal-only, idempotent grant) + `/research/admin` UI (marj paneli, Setup $ dahil) + ResearchPage "Lead'ler" sekmesi (CompaniesPanel: kredi rozetleri SAYI olarak, harvest launcher + 409-adoption, verdict-aware tablo). i18n TR+EN. 4 codex turu → **SHIP**.
- **NOT (gelecek oturumlar):** client tip kontrolü için `npx tsc -b` kullan — `npx tsc --noEmit` solution-tsconfig yüzünden NO-OP.

### 3. Mevcut firmayı yeni ICP altında yeniden-skorla (calibration C2) — ✅ **BİTTİ** (2026-06-30, A.3)

- Dedup artık "firma var mı" değil **"(company, icp, ruleset_version) için verdict var mı"** (`companiesWithCurrentVerdict`). Mevcut-ama-verdict'siz firmalar **cached page_cache/site_summary'den** (re-fetch YOK) yeniden skorlanır → verdict → match ise faturalanır (`RESCORE_EXISTING` env, default açık). Detay + billing güvenliği: `04 §4.2`. İkincil-göz review OWED (§1d).

---

## B. CODEX ENGINE REVIEW — bilinçli ertelenenler (pilot-kabul, ölçeklemeden önce ele al)

1. **`maxSpendUsd` sert değil (P0→azaltıldı):** bu **COGS harcama** tarafıdır (faturalanan-lead tarafı değil — o artık holds ile sert: bkz. A.2). Admission sadece mevcut harcamayı kontrol eder; tek bir aday (Gemini+DeepSeek+fetch) cap'i ~bir-aday-maliyeti kadar aşabilir. **Azaltma: `maxAttempts=1`** (retry-respend yok). Tam çözüm: her provider çağrısından önce **worst-case maliyeti rezerve et** / durable per-job bütçe. Ölçeklemeden önce yap.
2. ~~**Cross-ICP re-scoring (P0):**~~ ✅ BİTTİ (A.3 — item 3 + `04 §4.2`); ikincil-göz review + 3 FIX tamamlandı (§1d).
3. **COGS hafif EKSİK sayım:** `runLlmJson` iç retry'leri + thrown-discovery (cost 0) sayılmıyor. Doğruluk sorunu, güvenlik değil. Pilot COGS'u hafif olumlu gösterir — kalibrasyonda telafi et.
4. **search_cache "public-web only" iddiası:** sorgular tenant-türevli (ICP'den). Cache service-role-only (okuma sızıntısı yok) ama yorum yanıltıcı; cache key'e `DISCOVERY_VERSION` eklendi. İstersen sorguyu hash'le sakla / tenant-scope'la.
5. ~~**Verdict persistence hardening (migration 067)**~~ ✅ **BİTTİ** (067/069/070 — §1e, `04 §4.3`). Kalan bilinçli kabuller: (a) in-flight-harvest guard'ı advisory'dir (iki eşzamanlı POST arasındaki mikro yarış kabul — DB invariant'ları güvende, fatura güncel karar satırını izler); (b) başarısız run'ın partial COGS'u hâlâ yalnız log'da (1b'ye taşındı).

> SSRF guard, streamed cap, billMatch-throws, reconciliation, evidence-gate, fetch counting, domainless city, cap tavanları, fence sanitization **YAPILDI** (round-3'te). A.3 re-score fetch-cap/summary-fallback/görünürlük **YAPILDI** (A.3 review'ünde).

---

## C. Henüz hiç bağlanmamış (roadmap)

- ~~**Pre-run quota holds/enforcement**~~ ✅ BİTTİ (064-066 — bkz. A.2).
- ~~**Cross-ICP re-scoring** (A.3)~~ ✅ BİTTİ (`04 §4.2`).
- ~~**Companies UI**~~ ✅ BİTTİ (2026-07-02 — `CompaniesPanel` + ResearchPage sekmeleri + harvest launcher + kredi rozetleri; `04 §4.4`).
- ~~**Tier kotaları**~~ ✅ BİTTİ (2026-07-02, **kullanıcı kararı: Stripe YOK** — `research_tenant_settings` + idempotent `research_apply_period_grants` [worker tick + admin butonu] + tier-bazlı reserve; `04 §4.8`).
- ~~**Başarısız run COGS kalıcılaştırma + ICP-setup meter**~~ ✅ BİTTİ (2026-07-02 — failJob partial result + `failed_cost_usd` özet kolonu + UI; ICP meter 4.5'te; `04 §4.8`).
- ~~**Import to CRM**~~ ✅ BİTTİ (2026-07-02 — `POST /harvest/companies/export`: MATCH → TG Core `companies` (stage cold), 3-katman dedup + korelasyon-anahtarlı geri-bağlama + "CRM ✓" rozeti; `04 §4.8`). Kalan ince uç: kontak/enrichment aktarımı (BetterEnrich fazına bağlı).
- ~~**Y2 gümrük datası veri ingest + Araştır**~~ ✅ Manuel CSV + `duzenle.py` portu + `trade:ingest` + batch → seçili ICP ücretli **Araştır** tamamlandı.
- ~~**Y3 açık-web açıları**~~ ✅ 11 açı + source_meta + Y3 provenance + 33-query proxy smoke canlı. Kalan: full saturation kalitesi ve directory/local-language ülke tuning'i.
- **SearXNG sağlığı** — ROTATING_PROXY canlı ve son smoke'ta paid fallback yok (`searchUsd=0`), ama bazı engine'ler hâlâ CAPTCHA/timeout verebiliyor. Engine havuzu ve Yandex ağırlıklı ülkeler için Yandex arama motoru ayrıca değerlendirilmeli.
- **Playwright JS-render fallback** — Jina pilotu karşılıyor; JS-ağır siteler için sonra.
- **BetterEnrich enrichment** (kişi/karar verici) — **en son öncelik** (`02 §A.8`).
- **AI-destekli mesajlar** (F1, `research_messages`) → TG-Core kampanyalarına handoff. Messaging oluşturmayı iptal ediyoruz. Bunu TG-Core'da yapacağız. **Revizyon (2026-07-08, WP4):** mesaj METNİ TG-Core'da kalır; **angle haritası + firma-başı hook'lar research çıktısıdır** (bkz. A-0 WP4).
- **Import to CRM** — research_companies → TG Core `companies` (aynı DB, importProcessor handoff).

---

## D. KIRMIZI ÇİZGİLER (resume eden herkes için)

- **Prod TG Core'a (`ehnbhkxmsdticaodndvy`) DOKUNMA.** Tüm iş izole test DB `**iehqsuludghrhosgxhnr**`'de. Migration'ı prod'a uygulamadan önce dur/sor.
- **Billing invariant:** ömürde-bir-match, sadece `research_bill_match` RPC. Direkt `billable_events`/`usage_ledger` yazma (service_role'de DML revoke zaten).
- **Suppression &gt; dedup**, registry PII-free, silme billable_events'i silmez (KVKK).
- Sadece research-owned path; CRM/auth/campaign/import READ-ONLY; CRM dosyası silme.
- **Commit etme** — kullanıcı açıkça isteyene kadar. `main`'e dokunma. 2026-07-07 oturumunda kullanıcı `versiyonla` dedi; bu Research diff'i için commit yetkisi açık verildi.
- Her substantive adımdan sonra **codex gpt-5.5 xhigh ile review** (kullanıcı talebi: "ikincil göz kritik").

---

## E. Migration replay notu (prod'a geçerken)

- 060/061/062/063 **boş tabloya** yazıldı. Dolu prod'da:
  - 060 `canonical_key` NOT NULL'a çekmeden ÖNCE app canonicalizer ile backfill gerekir (060 NULL varsa RAISE eder).
  - 061 legacy ICP'leri `source='ai'` + `ai_draft='{}'` etiketler → prod'da `source='legacy'` ile backfill (062 'legacy' değerini ekledi).
  - Codex önerisi: add / backfill / validate olarak **ayrı migration'lara böl**.
- Migration'lar `supabase/migrations/`'da CRM ile paylaşımlı. Research kalıcı ayrı DB olacaksa CRM deploy yolundan çıkar.
