# TG-Research v2 — Sonraki Adımlar

Son güncelleme: **2026-07-02** (verdict hardening 067-070 + COGS görünürlük ayrımı + admin marj paneli + companies UI + oran teyidi/pricing v2 bitti). Durum özeti: `04_ILERLEME.md`. Bu dosya **resume için yapılacaklar**.

Mevcut durum tek cümle: **Engine + billing + holds + cross-ICP re-score + verdict/rollup fence zinciri (067-070, smokes ALL_PASS + canlı pilot yeşil) + admin-only COGS paneli (068 + /research/admin) + müşteri companies UI bitti; 3 sağlayıcı oranı liste fiyatıyla TEYİTLİ → $/MATCH=$0.0453 (pricing v2). Fiyat kilidi için kalan TEK büyük iş: ÜRETİM İSABET ORANI (n=2 yetersiz — birkaç ICP×ülke pilotu daha) + hariç-tutulan maliyet kalemleri (ICP-Opus kurulum, başarısız-run COGS'u kalıcılaştırma). Sonra: tier kotaları + Stripe.**

---

## A. ÖNCELİK SIRASI (yapılacaklar)

### 1. Pilotu ölçeklendir → gerçek MATCH-başı COGS — ✅ **İLK ÖLÇÜM ALINDI** (2026-06-30)
- LLM usage meter (`llm/meter.ts`) + `temp/scale-pilot.ts` (parametrik ICP×coğrafya, ham token raporu) eklendi; 3 review turu → SHIP. Detay: `04 §4.1`.
- Soğuk run (NL+PL, 6q/30f/40c/$2): **18 MATCH, $/MATCH = $0.034 (grounding $0.007) / $0.045 (grounding $0.014)**. Gemini grounded arama %86. `01 §4.1` (marj + isabet duyarlılığı + kapsam). Büyüklük mertebesi varsayımın altında ama **fiyat-kanıtı DEĞİL** (n=2).

### 1b. Fiyatı kilitlemeden önce — **EN ÖNCELİKLİ (kalanlar)**
- ~~**3 oranı teyit**~~ ✅ **BİTTİ (2026-07-02):** Gemini $2/$12 + grounding $0.014 doğru; DeepSeek in $0.435 / out $0.87 / cache-hit $0.003625. `pricing.ts` **v2** (cache-aware). Yeniden hesap: **$/MATCH = $0.0453** (Gemini %88 / DeepSeek %12). Detay `01 §4.1` + `04 §4.5`. Not: Gemini-3 ailesinde ayda 5.000 ÜCRETSİZ grounding prompt'u — fiyat ücretli orana göre (muhafazakâr).
- ~~**Üretim isabet oranını ölç**~~ ✅ **BİTTİ (2026-07-02):** genişletme pilotu FR (farklı dil, %13) + CZ (seyrek pazar, %35, cross-ICP re-score üretimde doğrulandı) + ES (bulanık MRO ICP'si, %20). **n=5 coğrafya / 2 arketip / 41 MATCH: isabet bandı %13–45 (harman %26), soğuk $/MATCH $0.02–0.11 (harman $0.062).** Detay `01 §4.1`. **Fiyat kilidi artık veriyle mümkün** — tier kotaları bandın kötü ucuna ($0.10) göre konabilir.
- **Hariç-tutulan maliyetleri ekle:** ICP-Opus/kurulum (meter'ı ICP handler'ına da tak → admin panelde setup-cost satırı), **başarısız run COGS'u kalıcılaştır** (şu an sadece log — admin panel `failed_runs` sayısını gösteriyor ama dolarını toplayamıyor; job fail path'inde partial usage'ı `result`'a yaz), enrichment (ayrı), direct-fetch bant, QA, ödeme/vergi (§4.1 KAPSAM).

### 1c. COGS kaldıraçları (sırayla — pilot ışığında)
- **Ucuz/koddan:** grounded sorgu sayısını azalt + Gemini çıktı/thinking token'ını kıs (effort/maxTokens). Gemini içinde çıktı ($0.316) > grounding ($0.189).
- **Derin hasat:** keşif run-başına sabit, MATCH'lere amortize (PL $0.022 @14 vs NL $0.076 @4 — **kısmen amortizasyon, kısmen pazar varyansı**); marjinal isabet korunursa birim düşer. Pilotta ikisi de fetch_cap(30)'a takıldı → `RESEARCH_MAX_FETCHES_CEILING` yükselt.
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
- **Y2 gümrük datası** — `research_trade_imports` + manuel CSV yükleme + `duzenle.py` portu (`02 §A.10/13`).
- **Y3 açık-web açıları** + saturasyon v2 (config eşik; `02 §A.11`).
- **SearXNG / Gosom self-host** — pilotta Gemini grounding kullanıldı; ölçekte maliyet için kendi arama altyapısı (`00`).
- **Playwright JS-render fallback** — Jina pilotu karşılıyor; JS-ağır siteler için sonra.
- **BetterEnrich enrichment** (kişi/karar verici) — **en son öncelik** (`02 §A.8`).
- **AI-destekli mesajlar** (F1, `research_messages`) → TG-Core kampanyalarına handoff.
- **Import to CRM** — research_companies → TG Core `companies` (aynı DB, importProcessor handoff).

---

## D. KIRMIZI ÇİZGİLER (resume eden herkes için)

- **Prod TG Core'a (`ehnbhkxmsdticaodndvy`) DOKUNMA.** Tüm iş izole test DB **`iehqsuludghrhosgxhnr`**'de. Migration'ı prod'a uygulamadan önce dur/sor.
- **Billing invariant:** ömürde-bir-match, sadece `research_bill_match` RPC. Direkt `billable_events`/`usage_ledger` yazma (service_role'de DML revoke zaten).
- **Suppression > dedup**, registry PII-free, silme billable_events'i silmez (KVKK).
- Sadece research-owned path; CRM/auth/campaign/import READ-ONLY; CRM dosyası silme.
- **Commit etme** — kullanıcı açıkça isteyene kadar. `main`'e dokunma.
- Her substantive adımdan sonra **codex gpt-5.5 xhigh ile review** (kullanıcı talebi: "ikincil göz kritik").

---

## E. Migration replay notu (prod'a geçerken)

- 060/061/062/063 **boş tabloya** yazıldı. Dolu prod'da:
  - 060 `canonical_key` NOT NULL'a çekmeden ÖNCE app canonicalizer ile backfill gerekir (060 NULL varsa RAISE eder).
  - 061 legacy ICP'leri `source='ai'` + `ai_draft='{}'` etiketler → prod'da `source='legacy'` ile backfill (062 'legacy' değerini ekledi).
  - Codex önerisi: add / backfill / validate olarak **ayrı migration'lara böl**.
- Migration'lar `supabase/migrations/`'da CRM ile paylaşımlı. Research kalıcı ayrı DB olacaksa CRM deploy yolundan çıkar.
