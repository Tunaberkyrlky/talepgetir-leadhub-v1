# TG-LinkedIn — Microservice Ayrımı: Değerlendirme & Karar Dokümanı

> Amaç: LinkedIn modülünü **egress izolasyonu + prod-hardening** için kendi microservice'ine ayırmalı mıyız, ayırırsak ne zaman ve nasıl? Bu doküman **yalnız değerlendirme** — hiçbir kod değişmez. Sonda net **ÖNERİ** + senin onayına açık **karar menüsü** var.
> Bağlam: `03_ILERLEME.md`'de "prod-hardening → gerekirse LinkedIn kendi microservice'ine ayrılır (egress izolasyonu)" olarak ertelenmişti (§Sonraki fazlar, §Staging + mimari kararı). Kilitli mimari K10 (`Tg-Research-v2/00_MIMARI_PLAN.md`) yeniden tartışılmaz.
> Metot: mevcut kod graphify + hedefli okumayla envanterlendi; iddialar dosya/handler/RPC sayımıyla desteklendi.

---

## 0. Tek cümle özet (verdikt önden)

Bugün split'in çözdüğü dört problemden (egress / deploy / failure / secret izolasyonu) **egress izolasyonu static proxy havuzuyla zaten büyük ölçüde çözülmüş**, deploy izolasyonu **graceful-drain'le kısmen çözülmüş**; geriye **gerçek ama küçük** iki motivasyon kalıyor (research iş fırtınası LinkedIn gönderimini geciktirebilir + secret'lar aynı process'te). Bu ikisi bugünkü hacimde (**1 canlı hesap**, tek operatör) **acı vermiyor** → **şimdi split YAPMA (O0)**, ama split'i ucuza açık tutan **"dikiş hijyeni" (seam hygiene)** yap ve **O1 (kuyruk partisyonu)** tetikleyicilerini önden belirle. O1 mevcut kodda **neredeyse bedava** çünkü worker `claimJob(workerId, types)` zaten iş-tipi listesiyle filtreleyebiliyor.

---

## 1. Mevcut kuplaj envanteri (ne paylaşılıyor)

LinkedIn modülü TG-Research worker/queue'suna **biner** (K10: outreach'in evi TG-Core ama şu an `tg-research` Railway projesindeki full-app `tg-core-staging` servisi + research worker'ı çalıştırıyor). Paylaşım yüzeyleri:

### 1a. Kod yüzeyi (sayımla)
| Katman | Adet | Konum |
|---|---|---|
| LinkedIn lib modülleri | **12** | `server/src/lib/linkedin/` — actions, client, crypto, executor, limits, proxy, schedule, staticProxy, voyager + `sequences/` (engine, enroll, personalize) |
| Worker handler'ları | **8** | `server/src/lib/research/worker/handlers/linkedin*.ts` (validate, invite, message, withdraw, sequence-tick, poll, retention, proxy-sync) |
| Route dosyaları | **5** | `server/src/routes/linkedin/` (accounts, campaigns, capture, index, proxies) |
| İş tipleri (job types) | **8** | `linkedin:validate|invite|message|withdraw|sequence-tick|poll|retention|proxy-sync` (`jobTypes.ts`) |
| Migration | **11** | `083, 093, 094, 095, 097, 101, 106, 107, 108, 109, 110` |
| Extension | **1** | `linkedin-extension/` (MV3 cookie-capture → `/api/linkedin/capture`) |

### 1b. Tablo ailesi (`linkedin_*`, izole DB `iehqsuludghrhosgxhnr`)
~13 tablo: `linkedin_accounts`, `linkedin_link_tokens`, `linkedin_actions`, `linkedin_leads`, `linkedin_suppression`, `linkedin_campaigns`, `linkedin_sequence_steps`, `linkedin_enrollments`, `linkedin_proxies`, `linkedin_proxy_assignments`, `linkedin_burned_exit_ips`, `linkedin_send_leases`, + proxy-health kolonları. **~15+ SECURITY DEFINER RPC**: `linkedin_try_consume_quota`, `linkedin_release_quota`, `linkedin_claim_proxy`, `linkedin_import_proxy_to_pool`, `linkedin_stamp_validated_proxy`, `linkedin_acquire/release_send_lease`, `linkedin_burn_proxy`, `linkedin_apply_proxy_health`, `linkedin_enroll_lead`, `linkedin_claim_due_enrollments`, `linkedin_suppress_identity`, `linkedin_purge_retention`, `linkedin_replace_steps`, `linkedin_account_usage`. **Tümü deny-all RLS + service-role.** CRM tablolarına **hiç yazmaz** (izole modül sınırı, `routes/linkedin/index.ts` başlık yorumu).

### 1c. Research iç yüzeyine bağımlılık (asıl kuplaj)
Handler + lib importlarının fiili sayımı:
| Paylaşılan research yüzeyi | Ne için | Nerede |
|---|---|---|
| **`research_jobs` kuyruğu** | LinkedIn işleri bu tabloya `enqueueJob` ile yazılır, runner buradan `claimJob` ile çeker | queue.js (4 handler + 2 lib importu) |
| **Worker runtime (`ResearchWorker`)** | claim / heartbeat / complete / fail / reap / lease — LinkedIn'in ayrı runtime'ı YOK | `runner.ts` (tek loop, tüm tipler ortak) |
| **`researchSupabaseAdmin`** | izole DB'ye service-role client (5 handler + tüm lib) | supabase.js |
| **`JobHandler` tipi + `RESEARCH_JOB_TYPES`** | handler kontratı + tip sabitleri | types.js, jobTypes.js |
| **`createLogger`** | ortak Pino logger | logger.js (6 handler) |
| **pricing/meter** | fail-anı COGS izi (`costFromUsageSummary`) | runner.js `runJob` catch |

**Env anahtarları (worker process'inde, research secret'larıyla YAN YANA):** `LINKEDIN_COOKIE_ENC_KEY`, `LINKEDIN_PROXY_ENC_KEY`, `ROTATING_5G_PROXY`, `IPROYAL_API` (proxy provizyon), `LINKEDIN_APP_ORIGIN`. Aynı process ayrıca research secret'larını (SearXNG, Gosom, LLM sağlayıcı anahtarları, `SUPABASE_*`) taşır.

**Route mount'u (`server/src/index.ts`):** yalnız **2 satır** — public `/api/linkedin/capture` (auth öncesi, token-gated, rate-limited) + protected `/api/linkedin` (authMiddleware sonrası). Modül sınırı zaten temiz (index yorumu: "the only touch-points … are TWO mount lines").

**Kuplaj verdikti:** Kod tarafı sınır **temiz** (route 2 satır, CRM'e yazmaz, deny-all RLS). Asıl yapışıklık **veri + runtime** düzeyinde: (1) LinkedIn işleri `research_jobs` tablosunda yaşar, (2) tek `ResearchWorker` loop'u tüm tipleri ortak concurrency havuzunda çalıştırır, (3) aynı izole DB.

---

## 2. Split hangi problemi GERÇEKTEN çözer (dürüst tek tek)

### 2a. Egress izolasyonu — **büyük ölçüde ZATEN ÇÖZÜLÜ (proxy havuzu)**
"LinkedIn trafiği ayrı IP/host'tan çıksın; LinkedIn egress'i bloklarsa veya scraping yüzeyi hukuken sorgulanırsa blast-radius research'e bulaşmasın."

**Gerçek durum:** `04_STATIC_PROXY_POOL.md` + mig 106-110 ile **her LinkedIn hesabı kendi ayrılmış IPRoyal TR static residential IP'sinden çıkıyor** (fail-closed `static_required`; §11 canlı kanıt: `31.133.89.88`). Yani LinkedIn'e giden fiili invite/message/withdraw/poll trafiği **research worker'ın host IP'sini KULLANMIYOR** — proxy üzerinden tünelleniyor. Dolayısıyla:
- **LinkedIn egress'i / IP-korelasyonu açısından split'in ek kazancı ~sıfır.** LinkedIn zaten worker host'unu değil, per-account proxy IP'sini görüyor.
- Split'in çözmediğini proxy çözüyor; proxy'nin çözmediğini split de çözmüyor.

**Split'in yine de dokunduğu ince paylar:** (a) `/api/linkedin/capture` gibi **proxy'siz kontrol-düzlemi** çağrıları + provizyon (`IPROYAL_API`) worker host IP'sinden çıkar — ama bunlar LinkedIn'in ban sinyali değil; (b) **hukuki/marka blast-radius**: aynı Railway projesi/şirket-hesabı altında olması, "LinkedIn scraping yüzeyi challenge edilirse research de aynı tüzel/altyapı çatısında" algısını yaratır — bu **organizasyonel** bir izolasyon, teknik değil, ve K10 zaten TG-Research'ü ayrı sistem sayıyor.

→ **Verdikt: egress izolasyonu bugün split için EN ZAYIF gerekçe.** Proxy havuzu bu motivasyonun teknik kısmını yedi.

### 2b. Deploy izolasyonu — **kısmen ZATEN ÇÖZÜLÜ (graceful drain), ama deploy kadansı hâlâ kuplajlı**
"Research deploy'ları uçuş-halindeki LinkedIn gönderimini ortada kesmesin."

**Gerçek durum (kod okundu, `index.ts` + `runner.ts`):**
- SIGTERM/SIGINT → `worker.stop()` → `this.stopping=true` + `Promise.allSettled([...inFlight])` → **uçuş-halindeki işler drenajla tamamlanır**, sonra `process.exit(0)`. Yani deploy anında send-halindeki bir invite **ortada kesilmez** (Railway shutdown grace-period'i içinde biterse). LinkedIn send'i saniyeler sürer → drenaj penceresine kolay sığar.
- Sığmazsa (grace-period aşımı → SIGKILL): iş kaybolmaz, **reaper** (`reapStaleJobs`, 60sn) yeniden claim eder. `maxAttempts=1` write'larda (invite/message) — kesinti anında zaten reserve-before-send + refund mantığı slot sızdırmaz.

**Kalan gerçek acı:** Drenaj işi korur ama **her research deploy'u LinkedIn worker'ını da bounce eder** (aynı process). Restart penceresinde (birkaç saniye) yeni LinkedIn işi claim edilmez; sequence-tick/poll gecikir. Tek operatör + seyrek deploy'da bu **görünmez**. Yüksek deploy kadansında (research aktif geliştirme) LinkedIn pacing'ine birkaç dakikalık jitter ekler — pacing zaten jitter'lı olduğu için zararsız.

→ **Verdikt: deploy izolasyonu bugün teorik-yakın.** Drain korur; kalan tek şey "deploy = ortak restart", düşük hacimde önemsiz.

### 2c. Failure izolasyonu — **GERÇEK ama küçük (ortak concurrency havuzu)**
"Bir research iş fırtınası LinkedIn gönderimini aç bırakmasın."

**Gerçek durum (kod okundu):** Tek `ResearchWorker`, **`concurrency=4` (default) TÜM iş tipleri ortak**. `claimJob` tipe göre öncelik vermez — FIFO/priority neyse onu çeker. Senaryo: 4 uzun research işi (harvest, profil-crawl, LLM zinciri) 4 slotu da tutarsa, kuyrukta bekleyen bir `linkedin:invite` **slot boşalana dek bekler**. Bu **gerçek bir starvation yüzeyi**.

**Ama neden küçük:** LinkedIn işleri doğası gereği **çok seyrek** (min-gap ~90s, working-hours penceresi, warmup rampası → hesap başına günde onlarca aksiyon, saniyede değil). Throughput ihtiyacı mikroskobik; sorun **latency** — bir invite'ın "tam saatinde" değil "birkaç dakika geç" çıkması. Pacing zaten jitter'lı ve `maybeDeferSend` off-hours'ı yeniden kuyruklar → birkaç dakika kayma **anti-ban açısından fark etmez, hatta lehte**. Slot açlığı ancak (a) çok sayıda hesap + (b) eşzamanlı ağır research yükü çakışırsa acıya döner.

→ **Verdikt: failure izolasyonu gerçek ama bugünkü hacimde (1 hesap) etkisiz. Hesap sayısı arttıkça büyür.**

### 2d. Secret izolasyonu — **GERÇEK (cookie/proxy anahtarları research process'inde)**
"Cookie/proxy şifreleme anahtarları yalnız LinkedIn host'unda dursun."

**Gerçek durum:** `LINKEDIN_COOKIE_ENC_KEY` + `LINKEDIN_PROXY_ENC_KEY` + `IPROYAL_API` + `ROTATING_5G_PROXY`, research worker process'inde research secret'larıyla **aynı ortamda**. Bir worker RCE/compromise'ı **hem** research LLM/scraper anahtarlarını **hem** LinkedIn cookie/proxy anahtarlarını (→ müşteri LinkedIn oturumları) açığa çıkarır. Split, LinkedIn anahtarlarını yalnız LinkedIn host'unda tutarak blast-radius'u böler.

**Ama neden küçük (bugün):** Tek operatör, izole test DB, prod müşteri yok. Attack surface = kendi Railway projen. Gerçek müşteri cookie'leri girene kadar teorik. **Prod-launch'ta ağırlığı artar.**

→ **Verdikt: secret izolasyonu gerçek; ağırlığı prod-launch'la (gerçek müşteri oturumları) tetiklenir.**

### Özet tablo
| Motivasyon | Bugün gerçek mi? | Neden |
|---|---|---|
| Egress izolasyonu | **Hayır (çözülü)** | per-account static proxy zaten LinkedIn egress'ini ayırıyor (mig 106-110) |
| Deploy izolasyonu | **Kısmen (teorik-yakın)** | graceful drain uçuş işini koruyor; kalan "ortak restart" düşük hacimde önemsiz |
| Failure izolasyonu | **Gerçek, küçük** | ortak concurrency=4; LinkedIn seyrek + latency-toleranslı → bugün acımıyor, hesapla büyür |
| Secret izolasyonu | **Gerçek, ertelenebilir** | cookie/proxy anahtarları research process'inde; prod müşteri oturumlarıyla ağırlaşır |

---

## 3. Split seçenekleri, maliyetli (kaba insan-günü, tek operatör + ajan-destekli geliştirme)

### O0 — Şimdi hiçbir şey yapma (N hesapta yeniden değerlendir)
- **Kapsam:** mevcut mimari; yalnız §5 dikiş hijyeni + §4 tetikleyicileri belgele.
- **Maliyet:** ~0 gün (bu doküman + küçük hijyen).
- **#2'den ne alır:** hiçbiri — ama bugün hiçbiri acımıyor.
- **Risk / overhead:** yok. Tetikleyici gelene dek en akılcı.

### O1 — Aynı Railway projesi, SADECE `linkedin:*` çalıştıran ikinci worker servisi (kuyruk partisyonu)
- **Kapsam:** ikinci `ResearchWorker` instance'ı, `types: [8 linkedin tipi]` ile başlat; mevcut research worker'ı **tamamlayıcı** listeye (`types: [linkedin-DIŞI tipler]`) kısıtla. Aynı DB, aynı kod tabanı, aynı kuyruk tablosu — sadece **claim filtresi** ile ayrışırlar.
- **Neden ucuz:** `runner.ts::claimJob(workerId, this.types)` **zaten** `p_types` alıyor; claim RPC `type = ANY(p_types)` ile **kesin liste** eşleştiriyor (mig 055/060/062). Kod değişikliği: worker entrypoint'ine tip listesi geçir + Railway'de ikinci servis tanımı. **Gizli tuzak:** eşleşme **prefix değil kesin liste** → her iki worker'a tip listeleri **açıkça** verilmeli; yeni bir `linkedin:*` tipi eklenince **iki yerde** güncellenmezse iş sahipsiz kalır (araya bir `registeredJobTypes()` bölücü helper koymak bunu tek-kaynağa indirir).
- **Maliyet:** **~0.5–1 gün** (entrypoint param + Railway servis + tip-listesi tek-kaynak helper + smoke).
- **#2'den ne alır:** **Failure izolasyonu (2c) TAM** — LinkedIn kendi concurrency havuzunu alır, research fırtınası slotlarını yiyemez. **Deploy izolasyonu (2b) kısmen** — LinkedIn worker'ı ayrı servis olduğu için **research deploy'u onu bounce etmez** (ayrı deploy). Secret izolasyonu (2d) **hayır** (aynı env). Egress (2a) **hayır** (aynı host IP, ama proxy zaten çözdü).
- **Migration riski:** yok (şema değişmez). **Operasyonel overhead:** +1 Railway servis (log/monitoring/env iki yerde). Deploy-ordering: yeni `linkedin:*` tipi eklerken iki servisi de deploy et.

### O2 — Tam microservice (kendi servis + kendi deploy + iç API/queue handoff, paylaşılan DB)
- **Kapsam:** LinkedIn kendi Node servisi (kendi repo-workspace veya aynı repo ayrı entrypoint); kendi worker'ı + kendi route mount'u (`/api/linkedin` bu servise proxy'lenir veya doğrudan sunulur). **Aynı izole DB'yi** paylaşır (queue hâlâ `research_jobs` **veya** LinkedIn kendi kuyruk tablosuna geçer). Handoff: research→linkedin lead aktarımı zaten one-way DB yazımı (canlı FK join değil).
- **Maliyet:** **~3–5 gün** (servis iskeleti + env split + route/proxy + queue kararı [ortak `research_jobs` kalırsa O1'e yakın; ayrı kuyruk tablosu ise runner/claim/reaper'ı LinkedIn tarafında **kopyala**] + CI/deploy + smoke). Runner mantığı (claim/heartbeat/reaper/lease) LinkedIn tarafında yeniden kullanılmalı → `runner.ts`'yi paylaşılan bir pakete çıkarmadıkça **kod duplikasyonu**.
- **#2'den ne alır:** **Failure (2c) + Deploy (2b) TAM + Secret (2d) TAM** (LinkedIn env yalnız bu serviste). Egress (2a) hâlâ proxy'nin işi.
- **Migration riski:** düşük-orta (şema aynı DB'de kalır; kod ayrışır). **Operasyonel overhead:** iki servis + olası API-gateway/proxy katmanı + iki deploy pipeline. Tek operatör için **gözle görülür yük**.

### O3 — Tam microservice + kendi DB (veri ayrımı)
- **Kapsam:** O2 + `linkedin_*` tabloları **ayrı Supabase projesine** taşınır.
- **Kırılan cross-table join'ler (bu ayrımın gerçek maliyeti):**
  1. **`research_jobs` kuyruğu — EN BÜYÜĞÜ.** LinkedIn işleri şu an bu tabloda yaşar; runner buradan claim eder. Ayrı DB = LinkedIn'e **kendi kuyruk tablosu + kendi runner/claim/reaper/lease RPC'leri** gerekir (mig 055/060/062'nin LinkedIn kopyası). Bu tek başına O3'ün çoğu.
  2. **`tenants` + auth/`memberships`.** `linkedin_accounts.tenant_id` + route `authMiddleware` + RLS helper'ları (`get_user_tenant_id()`, `is_superadmin()`) TG-Core auth DB'sine dayanır. Ayrı DB'de tenant kimliği **replike** veya **token-claim'den** türetilmeli.
  3. **CRM/research lead handoff.** `linkedin_leads` research/CRM export'undan beslenir — **zaten one-way kopya** (canlı join değil), o yüzden ayrı DB'de de sadece "yazma hedefi başka DB" olur; kopyalayan taraf değişir, kırılmaz.
  4. **`suppression ↔ leads ↔ enrollments`.** Bunlar **linkedin şeması içi** — hepsi birlikte taşınır, kırılmaz.
  5. **COGS/pricing izi.** `runJob` fail-anı `costFromUsageSummary`'yi research pricing'inden alır — LinkedIn'in bu izole COGS'u (Hunter/proxy) kendi tarafında hesaplanmalı (küçük).
- **Maliyet:** **~8–12 gün** (O2 + veri taşıma + queue/runner kopyası + tenant/auth köprüsü + RLS yeniden + cross-DB raporlama). 
- **#2'den ne alır:** O2'nin hepsi + **maksimum blast-radius bölmesi** (DB compromise'ı bile ayrı). Ama §2'de görülen dört motivasyondan **hiçbiri O2'nin ötesinde ek somut kazanç istemiyor** bugün.
- **Migration riski:** **yüksek** (canlı veri taşıma, tenant/auth köprüsü, RLS). **Operasyonel overhead:** iki DB + iki servis + cross-DB tutarlılık. Tek operatör için **ağır**; yalnız compliance/counsel zorlarsa.

---

## 4. Session-epoch & prod-hardening etkileşimi (şimdi yapılmazsa split'i zorlaştıran şeyler)

`03_ILERLEME.md` prod-hardening kalanları: **session epoch** (stale-401-vs-fresh-reauth), withdraw/poll'a send-lease, egress izolasyonu/microservice, prod Railway env'leri. Bunların split'e etkisi:

- **Session epoch** split'ten **bağımsız** — DB kolonu + karşılaştırma (hangi servis çalıştırırsa çalıştırsın aynı). Split'i zorlaştırmaz; **önce yapılabilir**, split beklemez.
- **Mevcut kod split'i zorlaştıran yerler (bugün ucuz düzeltilir, §5):**
  - Handler'lar research `queue.js` / `supabase.js` / `logger.js`'i **doğrudan göreli path**'le import ediyor (`../../queue.js`). Bunlar ortak-runtime varsayıyor; O2/O3'te "hangi kuyruk / hangi DB client" enjekte edilebilir olmalı.
  - `RESEARCH_JOB_TYPES` içinde LinkedIn tipleri research sabitleriyle **aynı enum'da** — ayrılırken tip-kaynağı bölünmeli.
  - Route mount research `index.ts`'te; O2'de ayrı servise taşınırken auth-middleware'in **nasıl paylaşılacağı** (aynı JWT doğrulama) netleşmeli.

- **Ucuz "dikiş hijyeni" (O1/O2'yi açık tutar, hiçbirine commit etmez):**
  1. **Tip-listesi tek-kaynak:** `linkedin:*` tiplerini `registeredJobTypes()`'tan türeten bir `LINKEDIN_JOB_TYPES` seti çıkar → O1'de iki worker'a filtre vermek tek satır, drift riski biter.
  2. **Runtime bağımlılıklarını isim-bariyeriyle işaretle:** LinkedIn'in research'ten aldığı **tam 3 şey** (`enqueueJob`, `researchSupabaseAdmin`, `createLogger`) zaten dar — bunları LinkedIn tarafında tek bir `platform.ts` re-export'undan geçir (bugün research'e, yarın kendi runtime'ına bağlanır) → O2'de tek dosya değişir.
  3. **Env okumayı tek modülde topla:** `LINKEDIN_*` + proxy env'lerini tek `linkedin/env.ts`'te oku (şu an `process.env` dağınık) → secret izolasyonunda (O2) env sınırı netleşir.
  4. **Worker entrypoint'i tip-parametreli yap:** `ResearchWorker`'a `types` zaten var; `index.ts`'te `RESEARCH_WORKER_TYPES` env'iyle opsiyonel kısıtlama ekle → O1 kod değişikliği olmadan **config'le** açılır.
  - Bu dördü toplam **~0.5 gün**, hiçbir mimari kararı önden vermez, O1'i **config-flag** seviyesine indirir.

---

## 5. Tetikleyici koşullar (ne zaman çalıştır)

Somut eşikler — herhangi biri gerçekleşince ilgili opsiyona geç:

| Tetikleyici | Geç | Gerekçe |
|---|---|---|
| **> ~5–8 aktif LinkedIn hesabı** (eşzamanlı ağır research yüküyle) | **O1** | ortak concurrency=4 starvation'ı bu bantta hissedilir olur (2c) |
| **İlk LinkedIn-atfedilebilir slot açlığı / gecikme incident'i** (invite'lar dakikalarca değil saatlerce gecikiyor) | **O1** | failure izolasyonu artık teorik değil |
| **Gerçek müşterilere prod launch** (izole test DB'den çıkış, gerçek müşteri cookie'leri) | **O2** | secret izolasyonu (2d) + deploy izolasyonu ağırlaşır; müşteri oturumları research secret'larıyla aynı process'te durmamalı |
| **Yüksek research deploy kadansı** LinkedIn pacing'ini gözle görülür bozarsa | **O1** (yeterli) | ayrı servis = ayrı deploy, research bounce etmez |
| **Compliance / hukuk danışman sinyali** (scraping yüzeyi challenge, veri-ikametgâhı/GDPR ayrık DB talebi) | **O2 → O3** | organizasyonel/hukuki blast-radius bölmesi; yalnız bu O3'ü haklı çıkarır |
| **LinkedIn-atfedilebilir IP/ban incident'i research egress'ine dokunuyorsa** | önce **proxy havuzunu doğrula** (§2a), split değil | egress zaten proxy'de; bu incident split'le değil proxy replacement'la çözülür |

---

## 6. ÖNERİ

**ÖNERİ = O0 (şimdi split yapma) + §5.4 dikiş hijyeni (~0.5 gün) + O1'i bir sonraki adım olarak hazırla.**

Gerekçe:
1. **Egress izolasyonu — split'in tarihsel ana gerekçesi — static proxy havuzuyla (mig 106-110) zaten çözüldü.** LinkedIn'e giden fiili trafik worker host'unu değil per-account TR IP'sini kullanıyor (§11 canlı kanıt). Split bu motivasyonda ~sıfır ek kazanç verir.
2. **Bugün acıyan tek şey yok:** 1 canlı hesap + tek operatör + izole test DB'de failure/secret izolasyonu **gerçek ama etkisiz**. Split'in operasyonel maliyeti (ikinci servis/DB, deploy pipeline) bugünkü faydayı aşar.
3. **O1 mevcut kodda neredeyse bedava** (`claimJob` zaten `types` filtreli) → tetikleyici geldiğinde **~0.5–1 günde** açılır. Dikiş hijyeni (§5.4) bunu **config-flag** seviyesine indirir, hiçbir mimari kararı önden vermeden.
4. **O2 prod-launch'a saklanır** (secret izolasyonu asıl orada ağırlaşır); **O3 yalnız compliance/counsel zorlarsa** — bugünkü hiçbir §2 motivasyonu O2'nin ötesini istemiyor.

**Yol:** O0 (+hijyen) → **O1 tetikleyicisi**: >5-8 hesap **veya** ilk gecikme incident'i → **O2 tetikleyicisi**: gerçek müşteri prod-launch → **O3**: yalnız hukuk/veri-ikametgâh zorlarsa. Session-epoch bunlardan **bağımsız**, split beklemeden yapılabilir.

---

## 7. Açık kararlar (senin onayına)

1. **Ana karar:** §6 önerisi = **şimdi split YOK (O0)** + ~0.5 gün dikiş hijyeni + O1'i tetikleyiciye hazırla. Onaylıyor musun, yoksa doğrudan O1'i şimdi mi kurayım (ikinci worker servisi)?
2. **Dikiş hijyeni kapsamı:** §5.4'teki 4 kalem (tip-listesi tek-kaynak, `platform.ts` re-export, `linkedin/env.ts`, `RESEARCH_WORKER_TYPES` entrypoint param) — hepsi mi, yoksa yalnız tip-listesi + entrypoint param mı (O1'i açan minimum)?
3. **O1 tetikleyici eşiği:** "> ~5–8 aktif hesap" bandını onaylıyor musun, yoksa farklı bir sayı/sinyal mi (ör. ilk gecikme incident'i tek başına)?
4. **Prod-launch = O2 kararı:** gerçek müşteri cookie'leri girdiğinde secret izolasyonu için O2'ye geçişi **şimdiden kilitleyelim mi**, yoksa o an yeniden mi değerlendirelim?
5. **Session-epoch sırası:** split'ten bağımsız — bunu **önce** (bir sonraki prod-hardening adımı olarak) mı yapayım, yoksa canlı message/poll smoke'undan sonra mı?

---

## 8. Kaynaklar (kod referansları)
- Worker runtime + graceful drain: `server/src/lib/research/worker/runner.ts` (`ResearchWorker`, `stop()` drain), `server/src/lib/research/worker/index.ts` (SIGTERM/SIGINT).
- Kuyruk tip-filtresi: `server/src/lib/research/queue.ts::claimJob(workerId, types)`; claim RPC `type = ANY(p_types)` → mig `055/060/062`.
- Handler registry: `server/src/lib/research/worker/handlers/index.ts` (8 LinkedIn handler kaydı).
- Route mount: `server/src/index.ts` (2 satır: capture + protected); `server/src/routes/linkedin/index.ts`.
- LinkedIn lib: `server/src/lib/linkedin/` (12 modül) + `sequences/`.
- Proxy egress: `04_STATIC_PROXY_POOL.md` (§0-11), mig `106-110`.
- Mimari kilidi: `Tg-Research-v2/00_MIMARI_PLAN.md` §K10; `03_ILERLEME.md` "Staging + mimari kararı".
