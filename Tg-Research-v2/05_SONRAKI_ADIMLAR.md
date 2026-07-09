# TG-Research v2 — Sonraki Adımlar

Son güncelleme: **2026-07-08** (uçtan uca olgunluk değerlendirmesi → vizyon boşlukları WP1–WP5 olarak plana işlendi; inşa başlıyor). Durum özeti: `04_ILERLEME.md`. Bu dosya **resume için yapılacaklar**.

Mevcut durum tek cümle: **Ana engine/billing/fence zinciri + tier kotaları + COGS görünürlüğü + CRM export + Companies UI tamamlandı; SearXNG web discovery artık ROTATING_PROXY ile Y3 11-açı framework'ünde $0 search COGS ile çalışıyor; Gosom/Google Maps Batı discovery worker'a bağlı; migrations 075-078 test research DB'de smoke ile doğrulandı. 2GIS/CIS kullanıcı kararıyla aktif yoldan çıkarıldı.**

---

## A-0. VİZYON DEĞERLENDİRMESİ (2026-07-08) → İŞ PAKETLERİ WP1–WP5 — **EN ÖNCELİKLİ**

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

### WP5 — Kampanya geri-besleme agregatı

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
