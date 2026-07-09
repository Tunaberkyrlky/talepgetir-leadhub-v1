# TG-Research v2 — İlerleme Günlüğü (build log)

Son güncelleme: **2026-07-09** — **A-0 SHIP + Railway DEPLOY (§4.14) + HUNTER ENRICHMENT WP (§4.15)**. Branch: `ssalihyetim/TG-Research` (worktree).

## 4.15 HUNTER CONTACT ENRICHMENT (kişi/karar-verici) — ✅ **BİTTİ → 3-tur codex zinciri + canlı smoke** (2026-07-09, commit `2d27d85`)

**Kavram:** müşteri MATCH firmalarını seçer → Hunter domain-search → **STRICT domain match** (Hunter'ın döndürdüğü domain ≠ firmanın registrable domain'i ise persist/fatura YOK) → **çok-dilli title bundle** sıralaması (8 bucket × EN/DE/FR/ES/IT/NL/PL/TR; founder_exec/purchasing[einkauf, einkäufer, procurement, satın alma…]/sales/marketing/operations/technical/quality/logistics; müşteri custom kelimeleri hepsinden önce) → firma başına max kişi (1-10, default 3) → **kişi bulunan firma başına 1 kredi, ömürde-bir** (`research_enrichment_events` UNIQUE(tenant,canonical_key) — MATCH invariant'ına AYRI tablo, dokunulmadı). Kredi havuzu ORTAK (`research_usage_ledger`, reason='enrichment').

- **Migration 102** (`research_enrichment`, izole DB'de uygulı): foundation `research_contacts` GENİŞLETİLDİ (job_id/seniority/department/confidence/title_bucket/domain/email_type + partial unique(tenant,company,email) + source CHECK'e 'hunter') + `research_enrichment_events` (RPC-only: PUBLIC+service_role dahil DML revoke) + `research_bill_enrichment` fenced RPC (bill_match kalıbı: per-tenant advisory lock + suppression + lease fence + hold tüketimi + ledger −1; dedup'ta hold'a dokunmaz).
- **Hunter maliyet disiplini:** istek=1 Hunter kredisi → retry YOK, pagination YOK, free-plan `limit≤10` clamp'i (`RESEARCH_HUNTER_PAGE_LIMIT`, canlıda 400 pagination_error ile öğrenildi), run başına `RESEARCH_HUNTER_RUN_CAP` (25), quota/auth reddi döngüyü DURDURUR, already-enriched = 0 istek (bedava skip), bill→insert crash'i = bedava BACKFILL (event-var-kişi-yok → tek istek, dedup fatura).
- **Fatura sırası (codex P1'leri):** Hunter→rank→**tenant-genelinde yenilik kapısı** (müşterinin HİÇBİR yerde olmayan ≥1 e-posta yoksa fatura yok; case-insensitive ilike) → **BILL önce** (suppressed/fenced ret → hiçbir veri kalmaz) → kişi insert. Fresh listesi `hold.reserved`'a clamp'li (rezervsiz Hunter isteği atılamaz); route 402'yi yalnız fresh-chargeable seçimde döner (bedava re-run/backfill kredisiz tenant'ta çalışır); route'ta tenant-mutex (çift enqueue = çift Hunter isteği kapandı).
- **CRM kontak aktarımı:** export artık **self-healing sweep** — CRM'e bağlı TÜM zengin firmaların kişileri TG-Core `contacts`'a kopyalanır (keyset-paginated, e-posta dedup'lu, kontaksız firmanın ilk kişisi `is_primary`; kopya hatası şirket export'unu düşürmez, sonraki export onarır). Yanıt: `contacts_exported`.
- **UI:** ResearchPage "Kişiler" sekmesi — bucket öncelik seçici (tıkla-öne-al), custom kelimeler, max kişi, **maliyet önizlemesi** (seçili N − zaten-zengin M = en fazla X kredi; sayfa ∪ seçim status'u), kişi drawer'ı (domain-match kanıtı + bucket/confidence rozetleri). i18n TR+EN.
- **Review zinciri:** codex xhigh R1 **4×P1+4×P2** (bill-önce-persist, hold clamp, route yarışı, reconciliation faturası; sweep, PUBLIC revoke, cross-page status, sıra UX) → düzeltildi → R2 **1×P1+1×P2** (tenant-wide yenilik, 402 sınıflandırması) → düzeltildi → R3 **1×P2** (case-normalizasyon) → düzeltildi. `temp/enrichment-smoke.sql` **P1-P6 ALL PASS** (fence/once-ever/suppression/lease/exhaustion/null-hold, kendini geri sarar). Canlı smoke ×2 (intercom.io + stripe.com, ~3 Hunter kredisi): 1 istek → 3 personal kişi (founder_exec/technical sıralı) → 1 kredi; re-run → 0 istek/0 fatura. Smoke bulgusu: bare 'president' substring'i "VICE president"i yutuyordu → kelime paketten çıkarıldı.
- **Bilinen sınır (dokümante):** Hunter'ın tüm e-postaları tenant'ta scrape kaynaklı zaten varsa backfill hiç tamamlanmaz (her explicit re-seçimde 1 istek); UI event sayısını gösterdiği için pratikte tekrar seçilmez.

## 4.14 RAILWAY DEPLOY (A-0 build canlıda) — ✅ **BİTTİ → codex PASS** (2026-07-09)

**Sonuç:** worker (`2b0b982b`) + research-api (`05bb9f5e`) Railway'de commit `52569e2` ile CANLI; `/api/health` OK; post-deploy smoke: SQL-enqueue edilen `feedback:aggregate` job'ını deploy edilen worker ~1sn'de `succeeded` işledi (zero-export prune yolu; `crm_read_errors=0`). Yeni handler'lar (channels:discover/harvest, offer:generate, feedback:aggregate, calibrate/geo/icp:revise) canlı registry'de.

- **Ön-koşul doğrulandı:** migrations 090-100 izole DB'de (`research_geo_persist_projection` → `research_outcome_stats_2`) `list_migrations` ile teyit — deploy sırası ihlal edilmedi.
- **Deploy yöntemi:** clean **HEAD archive** stage (`git archive HEAD` → scratchpad) + `deploy/<svc>/railway.json` root'a — çalışma ağacındaki commit'lenmemiş LinkedIn Faz 4 hunk'ları build'e SIZMADI (infra/README §staged-archive; working-tree rsync yerine bilinçli archive).
- **İlk worker deploy'u CRASH etti → 2 kök neden, ikisi de import-zamanı:** (1) LinkedIn Faz 2/3 handler'ları worker grafiğine `lib/linkedin/crypto → middleware/errorHandler → lib/posthog`'u soktu; PostHog keysiz constructor'da assert atıyor → **fix `161d113`**: keyless-safe init (placeholder key + `disabled:true`; keyli süreçlerde davranış birebir). (2) WP5 `feedbackAggregate` CRM client'ını (`lib/supabase`) statik import ediyordu — worker'ın prod-izolasyon sözleşmesini deliyor → **fix `52569e2`**: lazy dynamic import + savunmacı degrade (client yoksa tüm CRM sinyali sıfır, `crm_read_errors=1`; env'li ortamda davranış aynı). İkisi de lokal keyless boot testiyle kanıtlandı ("research worker started"), sonra deploy.
- **Codex xhigh review (iki commit diff'i): GATE PASS, 0 bulgu** — SDK (posthog-node 5.29.2) disabled yolunun gerçek no-op olduğu, lazy cache'in bozuk client yakalayamayacağı, kısmi CRM hatalarının savunmacı kaldığı doğrulandı.
- **Ortam gerçeği (README düzeltmesi):** Railway worker'da `SUPABASE_*` ZATEN set ve **izole test DB'ye** işaret ediyor (prod DEĞİL) — yani canlıda feedback:aggregate degrade değil TAM çalışır; prod cred yok invariant'ı ruhen korunuyor. `POSTHOG_API_KEY` worker'da yok (bilinçli).

## 4.13 WP5 — KAMPANYA GERİ-BESLEME AGREGATI — ✅ **BİTTİ → codex SHIP** (2026-07-09)

**Kavram:** "doğru offer" iddiası artık ÖLÇÜLÜYOR. `feedback:aggregate` (worker; günlük tick + admin run-now) research'ün EXPORT ettiği firmalar (`crm_company_id` set) için TG-Core kampanya sinyallerini okur — `email_replies` (OUT=sent; IN satırlarında label INTERESTED/category positive|meeting_request=positive; category not_interested VEYA label NOT_INTERESTED=opt-out) + `campaign_enrollments` (unsubscribed=opt-out) — ve `research_outcome_stats`'a (ICP × geo × açı) hücreleri + tüm-açılar rollup'ı yazar (period='all', SADECE SAYILAR). **K8 tek-yön sınır:** CRM YALNIZ okunur ve SAVUNMACI (tablo/kolon yoksa o sinyal sıfır sayılır, job düşmez); yazımlar yalnız research-owned tablolara. **Opt-out senkronu:** CRM opt-out sinyali → fenced `research_suppress_company` ('opt_out') — suppression > dedup.

- **Migrations 099+100 (izole DB'de uygulı):** `research_outcome_stats` (UNIQUE NULLS NOT DISTINCT hücre; RLS user SELECT; updated_at trigger) + **100**: `research_tenants_with_exports()` DISTINCT RPC + partial index (günlük tick keşfi satır-hacminden etkilenmez — büyük tenant diğerlerini AÇLIĞA süremez).
- **Handler:** deterministik + idempotent tam-recompute; exported şirketler **keyset-paginated** (sınırsız); CRM okumaları **dedupe'lu id listesi + 200'lük chunk + satır-bazlı .range() pagination** (gateway URL limiti ve PostgREST satır tavanı aşılamaz); açı atıfı ICP'nin **güncel ruleset**'ine filtreli; paylaşılan `crm_company_id` grupları sayıları **BİR KEZ** atfeder (temsilci = açı-taşıyan satır öncelikli, ties id-sıralı); **bayat hücre budaması** (taşınan icp/geo/açı hücreleri silinir — çifte sayım yok; sıfır-export yolu tüm stats'ı budar); suppress RPC per-firma best-effort. Reap loop re-entry guard'lı; günlük tick tenant-başına-UTC-gün idempotent (duplicate-check 200'lük chunk).
- **Entegrasyonlar:** `icp:revise` prompt'una "Measured campaign outcomes" bloğu (toplam + açı bazlı; stripFence'li; okuma hatası eski prompt'a düşer); `GET /icps/:id/outcomes` (yalnız sayılar); IcpCard **yanıt-oranı rozeti** + OffersPanel açı kartlarında **stat satırı**; `POST /admin/feedback/aggregate` run-now (internal). i18n TR+EN.
- **Review zinciri:** 2-lens Workflow (**1×P1**: chunk'suz 5000-UUID .in() → gateway limitinde job ölümü + opt-out senkronunun durması; **3×P2**: 2000-satır tenant taraması açlığı, budanmayan bayat hücreler, paylaşılan crm-id N× sayımı; 3×P3) → hepsi düzeltildi → codex xhigh **Not-SHIP 2×P1+3×P2** (chunk'lar arası duplicate crm-id çifte okuması, satır-paginationsuz CRM okumaları, bayat-ruleset açı atıfı, sıfır-export budaması, tenant-id .in() chunk'ı) → hepsi düzeltildi → **verify: SHIP**.
- **Smoke:** `temp/outcomes-smoke.ts` (deterministik, LLM YOK) ×3 geçti: sentetik CRM satırları → rollup exported=4/sent=3/replies=2/positive=1/optouts=2 + açı hücresi doğru (paylaşılan-CRM temsilci testi smoke'ta **gerçek bir bug yakaladı**: rastgele UUID sırası açısız kopyayı temsilci seçebiliyordu → açı-öncelikli seçim); opt-out→suppression ('opt_out' kaynağıyla, non-optout dokunulmadı); idempotent re-run stabil. tsc server+client temiz.
- **Bilinen sınır (P3, dokümante):** açı/ICP atıfı şirketin GÜNCEL rollup icp_id'siyle — export-anı ICP pinleme (research_mark_exported'a kolon) follow-up.

## 4.12 WP4 — OFFER/ANGLE KATMANI + FİRMA HOOK'LARI + EXPORT GENİŞLETME — ✅ **BİTTİ → codex SHIP** (2026-07-09)

**Kavram:** `research_offers` = ICP başına insan-onaylı **outreach açı kartları** (angle_code slug + ağrı hipotezi + değer önerisi + kanıt noktaları + itirazlar — mesaj METNİ DEĞİL, o TG-Core'da). `offer:generate` (strategy/Opus, ~$0.05) profil+farklılaştırıcılar+ICP+geo pazar notu+GERÇEK match kanıtlarından 3-5 taslak üretir → müşteri düzenler + /10 onaylar (ICP/geo insan-kapısı; approve `updated_at` CAS'lı). **AYNI reading-role validasyon geçişi** artık MATCH firmalara `hooks[]` (≤3 sayfa-temelli kişiselleştirme kancası) + `angle_suggestion` (yalnız ONAYLI kodlardan) yazar — **ek fetch/LLM çağrısı YOK**. Export custom_fields: `Research ICP` / `Research Angle` (kod — value_prop) / `Research Hooks`.

- **Migrations 096+098 (izole DB'de uygulı):** `research_offers` (tenant RLS + updated_at trigger + UNIQUE (tenant,icp,lower(code))); verdicts +`hooks` JSONB +`angle_suggestion`; **`research_persist_verdict` 12→14 arg** — faturalı-match erken-dönüşü HER yazımdan önce (dokunulmazlık aynen; verdict-smoke **P1-P10** ALL_PASS: hooks faturalı satırı mutasyona uğratamaz, re-persist hooks'u whole-replace eder, non-array reddi); export RPC genişledi + **098**: angle yalnız hâlâ-onaylı offer join'inde export edilir (reddedilen kod CRM'e sızamaz — P10a/P10b smoke).
- **Server:** `offers/{schema,prompt}.ts` (noFence + slug regex; UNTRUSTED fence'li kanıt/pazar-notu; existingCodes slice(0,40)), `offerGenerate.ts` (approved-ICP şartı; kanıt örnekleri **güncel ruleset + suppressed=false + registry FAIL-CLOSED** filtreli; tavan defense-in-depth + insert-loop **hard clamp** — taşma imkânsız, skipped_ceiling raporlanır), `validate.ts` (verdictSchema +hooks/+angle — hooks preprocess'te **CLAMP edilir, reddedilmez**: advisory alan ücretli geçişi asla düşüremez; `hardenPersonalization`: **MATCH-only** + kod onaylı-listede + hook token-grounding + hijyen [fence/URL/email/pipe nötralize]; evidence-gate ÖNCE koşar), `ledger.ts` persistVerdict passthrough, `harvestRun` onaylı açı haritasını deterministik okur (ORDER BY + limit 10). `harvest.ts` /companies hooks+angle döner; export custom_fields üçlüsü (yalnız doluysa; hooks 'untrusted-derived' uyarısı yorumda).
- **Routes/Client:** `offers.ts` (generate [in-flight adopt + kredi kapısı + **MAX_OFFERS_PER_ICP=20** + tüm echo'lar sanitize + taze-rol], list, PATCH [content-edit→draft; **rejected reaktivasyonu tavan-kapılı**], approve [CAS + rejected reaktivasyonu tavan-kapılı], **reject** [slot boşaltır, kod rezerve kalır]); OffersPanel (kart düzenle/onayla/reddet + job poll) + ResearchPage "Offer açıları" sekmesi; CompaniesPanel satırlarında angle+hook chip'leri. i18n TR+EN.
- **Review zinciri:** 2-lens Workflow (correctness SHIP 3×P3 / security FIX_FIRST 1×P2+2×P3 → hepsi düzeltildi: match-only, hook hijyeni, clamp, ORDER BY, slice, tavan) → codex xhigh **FIX FIRST 1×P1+2×P2** (kanıt örneklerinde suppression/ruleset filtresi yok; tavan 16-19'dan 24'e taşabiliyor; reject yolu yok) → düzeltildi → **verify: 1×P1+2×P2** (registry okuması fail-open; rejected reaktivasyonu tavansız; export'ta reddedilmiş kod) → düzeltildi (098) → **verify-2+3: SHIP**.
- **Smoke:** verdict-smoke **P1-P10 + P10b** yeşil (izole DB); **canlı e2e ×2** (`temp/offers-smoke.ts`): 5 grounded açı ($0.05 Opus) → 2 onay → harvest'te **2/2 MATCH verdict hooks+angle taşıdı, non-match satırlar temiz** (match-only kapı canlıda), angle grounding onaylı kodlara sadık; exportable RPC satırları icp_name/hooks/angle_value_prop taşıdı; SearXNG internal-only olduğundan discovery Gemini fallback ($0.014/sorgu) ile koştu. tsc server+client temiz.


## 4.11 WP3 — Y1 KANAL KEŞFİ + LİSTE HASADI + KALICI SATURASYON — ✅ **BİTTİ → codex SHIP** (2026-07-08)

**Kavram:** `research_channels` canlandı (🥇 Y1): `channels:discover` bir ONAYLI sub-ICP hücresi için çok-dilli şablonlarla (00 §3, geo spec'in yerel terimleri + kanal tohumuyla) SearXNG'yi tarar ($0), reading role sonuçları firma-listesi kanallarına sınıflandırır (URL'ler yalnız sunulan sonuçlardan — grounding filtresi) → hücre-bazlı URL-dedup ile upsert. `channels:harvest` TEK kanalın üye listesini `fetchPage`(48k bütçe) + reading role ile çıkarır → **mevcut fenced spine** (dedup → validate → verdict → bill; `source_path='Y1'` + `channel_id` provenance, 092). `research_chunks` = hücrenin KÜMÜLATİF kapsama kaydı: Y3 saturasyonu artık hücre-bazında run-aşırı (32-sorgu minimumu kümülatif), kural-A (liste doygunluğu) persist; `fully_covered = A && B` RPC İÇİNDE hesaplanır (093).

- **Migrations (izole DB'de uygulı):** **091** kanal harvest bookkeeping + hücre-URL unique + chunk kümülatif kolonları (`angle_stats`/`queries_total`/`saturation_a+b`/`channels_found+harvested`/`discovery_rounds_no_new`) + fenced `research_update_chunk_coverage` (lease fence, DB-içi atomik açı-merge, NULL=dokunma partial semantiği). **092** fenced `research_upsert_company` +`p_channel` (22 arg; COALESCE — kanal-dışı run mevcut ref'i silmez; cross-tenant kanal reddi). **093** `fully_covered` RPC-içi A&&B (caller'ın bayat okuması tutarsız çift yazamaz; p_fully_covered yok sayılır). **094** `research_chunks` DML revoke (service_role dahil) — coverage RPC yapısal tek yazıcı.
- **Server:** `channels/{schema,prompt,discovery,coverage}.ts` (zod noFence + boş-string→undefined normalizasyonu [canlı DeepSeek davranışı]; UNTRUSTED fence'li promptlar; 8-kategori round-robin sorgu şablonları; kural-A değerlendirici + fenced RPC sarmalayıcı), `channelsDiscover.ts` (round-bazlı; **degrade tur** [SearXNG outage → `complete:false`] rounds_no_new'ü İLERLETMEZ + angles-run İDDİA ETMEZ), `channelsHarvest.ts` (**partial-run ≠ harvested**: `stopped_by` doluysa kanal `pending` kalır + stop notu; unreachable ayrı; `harvest_error` TEK yazım noktasında `sanitizeJobError`'dan geçer), `channelListSource` (CandidateSource; üye website'i **kod-içi grounding** — sayfa metninde geçmeyen domain domainless'a düşer; junk-domain koruması), `sources.ts` kümülatif `y3FullyCovered` (prior seed + **sıfır-sinyal asla doyurmaz**: uniqueDomains 0 bail + son-2 pencerede sonuçlu sorgu şartı), `harvestRun.ts` chunk prior yükleme→`priorStats` + koşu sonu coverage persist (advisory, asla run'ı düşürmez) + `channelId` passthrough, `fetch.ts` **store/return clip ayrımı** (cache 48k saklar, default dönüş 12k; kısa-cache'li satıra uzun-bütçeli okuma → bypass+refetch).
- **Routes:** `routes/research/channels.ts` — discover (approved cell + kredi kapısı + **saturasyon 409 kapısı** [non-internal] + in-flight adopt), list, coverage, `:id/harvest` (**ICP-genelinde 4-tip in-flight guard** — harvest/trade/icps-calibrate listeleri de CHANNELS_HARVEST içerir; <24h re-harvest 409 [non-internal]; caps yalnız **taze** `effectiveCostRole` internal ise parse). **Tüm job echo'ları `sanitizeJobForRole`** (068 kuralı — adopt edilen internal job'ın caps'i müşteriye sızmaz).
- **Client:** GeographiesPanel drawer'ına `CellCoveragePanel` (onaylı hücrede): N/E + sorgu + kural-A/B rozetleri + fully-covered, kanal tablosu (tip/durum/üye/hasat butonu), keşif butonu; 7s poll. i18n TR+EN (`research.channels.*`).
- **Review zinciri:** 2-lens Workflow (correctness+billing / security+injection+tenancy) → **1×P1+3×P2+5×P3 düzeltildi** → codex gpt-5.5 xhigh → **FIX FIRST 3×P1+2×P2** (üye-website grounding, chunks DML revoke, ICP-guard genişletme, complete-aware roundValid, taze-rol caps) → düzeltildi → verify: 1 kalan P1 (icps calibrate guard) → düzeltildi → **verify-2: SHIP** (4 guard birebir doğrulandı).
- **Smoke:** `temp/coverage-smoke.sql` ALL_PASS P1-P6 (fence, kümülatif merge, NULL partial, **RPC-içi fully_covered A&&B + regress**, unique hücre, tip reddi); 092 channel-ref smoke ALL_PASS P1-P3; `temp/verdict-smoke.sql` **P1-P9 YEŞİL KALDI** (faturalı-match dokunulmazlığı 092 sonrası). **Canlı e2e ×3** (`temp/channels-smoke.ts`, yarışsız fenced job'larla — Railway worker'ın eski deploy'u queued job'ı kapıp düşürmüştü): keşif 11-22 kanal/$0.004-0.007 → hasat 11-12 üye spine'dan → chunk coverage persist → ikinci Y3 koşusu kümülatif devraldı (queries_total 0→2→4, `cumulative_seeded=true`); Δkredi 0; test verisi temizlendi. tsc server+client temiz (paralel oturumun linkedin WIP hataları hariç).
- **DEPLOY NOTU (kritik sıra):** kod `p_channel`'ı her zaman gönderir — **091+092+093+094 hedef DB'ye uygulanmadan bu server build'i deploy edilirse TÜM upsert'ler düşer** (PostgREST named-arg eşleşmesi). Önce migration, sonra deploy.

## 4.10 WP2 — PAZAR YAPISI → SUB-ICP (geo-instantiation) — ✅ **BİTTİ → codex SHIP** (2026-07-08)

**Kavram:** `research_geographies` = SUB-ICP hücresi (ICP'nin tek ülkeye instantiate hali: yerel dil terimleri, lokalize sinyaller, kanal listesi [WP3 tohumu], sertifikalar, alıcı unvanları, pazar notu, E tahmini + güven). `geo:analyze` (Opus + opsiyonel $0 SearXNG kanıt taraması) taslağı üretir → müşteri düzenler + /10 onaylar → harvest `geo_id` ile koşar: engine yerel terimleri sorgu üretiminde, lokalize işaretleri validasyon bağlamında kullanır. **Billing bağlantısı YOK** (verdict anahtarı (icp, ruleset_version) kaldı); geo_id'siz harvest davranışı birebir eskisi gibi.

- **Migration 086**: geographies'e `spec`/`ai_draft`/`generated_by_job_id` + UNIQUE (tenant, icp, lower(country)) + fenced `research_persist_geo_analysis` (lease fence + approved→draft demote + kolon projeksiyonu).
- **Server**: `geo/schema.ts` (zod; `<<<` fence-marker reddi dahil), `geo/prompt.ts` (UNTRUSTED fence + url-uydurma yasağı), `geoAnalyze.ts` handler (meter'lı, SearXNG çökük olsa da job düşmez), `routes/research/geographies.ts` (create-or-reuse [analizli hücreyi SESSİZCE ezmez — reused+job:null döner], /analyze [in-flight adopt + 402 kredi kapısı], PATCH [spec→draft demote + estimate/confidence/rationale kolon projeksiyonu], approve [spec şart], **MAX 25 hücre/ICP**), harvest route+worker `geo_id` (approved + ICP eşleşme şart; **hücrenin ülkesi = coğrafya, serbest metin yok sayılır**), `sanitize.ts` geography-hatası dalı.
- **Engine**: `buildQuerySpecs(icp, geo, max, geoSpec?)` — ≥2 yerel terim localSectorTerms'i değiştirir + hücre dizinleri directory açısına eklenir; `buildMapsKeywords` yerel terimleri LEAD anahtar kelimeden hemen sonra sıralar (küçük cap kesemez); `validate.ts` lokalize işaretleri **stripWebFence'li + DATA-etiketli** render eder (web-türevli string verdict prompt'unda talimat olamaz).
- **Client**: GeographiesPanel (hücre tablosu + analiz + detay drawer'da spec düzenleme/onay) + ResearchPage "Coğrafyalar" sekmesi + CompaniesPanel launcher'da onaylı hücre seçimi (serbest metin fallback). i18n TR+EN.
- **Review**: 2-lens Workflow (2×P2 + 8×P3, İKİSİ DE SHIP) → 10 bulgunun hepsi düzeltildi (yukarıdaki parantezler). **codex gpt-5.5 xhigh: FIX FIRST (1×P1+1×P2+1×P3)** → üçü de düzeltildi: (P1) approve **CAS** — client `updated_at` token'ı gönderir, UPDATE `.eq` eşleşmezse `current_updated_at` taşıyan 409 (needSpec-409'dan yapısal ayrım); drawer key `id:updated_at` (ekrandaki spec ile CAS token'ı hep aynı satır nesli) + save/approve dönen satırı cache'e yazar (Save→Approve hızlı ardışıklığı post-save token'la CAS'lar). (P2) migration **090** `research_persist_geo_analysis` projeksiyonu COALESCE→doğrudan atama (geçerli `estimate:null` re-analizi bayat kolon bırakmaz); test DB'ye uygulandı. (P3) exact-match **reuse tavandan ÖNCE** — 25-hücre tavanı yalnız gerçek CREATE'e; 23505 dalı yarış için korunur. **verify: 2×P1+2×P2** → kapatıldı (CAS token artık **ZORUNLU** — endpoint'in legacy caller'ı yok, `updated_at`'sız approve 400; tavan tetiklenirse aynı-ülke yarışına **re-check→reuse**, 409 yalnız gerçekten yeni ülkeye) → **verify-2: SHIP**. Paralel bağımsız ikinci verify de SHIP (2 advisory P2 bilinçli kabul: 23505 fallback'inin nadir yarışta çift DB turu + updated_at-remount'un kaydedilmemiş taslağı düşürme UX riski — güvenlik > taslak).
- **Smoke**: `temp/geo-smoke.sql` ALL_PASS **P1-P4** (case-insensitive unique hücre, fence + persist + approved→draft, **null re-analiz projeksiyon temizliği [090]**, non-object spec reddi); `temp/geo-smoke.ts` canlı Opus e2e GEÇTİ (Almanya: 11 gerçek yerel terim, 10 kanal, 5 dizin, E=1500 conf 0.5, $0.063 COGS; buildQuerySpecs yerel terimi kullanıyor). Test verisi temizlendi. server tsc + client `tsc -b` + eslint temiz (fix sonrası yeniden doğrulandı).

## 4.9 WP1 — KALİBRASYON DÖNGÜSÜ (C1-C2) — bitti ✅ → codex SHIP (2026-07-08)

**Ürün akışı:** onaylı ICP × coğrafya için küçük örneklem harvest'i (server-forced caps 6q/18f/12c, normal fenced billing — trial emer) → müşteri firma başına 👍/👎 + not → `icp:revise` (Opus, strategy role) geri bildirimden 4 ruleset dizisinin TAM replasman revizyonunu önerir → müşteri diff'i görüp uygular (062 trigger bump + approved→draft) → yeniden onay → yeniden örneklem → "mantığı onayla" (`calibrated`).

- **Migration 084**: `research_company_feedback` (UNIQUE (tenant,icp,company,ruleset), user SELECT-only) + ICP kolonları (`calibration_state/revision_draft/revision_job_id/calibrated_at`) + fenced `research_persist_icp_revision`. **085**: RPC `p_base_ruleset` bağlama (DETAIL=`RULESET_MOVED`) + calibrated-terminal (DETAIL=`CALIBRATED`) + trigger taslak temizliği. **087**: trigger ruleset değişiminde kalibrasyonu SIFIRLAR (state='none', calibrated_at=NULL — kanıt per-ruleset).
- **Server**: `icp:revise` handler (icpGenerate kalıbı: meter + partial-COGS catch; feedback 400-pencere + kırpılma bayrağı + no-op guard; `maxAttempts:1` = job id ↔ tek proposal). 6 endpoint: calibrate (kredi kapısı + in-flight guard + sanitized echo) / feedback GET+POST (**ruleset CAS**: puanlanan versiyona sabitli, 409'da yeniden puanlama) / revise / apply-revision (**çift CAS**: ruleset_version + revision_job_id; no-op reddi) / mark-calibrated (kanıt kapısı ≥1 feedback + approved+version+no-pending-revision hepsi UPDATE içinde CAS).
- **Client**: `CalibrationDrawer` (4 adım: örneklem → değerlendirme → revizyon diff'i → tamamla; `ratingsVersion` pinleme — 409 sonrası bayat batch yeniden gönderilemez), IcpCard rozet+buton, i18n TR+EN.
- **Review zinciri**: 2-lens Workflow review (1×P2+7×P3 → düzeltildi) → **codex gpt-5.5 xhigh: FIX FIRST (5×P1+1×P2)** → hepsi düzeltildi → **verify: 4 FIXED + 2 eksik** → kapatıldı → **verify-2: SHIP**.
- **Smoke**: `temp/calibration-smoke.sql` ALL_PASS P1-P6 (unique, lease fence, RULESET_MOVED/CALIBRATED refusal, persist-no-bump, apply bump+draft+kalibrasyon sıfırlama, state CHECK); `temp/calibration-smoke.ts` canlı Opus e2e GEÇTİ (fenced seed → feedback → revise: 6 izlenebilir değişiklik, $0.044 COGS → apply bump). Test verisi temizlendi.

> Bu dosya "şu an ne var" özetidir. Kararlar `02_ACIK_KONULAR.md`'de, mimari `00_MIMARI_PLAN.md`'de, fiyat `01_KREDI_FIYATLAMA.md`'de, alıcı değerlendirme `03_...`'te. Sonraki adımlar `05_SONRAKI_ADIMLAR.md`'de.

---

## 0. DB izolasyonu (ÖNEMLİ)

- Bu worktree **izole test DB**'sine bakar: Supabase projesi **`iehqsuludghrhosgxhnr`** (TG-Core-coldcrm-test, TG-Core'un tam klonu — `tenants`/helper'lar var).
- **Prod TG Core `ehnbhkxmsdticaodndvy` temiz** (sıfır `research_*` satırı). Migration'lar prod'a UYGULANMADI.
- Test tenant: `11111111-1111-1111-1111-111111111111` (Tenant A). Smoke'lar bunu kullanır + sonrası temizlenir.
- `.env` (`SUPABASE_URL`/ANON + `VITE_*` + service key) test DB'ye repoint edilmiş.

---

## 1. Veritabanı (migration 055–066, hepsi test DB'ye uygulandı)

- **055** foundation: `research_projects`, `research_jobs` (Postgres kuyruğu), `research_usage_ledger`, `research_usage_holds`, `research_claim_job()`, `research_reap_stale_jobs()`.
- **056** ICP/market: `research_hs_codes/markets/icps/geographies/channels/chunks`.
- **057** companies: `research_companies` (dedup kütük), `research_contacts/trade_imports/messages`, `research_search_cache`.
- **058/059** kuyruk RPC revoke + jobs INSERT/UPDATE policy drop (queue = service-role state machine).
- **060** sertleştirme-1: `canonical_key` (dedup+billing birimi), `research_company_verdicts` (per-ICP verdict + `ruleset_version`), `research_search_log` (COGS) + `research_page_cache`, `research_billable_events` (once-ever guard), `research_suppression` + trigger, **`research_bill_match()`** RPC, fair `research_claim_job`.
- **061** ICP eval: `research_icps.ai_draft` + `source` + `generated_by_job_id`.
- **062** sertleştirme-2 (codex round-1, 11 bulgu): tüm research tablolarında **user clients SELECT-only**; billing tabloları (`billable_events`/`usage_ledger`) DML service_role'den dahi revoke → **sadece SECURITY DEFINER RPC'ler yazar**; yeni RPC'ler `research_grant_credits` / `research_credit_balance` / `research_upsert_company` / `research_suppress_company` — **hepsi aynı `pg_advisory_xact_lock('research_bill:'||tenant)` kilidini** alır (suppress-vs-bill + insert-vs-suppress TOCTOU kapandı); bill RPC artık verdict'in ICP'si **approved VE `verdict.ruleset_version = icp.ruleset_version`** olmasını şart koşar; `research_icps_ruleset_guard` trigger atomik version bump + approved→draft; kuyruk **lease** fencing; suppression contact key = sha256 hex CHECK.
- **063** sertleştirme-3 (codex round-2 doğrulaması): bill RPC `FOR UPDATE OF v,c,i` + `v.tenant_id` pin (ICP satırını da kilitle); `research_upsert_company` preserve-on-NULL (`p_*` kullan, `EXCLUDED` değil — EXCLUDED default sonrası) + project/icp/geo ref tenant doğrulama; `research_grant_credits` idempotent (`ON CONFLICT DO NOTHING`, UUID `p_ref_id` anahtarı); **`research_persist_icp_drafts`** = fenced atomik delete+insert `(job,locked_by,lease)`; approve = `ruleset_version` **CAS**.
- **064** kota tutmaları (pre-run quota holds, 05 §A.2 / D3-D4): `research_usage_holds` artık **sadece RPC yazar** (service_role'den de DML revoke). Yeni RPC'ler — hepsi aynı `research_bill:'||tenant` advisory kilidini alır: `research_reserve_hold` (admission; `available = balance − Σ açık holds`; `< min_required` ise **check_violation** ile reddet; `LEAST(estimate, available)` rezerve; iş başına idempotent), `research_settle_hold`/`research_release_hold` (kapat + kalanı serbest bırak), `research_available_credits` (UX/route okuması), `research_release_stale_holds` (çökmüş worker'ın takılı holdunu serbest bırakan reaper). `research_bill_match`'e **sert taban**: taze bir charge bakiyeyi 0'ın altına itemez (event INSERT'i geri sarar; `check_violation` → wrapper'da null).
- **065** holds sertleştirme-1 (codex round-1, 2×P0+3×P1): `research_bill_match` artık **hold-aware + lease-fenced** — taze charge holdu **artımlı tüketir** (`settled += 1`, ledger decrement ile atomik) ⇒ `available` run boyunca **sabit** (P0#1: mid-run negatif yok); hold tükenince **reddeder** (DB cap'i uygular, lokal sayaç değil); `(job, worker, lease)` verilirse reaped/reclaimed attempt **fence'lenir** (P0#2: zombie billing yok). `settle/release` artık sayaç almaz (kalan = `reserved−settled`). Reaper `pg_try_advisory_xact_lock` + sıralı (P1: deadlock yok).
- **066** holds sertleştirme-2 (codex round-2 doğrulaması, 1×P0+1×P1+1×P2): taze charge **yapısal olarak hold ŞART** (`p_hold_id` null ise RAISE) + job-attributed charge `worker+lease` ŞART (P0: default-NULL ile bypass kapandı); lease fence artık `FOR UPDATE` ile job satırını kilitler (P1: reap/reclaim'e karşı atomik, TOCTOU kapandı); exhaustion artık `DETAIL='RESERVATION_EXHAUSTED'` **yapısal işaret** taşır (P2: İngilizce mesaj eşleme yerine `error.details`).
- **067** verdict sertleştirme-1 (codex A.3 deferral'ları): **`research_persist_verdict`** fenced atomik RPC — (job,worker,lease) YAPISAL ŞART (unfenced verdict yazarı yok), advisory kilit + job `FOR UPDATE` lease fence + suppression-under-lock + **faturalanmış-MATCH dokunulmazlığı** (charge'ın dayandığı satır ezilmez, mevcut satır döner → caller DÖNEN satırdan sayar/faturalar); **`research_unbilled_match_verdicts`** SQL anti-join reconciliation (bounded 500, PostgREST satır-tavanı riski bitti); **settle/release lease-fenced** (job-attributed hold'u yalnız leaseli attempt kapatır; jobless/ops hold fence'siz; eski 1-arg formlar DROP).
- **068** COGS görünürlük ayrımı (ürün kuralı: **admin dolar görür, müşteri ASLA**): kolon-seviyesi grant'lar — `research_jobs` SELECT'i authenticated'a `result`+`payload` HARİÇ yeniden verildi (result=cost breakdown, payload=caps.maxSpendUsd); `research_search_log` müşteri SELECT'i tamamen kaldırıldı; `research_billable_events` `amount_usd`+`pricing_version` hariç; **`research_admin_cost_summary()`** cross-tenant marj RPC'si (service_role-only).
- **069** verdict sertleştirme-2 (codex 067 review'ü, 1×P0+1×P1+2×P2): verdict tablosu DML'i **service_role'den de revoke** (RPC-only, 062 kalıbı); reconciliation suppressed match'leri filtreler (batch starvation bitti); suppression refusal'ları **yapısal DETAIL** taşır (`SUPPRESSED`/`SUPPRESSED_OR_MISSING` — score CHECK'i suppression sanılamaz); `research_billable_events.verdict_id` kolonu + bill RPC yazar → **dokunulmazlık HASSAS** (yalnız charge'ın gösterdiği satır donar; legacy NULL event = muhafazakâr canonical-key freeze).
- **070** rollup yazarı fence'i (Workflow 14-agent adversarial review bulgusu): **`research_upsert_company` (job,worker,lease) ŞART** + atomik lease fence — son unfenced yazar kapandı (park path'leri artık zombie'de hiçbir şey yazamaz); suppression refusal DETAIL='SUPPRESSED'.

**Smoke ile doğrulandı** (self-rollback sentinel, test DB): bill-once, draft/stale-ruleset reddi, ruleset trigger, suppress>dedup, grant idempotency, preserve-on-NULL, cross-tenant ref reddi, lease fence. Smoke sırasında yakalanan **3 gerçek bug** düzeltildi: `SUM(delta)` bakiyesi (son-satır okuma değil — txn içi `created_at` eşitliği random-uuid tiebreak), `EXCLUDED` yerine `p_*` ile preserve, boolean-vs-int ROW_COUNT.

**Holds smoke ile doğrulandı** (3 ayrı self-rollback suite, test DB): reserve-caps-to-available + idempotent reserve + 0-bakiyede reddet; bill-to-reserved; **sert taban + orphan-event yok + dedup taban-muaf**; settle/release (`released = reserved − settled`); reaper. Round-1 fix sonrası: **consume artımlı → `available` run boyunca sabit (mid-run negatif yok)**, DB-enforced exhaustion, **lease fence (yanlış lease engelle / doğru lease bill)**, dedup hold tüketmez. Round-2 fix sonrası: **hold ŞART (hold-less taze charge reddi)**, worker+lease ŞART, atomik `FOR UPDATE` fence, `DETAIL='RESERVATION_EXHAUSTED'` (PG_EXCEPTION_DETAIL ile doğrulandı). Holds smoke ilk turda yakaladığı gerçek bug: `SELECT sum(...) FOR UPDATE` yasak (aggregate+lock) → reserve advisory-kilit serileştirmesine güvenir (ledger SUM'ları gibi).

---

## 2. Sunucu kodu (`server/src/lib/research/` + `routes/research/`)

- **LLM router** (`llm/`): ROLE→provider. strategy=Claude Opus 4.8, search=Gemini 3.1 Pro (grounding), reading=DeepSeek V4 Pro. `runLlm` / `runLlmJson`. grounding⊻JSON ayrı.
- **Queue** (`queue.ts`): enqueue/claim/heartbeat/complete/fail — **lease fencing** (per-attempt UUID, complete `boolean` döner). Worker `worker/runner.ts`.
- **ICP Master (B5)** dikey dilim: `icp/{schema,prompt}.ts`, handler `worker/handlers/icpGenerate.ts` (`icp:generate`, fenced `research_persist_icp_drafts` RPC ile persist), route `routes/research/icps.ts` (generate→202, list/get/PATCH/approve-CAS). Client: `pages/research/ResearchPage.tsx` + `components/research/IcpCard.tsx`. **Gerçek Opus ile e2e geçti.**
- **Engine (Y1 list-harvest)** — `lib/research/engine/`:
  - `canonical.ts` — `canonical_key` = eTLD+1 (`tldts` deps) / domainless `name|country|city`, ß→ss translit. 18 unit test geçiyor (`temp/canon-test.ts`).
  - `pricing.ts` — COGS oranları (env-override, `pricing_version=v1`). **Oranlar varsayımsal** — pilot faturasıyla kalibre edilecek.
  - `caps.ts` — `CapTracker` (maxQueries/Fetches/Candidates/SpendUsd, env tavanlar; default spend $5).
  - `discovery.ts` — 2 geçiş: grounded `runLlm('search')` → grounded-OLMAYAN `runLlmJson('reading')` extraction (Gemini citation'ları Vertex redirect olduğu için aday METİNDEN çıkar). search_cache + search_log.
  - `fetch.ts` — Jina Reader (r.jina.ai) primary + **SSRF-korumalı** direct fallback (DNS çöz + private IP reddi + manuel redirect) + streamed byte cap + page_cache.
  - `validate.ts` — kanıt-bağlı verdict (DeepSeek), injection fence + **evidence-overlap kapısı** (kanıtı sayfada doğrulanmayan 'match' → 'review', faturalanmaz).
  - `ledger.ts` — tüm yazımlar RPC'ler üzerinden; `unbilledMatchVerdicts` (reconciliation); **holds wrapper'ları** (`reserveHold`/`settleHold`/`releaseHold`/`availableCredits`, `InsufficientCreditsError`/`ReservationExhaustedError`); `billMatch` artık `holdId`/`worker`/`lease` geçer ve exhaustion'ı `error.details` ile ayırt eder. **Cross-ICP re-score (A.3):** `existingCanonicalKeys` → `existingCompanies` (tam-satır Map) + `companiesWithCurrentVerdict` (dedup artık "(company,icp,ruleset) verdict var mı").
  - `fetch.ts` — ayrıca `cachedPageContent(domain)`: ağ çağrısı OLMADAN taze page_cache metnini okur (re-score girdisi), `fetchPage` ile aynı `pageUrl`+sha256 anahtarı.
  - Handler `worker/handlers/harvestRun.ts` (`harvest:run`, maxAttempts=1): **run başında hold rezerve** (yetersiz kredi → COGS harcamadan fail), her bill `hold.id`+`job.locked_by`+`job.lease` ile (lease-fenced, holdu tüketir), `ReservationExhaustedError` → dur, başarıda `settleHold` (kalanı serbest), herhangi bir throw'da `releaseHold` (best-effort) + rethrow. `newly_billed = settledHold.settled` (run'a özel, kesin). **Cross-ICP re-score ikincil geçişi** (yeni keşiften sonra): mevcut-ama-verdict'siz firmaları cached metinden yeniden skorlar (`billOne` DRY bill yardımcısı; detay §4.2).
  - `worker/runner.ts` reaper tick'i `reapStaleJobs` + **`releaseStaleHolds`** çağırır (çökmüş worker'ın holdunu serbest bırakır).
  - Route `routes/research/harvest.ts`: `POST /run` (approved-ICP gate + **`availableCredits < 1` → 402** hızlı-fail; otoritatif gate worker'ın `reserveHold`'u) →202, `GET /companies`, **`GET /credits`** (`{balance, available, reserved}`).

`tsc` (server+client) temiz.

---

## 3. Bu oturumda yapılan codex review'leri (ikincil göz)

`codex exec -m gpt-5.5 -c model_reasoning_effort=xhigh` ile **3 tur**, hepsi FIX-FIRST, hepsi düzeltildi:
1. **Geçmiş adımlar** (055–061 + ICP slice) → 11 bulgu → **062**.
2. **062 doğrulaması** → 6 PASS + yeni P1'ler → **063**.
3. **Engine kodu** → SSRF, billing-completeness, cost-safety → engine düzeltmeleri (aşağıda). canonicalizer/eTLD+1/ß→ss/tenant filtreleri/cache-hit pricing'i PASS dedi.

**Holds için 3 tur daha** (sonraki oturum, hepsi FIX-FIRST, hepsi düzeltildi):
4. **064 holds kodu** → 2×P0 (hold mid-run tüketilmiyor → `available` negatif; reaper çalışan run'ın holdunu serbest bırakır → zombie billing) + 3×P1 → **065** (hold-aware bill + incremental consume + lease fence + try-lock reaper).
5. **065 doğrulaması** → 1×P0 (default-NULL ile hold bypass) + 1×P1 (fence TOCTOU) + 1×P2 (SQLERRM eşleme kırılgan) → **066** (hold ŞART + worker/lease ŞART + `FOR UPDATE` fence + `DETAIL` işaret).
6. **066 doğrulaması** → **No findings → VERDICT: SHIP**. Her tur gerçek defekt buldu.

Engine round-3 düzeltmeleri: SSRF guard + streamed cap; **billMatch transport hatasında THROW** (sessiz faturasız match yok); **uçtan-uca billing reconciliation** (crash-gap kapatır); maxAttempts=1; fetch-boş→LLM'siz 'review'; cache-hit fetch cap'i yemez; evidence-overlap kapısı; fence sanitization; domainless **city**; cap tavanları; `newly_billed` credits-delta'dan (kesin).

---

## 4. CANLI PİLOT — çalışıyor ✅

`temp/harvest-smoke.ts` (Germany, caps 2 query/5 fetch/$0.75), **3 kez yeşil** (holds dahil son tur):
- En son (holds ile): 13 aday → **3 MATCH** (Wiedemann 95, Penning 90, Eisen-Fischer 85 — gerçek Alman sıhhi tesisat toptancıları), 3 partial, **1 doğru ELIMINATED** (Arnold Lammering = üretici), 1 domainless→review.
- **Hold + faturalama** (gerçek worker, lease aktif): `hold={reserved:8, settled:3, released:5}`, `newly_billed=3`, credits 50→47 (Δ=−3), `billable_events=3`. Lease fence hiçbir meşru bill'i engellemedi; consume artımlı çalıştı (settled=3); settle kalanı (5) serbest bıraktı. COGS $0.0103.
- SSRF guard meşru Alman domainlerini bloklamadı; evidence kapısı meşru match'leri düşürmedi.

Test verisi her run sonrası temizlendi (page/search cache tutuldu — cross-tenant, faydalı).

---

## 4.1 LLM USAGE METER + COGS KALİBRASYON PİLOTU — bitti ✅ (2026-06-30)

**Sorun:** `pricing.ts` "pilot ham token/çağrı sayımlarını tutar, COGS sonradan gerçek oranla yeniden hesaplanabilir" diyordu ama **tutmuyordu** — `CapTracker` sadece *varsayılan oranla hesaplanmış doları* tutuyor, ham token'ları atıyordu. Para harcayan pilot bu halde geri-kalibre edilemez veri üretirdi.

**Çözüm — router seviyesinde usage meter** (`llm/meter.ts`, `AsyncLocalStorage`): `runLlm` tek choke point olduğu için her sağlayıcı çağrısının ham token'ı otomatik sayılır (runLlmJson iç retry'leri dahil — dolar tracker'ın kaçırdığı; codex deferral B.3 kapandı). Job sonucu artık `usage_raw` (sağlayıcı başına in/cached/out token + grounded sorgu) + `cost_recheck` (ham'dan yeniden hesaplanmış dolar, çapraz kontrol) taşır. Eşzamanlı job'lar izole tally (ALS scope başına).

**3 review turu (codex gpt-5.5 xhigh + 4-lens Workflow), 14 düzeltme — hepsi FIX-FIRST:**
- **P1 (Workflow yakaladı, codex kaçırdı):** Gemini `thoughtsTokenCount` (düşünme token'ı, **çıktı oranıyla faturalanır**, `candidatesTokenCount`'tan AYRI) sağlayıcı sınırında düşüyordu → en baskın maliyet satırı **underpricing yönünde eksik** + usage_raw'dan kurtarılamaz. Düzeltme: output = candidates + thoughts. **Pilotta doğrulandı: Gemini çıktısının ~%55'i düşünme — düzeltme olmasa COGS %28 eksik.**
- DeepSeek `prompt_cache_hit_tokens` ayrımı yakalanıyor (kesin uzlaşma için); `maxRetries:0` (SDK retry'leri meter'ın altında kalıyordu); withLlmMeter throw'da kısmi usage'ı hata nesnesine ekliyor (frozen-error guard'lı); discovery pass-2 throw'da grounded maliyeti atfediyor; Jina-faturalanabilir fetch ayrımı; harness billed çift-sayım + hit-rate paydası (`evaluated`) düzeltmeleri.
- **Anthropic oranı $15/$75 → $5/$25** düzeltildi (otoritatif Opus 4.8 liste fiyatı; Opus harvest path'inde DEĞİL, sadece ICP-setup).
- Round-3 codex: **No findings → SHIP.** SDK alan adları (`@google/genai@2.10.0` thoughtsTokenCount, DeepSeek prompt_cache_hit_tokens) tip-tanımlarından bağımsız doğrulandı.

**Soğuk kalibrasyon run'ı** (`temp/scale-pilot.ts`, NL+PL, 6q/30f/40c/$2, gerçek Gemini+DeepSeek):
- **18 MATCH** (NL 4, PL 14), 61 değerlendirilen, isabet %29.5. İlk (Germany) run sıcak cache + kirli tenant nedeniyle 0 MATCH verdi → soğuk coğrafyalara geçildi (gerçek grounding + dedup'suz).
- **İlk ölçüm $/MATCH = $0.034** (grounding $0.007) / **$0.045** (grounding $0.014, Google listesi); **Gemini grounded arama %86**. DeepSeek %14. **codex calib review → REVISE:** rakam büyüklük mertebesi (n=2, fiyat-kanıtı değil), grounding 2× daha yüksek olabilir, marj düşük tier'larda kötümserde %40, kaldıraç sıralaması (self-host #1 değil). Düzeltilmiş detay: `01_KREDI_FIYATLAMA.md §4.1`.
- Meter çapraz kontrol geçti: `cost_recheck` ($0.616) ≈ `cost_usd` ($0.615), fark %0.2 (retry token'ları). `usage_raw`/cached-split/jina-split hepsi beklendiği gibi. Pilot sonrası test DB temizlendi (TRUNCATE, cache tutuldu); prod'a dokunulmadı.

---

## 4.2 CROSS-ICP RE-SCORE (A.3 / codex deferral 2) — bitti ✅ (2026-06-30)

**Kapanan P0 boşluk:** Engine mevcut `canonical_key`'i TAMAMEN atlıyordu (`existingCanonicalKeys` dedup) → farklı/yeni/düzenlenmiş bir ICP altında mevcut firmaya verdict YAZMIYORDU; faturalanabilir match'ler sessizce kayboluyordu. Tek-ICP pilotunda etkisizdi, ölçeklemede şarttı.

**Çözüm:** Dedup kapısı artık "firma var mı?" değil **"(company, icp, ruleset_version) için verdict var mı?"** (`companiesWithCurrentVerdict`). Üç yol:
- **Yeni firma** (registry'de yok) → değişmemiş fetch+validate (birincil yol).
- **Mevcut firma, bu ICP için güncel verdict YOK** → **cached metinden yeniden skorla** (`cachedPageContent(domain)` taze page_cache tam metin; yoksa durable `site_summary`; **asla re-fetch yok**) → verdict → match ise faturala. Yeni keşiften SONRA çalışan ikincil geçiş, `RESCORE_EXISTING` (env, default açık; `'0'` → eski skip-all) ile kapılı.
- **Mevcut firma, güncel verdict VAR** → gerçekten atlanır (dedup).
- Ruleset bump (062 CAS) sonrası eski-versiyon verdict'ler predicate'i sağlamaz → aynı ICP yeni ruleset'te doğal olarak yeniden skorlanır.

**Billing güvenliği (kilitli invariant'lara dokunmaz):** Re-score yalnız YENİ gelir üretir — `research_bill_match` `ON CONFLICT (tenant_id, canonical_key) DO NOTHING` ile ömürde-bir. ICP-A altında zaten faturalanmış firma ICP-B altında re-score+match olursa verdict yazılır ama **fatura DEDUP** (hold tüketmez, ledger düşmez, **çift-charge yok**). `insertVerdict` bill'den ÖNCE → transport hatasında verdict kalıcı → reconciliation sonraki run'da bulur (kayıp gelir yok). `research_companies` re-score'da **UPSERT EDİLMEZ** (rollup status/score korunur, migration 060 §2 tasarımı; per-ICP gerçek = verdict tablosu). Cap'ler: `canTakeCandidate` candidate+spend kapılar → re-score sınırlı; içeriksiz skip `countCandidate` yemez ama `reScoreTargets ≤ canon` ile zaten sınırlı.

**Kod:** `engine/fetch.ts` (`cachedPageContent` + `pageUrl` tek-kaynak URL-hash), `engine/ledger.ts` (`existingCanonicalKeys` → `existingCompanies` tam-satır Map + `companiesWithCurrentVerdict`), `worker/handlers/harvestRun.ts` (sınıflandırma bloğu + re-score döngüsü + DRY `billOne` + yeni summary: `rescored`/`rescore_matches`/`rescore_skipped_no_content`/`skipped_current_verdict`/`existing_surfaced`). **server+client tsc temiz.**

**Review + düzeltmeler (2 tur — streaming düzeldikten sonra tamamlandı):** İlk turda ortam streaming-API'si bozuktu (ağ kesintisi 15:14–16:19 + uzun-bağlantı düşmeleri) → codex (×2) + Workflow (×2) hang etti. Streaming düzelince **codex gpt-5.5 xhigh (VERDICT: FIX FIRST) + slim 2-lens Workflow (4 bulgu)** İKİSİ de tamamlandı ve büyük ölçüde örtüştü. **3 bulgu FIX-FIRST düzeltildi:**
- **(P1) Re-score fetch-cap bug:** birincil geçiş `maxFetches`'e çarpınca döngü altındaki `reasonToStop()` `fetch_cap` döndürüyordu → sıfır-fetch re-score geçişi 1 hedeften sonra duruyordu. Düzeltme: re-score döngüsü altta yalnız **spend**'e bakar (`cost().totalUsd ≥ maxSpendUsd`), üstte `canTakeCandidate` candidate+spend kapılar; fetch_cap re-score'u durdurmaz.
- **(P1) site_summary fallback KALDIRILDI:** re-score artık **yalnız tam cached sayfa metninden** skorlar (`cachedPageContent`); yoksa atlar (`rescore_skipped_no_content`). Neden: `site_summary` bir önceki validator'ın ÇIKTISI (doğrulanmamış kaynak değil) → (a) halüsinasyon özet ~tek cümleyle **faturalanabilir match**'e kanıt oluyordu, (b) özete karşı yanlış non-match yazılınca firma o ICP+ruleset için **kalıcı dedup**'lanıp gerçek lead sessizce kaybediliyordu. `isPlaceholderSummary` + `ExistingCompany.siteSummary` de kaldırıldı.
- **(P1) Görünürlük — `GET /companies` verdict-aware:** `icp_id` verilince artık `research_company_verdicts`'ten (ICP'nin **güncel ruleset_version**'ı) okuyup `research_companies` ile join eder, per-ICP verdict status/score/evidence'ını döner (rollup değil). `icp_id` varken `project_id` yok sayılır (ICP zaten projeye scope; rollup project'e filtrelemek cross-project re-score match'ini yeniden gizler + count'u bozar). `icp_id`'siz → eski düz rollup listesi. Böylece re-score match'i faturalanıyor VE görünüyor.
- **server+client tsc temiz.** Düzeltmelerin **codex re-review'ü → VERDICT: SHIP** (yeni bulgu yok; 3 düzeltmenin hepsi doğrulandı: fetch-cap yok sayılıyor/candidate+spend kapılı, yalnız tam sayfa cache skorlanıyor, verdict view güncel-verdict alanları + tam filtreli count + tenant-scope'lu, rollup project_id yok sayımı doğru, ertelenen hardening scope makul).

**Bilinçli ERTELENEN sertleştirme (kendi hardening turuna — holds 064-066 gibi; 05 §1d):**
- **(codex P0) `insertVerdict` mutable UPSERT, lease/suppression-fenced DEĞİL** → eşzamanlı/zombie attempt faturalanmış bir match'in verdict'ini ezebilir. **Pre-existing** (her iki döngü de `insertVerdict` kullanır); tek-worker `maxAttempts=1` pilotunda (tenant başına tek job) TETİKLENMEZ. Planlı düzeltme: fenced `research_persist_verdict` RPC (per-tenant kilit + lease fence + suppression + faturalanmış-match'i-ezme) → `{id,verdict}` döner, dönen verdict'e göre faturala. **Migration 067.**
- (codex P1) reconciliation sayfasız client-side anti-join → SQL RPC; (codex P2) settle/release lease-fenced değil; (codex P1) yumuşak `maxSpend` (maliyet çağrıdan sonra sayılıyor) = mevcut deferral B.1.

---

## 4.3 VERDICT HARDENING (067/069/070) — bitti ✅ (2026-07-02)

**Kapanan:** codex A.3 deferral'ları (P0 `insertVerdict` unfenced mutable upsert + P1 client-side reconciliation + P2 settle/release fence'siz) + codex 067-review bulguları (4) + Workflow 14-agent adversarial review bulguları (2 confirmed).

- App-side `insertVerdict` SİLİNDİ → `persistVerdict` (fenced RPC wrapper, **row-of-record** döner; handler sayım+faturayı DÖNEN karardan yapar). `upsertCompany` da fence'li (070). Handler'a **rollup-repair** eklendi: persist guard faturalanmış match'i koruyunca rollup DÖNEN karara hizalanır (ödenen lead listede 'eliminated' görünemez).
- Route'a **ICP başına tek in-flight harvest** guard'ı (409): aynı ICP'nin eşzamanlı iki run'ının persist→bill aralığında unbilled-match ezme yarışı pratikte kapandı (DB invariant'ları zaten güvendeydi; fatura her zaman güncel karar satırını izler).
- **Smoke:** `temp/verdict-smoke.sql` 9 faz ALL_PASS (yapısal fence, yanlış/ölü lease reddi, upsert-of-record, faturalı-match dokunulmazlığı, hassas cross-ICP freeze [ICP-B satırı serbest, faturanın dayandığı ICP-A satırı donuk], DETAIL marker'ları, anti-join+suppression filtresi, settle/release fence [no-args/yanlış-lease/cross-job reddi], zombie-release reddi+reaper, service_role DML revoke). `temp/holds-smoke.sql` fence imzalarına güncellendi, ALL_PASS.
- **Canlı pilot (fence zinciri uçtan uca):** Germany run — 13 aday → 4 MATCH faturalandı (50→46), verdict'ler fenced RPC'den, hold consume+settle fence'li, sıcak page-cache yolu da doğrulandı. COGS $0.0104 (cache sayesinde sıfır network fetch).

## 4.8 TIER KOTALARI (STRIPE'SIZ) + FAILED-COGS + CRM HANDOFF — bitti ✅ → codex SHIP (2026-07-02)

**Review zinciri:** codex batch-3 (1×P0+4×P1+2×P2 → 074 + route yeniden yazımı) → verify (2 kalıntı: cross-ICP telafi yarışı → mutex TENANT-geneline + multi-instance onay-kemeri [silmeden önce research satırı bizim CRM id'mizi gösteriyorsa BAŞARI say]; domain fallback → `exportDomain(website) ?? exportDomain(domain)`) → **final VERDICT: SHIP** (fonksiyonel regresyon yok).

Kullanıcı kararı: **Stripe YOK** — operatör + otomatik dönem grant'ı kota yaşam döngüsünü döndürür. Migration **073** (test DB'ye uygulandı) + kod:
- **`research_tenant_settings`**: tenant başına tier (trial/starter/growth/scale/custom) + aylık lead kotası + reserve boyutu + auto_grant. Müşteri kendi satırını okuyabilir (adet, dolar değil); yazan admin route'u.
- **`research_apply_period_grants(period)`**: dönemsel otomatik kota — tenant başına try-advisory-lock (meşgulü atla), ledger'a **deterministik ref** (`md5('research_period_grant:'||tenant||':'||period)::uuid`) → `uq_research_usage_ledger_ref` ile dönem başına YAPISAL ömürde-bir (çift grant imkânsız). Worker reaper tick'i her turda idempotent çağırır + admin "şimdi uygula" butonu. Reserve estimate artık tier'a göre (`TIER_RESERVE` map: 10/25/50/100; settings override edebilir).
- **Failed-run COGS kalıcı**: runner, başarısız attempt'in kısmi meter tally'sini (`usage_raw`+`cost_recheck`) `failJob` üzerinden job result'ına yazar; admin özeti **`failed_cost_usd`** kolonuyla toplar, UI'da "Failed $" (turuncu). Marj panelinin kör noktası kapandı (05 §1b(3)).
- **CRM handoff (ürün döngüsünü kapatan halka)**: `POST /harvest/companies/export` — ICP'nin güncel-ruleset MATCH'lerini TG Core `companies`'e kopyalar (stage `'cold'`, fit_score=skor, özet+kanıt custom_fields'ta), üç katman dedup: (a) `crm_company_id` zaten set → atla, (b) mevcut CRM satırıyla aynı eTLD+1 domain → BAĞLA (kopyalama), (c) yeni satır → insert + **korelasyon anahtarıyla** (custom_fields 'Research Ref') sıra-varsayımı OLMADAN geri-bağlama (`research_mark_exported` dar-kapsamlı RPC: yalnız export kolonları, tenant-scoped, relink yok). UI: CompaniesPanel "Uygun firmaları CRM'e gönder" + satırda "CRM ✓" rozeti; admin credits sekmesinde TierSettingsForm (key-remount kalıbı) + dönem-grant butonu.
- **Smoke**: `temp/tiers-smoke.sql` 4/4 ALL_PASS (grant+gating, idempotency [last_grant_period sıfırlansa bile ledger ref'i çift yüklemeyi engeller], dönem devri + geçersiz dönem reddi, mark_exported [own-tenant/no-relink/cross-tenant red]). server tsc + client `tsc -b` + eslint temiz.
- **074 export hardening (codex batch-3 review: 1×P0+4×P1+2×P2 → hepsi ele alındı):** **P0** suppressed firma export edilebiliyordu → `research_exportable_companies` RPC (rollup flag + registry anti-join + unexported, hepsi LIMIT'ten ÖNCE — P1 batch-stall de bitti: tekrar çağrılar alt skorlara sayfalanır) + `research_mark_exported` kilit altında suppression re-check yapar ve GERÇEKTEN işaretlediklerini döner; route işaretlenmeyenlerin CRM kopyalarını SİLER (telafi). **P1 concurrency/retry:** (tenant,icp) başına in-process mutex (tek uzun ömürlü süreç; multi-instance için DB claim notu) + `custom_fields.research_ref` korelasyon anahtarı yarım-kalan export'un retry'ında satırları KOPYALAMAK yerine BAĞLAR (domainless dahil). **P1 yanlış-bağlama:** export-side domain eşleme `allowPrivateDomains:true` ile (a.github.io ≠ b.github.io; billing canonicalizer'a dokunulmadı). **P1 failed-COGS retry birikimi:** kabul+belgelendi (harvest maxAttempts=1; icp retry ¢). **P2:** dönem regex ay 01-12'ye sıkıldı; PUT settings `reserve_estimate`'i yalnız gönderilmişse yazar. 074 ek smoke 3/3 ALL_PASS (exportable filtreleri, mark suppression-recheck, regex).

## 4.7 BATCH-2 REVIEW ZİNCİRİ → SHIP ✅ (2026-07-02)

Batch-2 (068-072 + admin/companies UI + pricing v2) için **4 codex turu** (gpt-5.5 xhigh) + düzeltmeler:
1. **codex batch-2 review → FIX FIRST** (1×P0+4×P1+4×P2) → **072** (`research_companies` DML'i service_role'den de revoke; `research_jobs.error` kolonu müşteri direct-read'inden gizli; admin CTE projects/search_log/holds ile genişledi) + caps şema ayrımı (USD sınırları müşteri validation metnine bile sızmaz) + role-sanitized 202 echo + job `error` metni role göre süzülür (ham sağlayıcı/billing string'i müşteriye ulaşmaz) + generic `POST /jobs` internal-only + grant `idempotency_key` ŞART.
2. **codex verify → FIX FIRST** (kalan 3 + 2 yeni) → **`freshRole.ts` `effectiveCostRole`**: TÜM maliyet yüzeyleri (jobs×4, harvest echo, admin kapısı) internal rol iddiasını her istekte canlı doğrular (ops_agent=aktif membership, superadmin=taze app_metadata), doğrulanamazsa FAIL-CLOSED müşteri görünümü (60s auth-cache indirme penceresi kapandı) + NULL-score repair guard + grant key parametre-bağlı (useMemo: param değişimi/başarı → yeni key; aynı-param retry → aynı key) + response'tan yanlış `granted` iddiası kalktı + icpGenerate failed-but-paid partial usage logu. **Ayrıca keşif: client'ta `npx tsc --noEmit` NO-OP** (solution-style tsconfig) — gerçek kontrol **`npx tsc -b`**; bunun ortaya çıkardığı 4 hata (2'si pre-existing IcpCard) kök nedeniyle düzeltildi: `onError: showErrorFromApi` doğrudan geçirilince `fallback?: string` parametresi TVariables'ı string'e zorluyordu → lambda sarımı.
3. **codex verify-2 → 2 blocker** → freshRole tenant-scoped (rol tenant'a bağlı; A'da indirilen ama B'de ops kalan operatör A'nın dolarını göremez) + CRM `supabaseAdmin` ile kimlik okuma (model-B ayrışmasına dayanıklı) + icpGenerate catch'i tüm paralı bölümü kapsar (LLM+heartbeat+persist).
4. **codex final → VERDICT: SHIP** (regresyon yok; cross-tenant semantiği auth middleware ile birebir doğrulandı).

## 4.4 COGS GÖRÜNÜRLÜK AYRIMI + ADMIN MARJ PANELİ — bitti ✅ (2026-07-02)

**Ürün kuralı:** admin (superadmin/ops_agent) gerçek dolar maliyeti görür; müşteri (client_admin/viewer) ASLA — müşteri yalnız lead/kredi SAYILARI görür.

- **Sızıntı kapatıldı (2 katman):** (a) **DB** — 068 kolon-seviyesi grant'lar: müşteri JWT'siyle direkt PostgREST'ten `research_jobs.result` (cost_usd/usage_raw/cost_recheck), `payload.caps`, `search_log.cost_usd`, `billable_events.amount_usd` artık OKUNAMAZ; (b) **API** — `lib/research/sanitize.ts`: jobs route'unun 4 cevabı da role göre süzülür (cost_usd/cost_recheck/usage_raw/caps/pricing_version + payload.caps müşteriden düşer; lead sayıları kalır).
- **Admin API** (`routes/research/admin.ts`, tüm router `requireRole('superadmin','ops_agent')`): `GET /costs` (per-tenant marj özeti — 068 RPC'si: run/fail sayısı, harvest COGS, search payı, billed leads, bakiye/rezerve, $/lead), `GET /runs` (tam cost breakdown'lu run geçmişi + tenant adları), `POST /credits/grant` (idempotent operatör top-up).
- **Admin UI** (`pages/research/ResearchAdminPage.tsx`, route `/research/admin`, nav yalnız internal): filo kartları (toplam COGS, billed, blended $/lead, açık rezervasyon) + tenant tablosu + run geçmişi (maliyet tooltip'li) + kredi yükleme formu. Rol dışıysa `/research`'e redirect.
- **Companies UI (müşteri)** (`components/research/CompaniesPanel.tsx`, ResearchPage sekmeleri "ICP Master"/"Lead'ler"): proje→ICP seçimi, kredi rozetleri (SAYI), coğrafya+`Lead bul` (onaylı ICP + kota şartı, job polling, bitişte toast+invalidate), verdict-aware firma tablosu (durum/puan/kanıt, filtre, sayfalama). i18n TR+EN tam.

## 4.6 İSABET GENİŞLETME PİLOTU — bitti ✅ (2026-07-02)

3 yeni soğuk konfigürasyon (`temp/scale-pilot.ts`): **Fransa** (farklı dil, keskin ICP) → %13 isabet, $0.11/MATCH; **Çekya** (seyrek pazar; ilk deneme worker-kill ile yarıda kaldı → takılı job düşürüldü, hold reaper'la serbest, kaldığı yerden warm-cache+dedup ile tamamlandı) → %35; **İspanya** (kasıtlı BULANIK MRO-distribütör ICP'si = kötümser uç) → %20, $0.083/MATCH. **Toplam veri seti artık n=5 coğrafya / 2 arketip / 41 MATCH: isabet bandı %13–45 (harman %26), soğuk $/MATCH $0.02–0.11 (harman $0.062).** CZ run'ı **cross-ICP re-score'u üretimde ilk kez doğruladı** (7 rescored → 4 match → 13 match ama 10 yeni tahsilat: 3 dedup, çift charge yok). Tümü pricing v2 + tam fence zinciriyle koştu; `cost_recheck` ≈ `cost_usd` her run'da. Test verisi temizlendi (cache tutuldu: 164 sayfa / 38 arama). Detay + fiyat-kilidi durumu: `01 §4.1`.

## 4.5 ORAN TEYİDİ → PRICING v2 — bitti ✅ (2026-07-02)

- **Liste fiyatlarıyla teyit:** Gemini 3.1 Pro $2/$12 per 1M + grounding $14/1000=$0.014 (✅ varsayım doğru; ayda 5.000 ücretsiz Gemini-3 grounding prompt'u var — fiyatlama ücretli orana göre). DeepSeek V4 Pro **in $0.435** (varsayım $0.30 düşüktü) / **out $0.87** (varsayım $1.20 yüksekti) / **cache-hit $0.003625** (~bedava).
- `pricing.ts`: default'lar güncellendi + **cache-aware tokenCost** (miss inPerM + cached cachedInPerM; `costFromUsageSummary` cached-split kullanır) + `PRICING_VERSION='v2'` (audit stamp; fatura uygunluğunu etkilemez).
- **Yeniden hesap (ham sayımlardan, re-run'sız):** toplam $0.815 → **$/MATCH = $0.0453** (Gemini %88 / DeepSeek %12). Önceki $0.045 tahminiyle örtüştü. **3 oran artık fiyat-kanıtı; kalan tek büyük belirsizlik isabet oranı (n=2).** Detay `01 §4.1`.

---

## 5. Kilitli invariant'lar (asla bozma)

- Billing birimi: **tenant başına unique canonical company için ÖMÜRDE BİR kez**; sadece `verdict='match'`; dedup + PARTIAL/ELIMINATED asla faturalanmaz. Tek giriş = `research_bill_match()` RPC.
- **Bakiye asla negatife düşmez** + **Σ açık reserved ≤ balance her an** (064-066): taze charge **hold ŞART** + holdu artımlı tüketir + tükenince reddeder + sert taban backstop; charge **lease-fenced** (zombie billing yok). Holds tablosu sadece RPC yazar (settle/release/reserve/reaper hepsi aynı per-tenant advisory kilidi).
- **Suppression > dedup** (KVKK); suppression registry PII-free (company=canonical_key, contact=sha256(email)); silme `billable_events`'i SİLMEZ.
- User clients SELECT-only; app+worker service-role (manuel tenant scope). Billing + verdict + holds + company-rollup **yazımları yalnız fenced SECURITY DEFINER RPC'ler** (067-070: persist_verdict/upsert_company/settle/release hepsi (job,worker,lease) fence'li; verdict DML service_role'den de revoke).
- **Faturalanmış MATCH'in karar satırı dokunulmaz** (067/069): charge'ın `verdict_id` ile gösterdiği satır ezilerek değiştirilemez; caller her zaman DÖNEN row-of-record'dan sayar/faturalar.
- **Müşteri rolleri ASLA dolar görmez** (068): cost kolonları DB'de kolon-grant'la + API'de sanitize ile kesilir; dolar yalnız internal admin yüzeyinde.
- Sadece research-owned path'lere dokun; CRM/campaign/auth/import READ-ONLY; CRM dosyası silme.

---

## 6. Nasıl çalıştırılır (resume için)

```bash
# tip kontrol
cd server && npx tsc --noEmit ; cd ../client && npx tsc --noEmit
# canonicalizer testi
cd server && npx tsx ../temp/canon-test.ts
# ICP üretim e2e (gerçek Opus, ~32s)
cd server && npx tsx ../temp/icp-smoke.ts
# HOLDS smoke (deterministik, LLM yok) — temp/holds-smoke.sql'i MCP execute_sql ile TEST DB'de çalıştır;
#   PASS = 'SMOKE_ROLLBACK ALL_PASS :: P1 ... P4 ...' (kendini geri sarar, DB temiz kalır)
# VERDICT smoke (deterministik, LLM yok) — temp/verdict-smoke.sql aynı şekilde; PASS = ALL_PASS P1..P9
#   (yapısal+lease fence, upsert-of-record, faturalı-match dokunulmazlığı + hassas cross-ICP freeze,
#    DETAIL marker'ları, anti-join+suppression filtresi, settle/release fence, zombie+reaper, DML revoke)
# CANLI harvest pilot (gerçek Gemini+DeepSeek+holds, ~$0.01-0.03, küçük caps)
cd server && npx tsx ../temp/harvest-smoke.ts
# WP smoke'ları (hepsi izole DB):
#   coverage-smoke.sql (091/093 chunk RPC, MCP execute_sql, ALL_PASS P1-P6)
#   verdict-smoke.sql (067/069/096/098, ALL_PASS P1-P10+P10b — faturalı-match + hooks + export)
#   geo-smoke.sql (086/090, ALL_PASS P1-P4)
#   cd server && npx tsx ../temp/channels-smoke.ts   # WP3 canlı (SearXNG internal-only → RESEARCH_SEARXNG_URL gerek ya da geçici public domain)
#   cd server && npx tsx ../temp/offers-smoke.ts     # WP4 canlı (~$0.10; SearXNG'siz Gemini fallback ile koşar)
#   cd server && npx tsx ../temp/outcomes-smoke.ts   # WP5 deterministik (LLM yok)
# NOT: canlı worker aynı DB'yi dinler — smoke'lar queued job yerine yarışsız fenced RUNNING job insert eder.
# pilot sonrası temizlik: MCP execute_sql ile research_* satırlarını sil (page/search cache TUT);
#   service_role billing/holds DML revoke edilmiş — temizlik postgres/owner rolüyle (MCP) yapılır
# codex review: codex exec -m gpt-5.5 -c model_reasoning_effort=xhigh -c approval_policy=never -c sandbox_mode=read-only - < prompt.txt
```

`.env`: `GEMINI_KEY` + `DEEPSEEK_KEY` SET (harvest bunları kullanır). `JINA_KEY` yok (keysiz düşük rate çalışır). `ANTHROPIC` ICP için yapılı.
