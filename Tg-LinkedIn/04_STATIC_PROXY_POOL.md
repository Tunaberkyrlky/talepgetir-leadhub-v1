# TG-LinkedIn — Static Residential Proxy Havuzu (IPRoyal) — Araştırma & Akış Tasarımı

> Amaç: her LinkedIn hesabına **kendine ait, hiç değişmeyen** bir residential IP vermek.
> Bu doküman **IPRoyal Static Residential (ISP)'ı BİRİNCİL** alır (2026-07-10 kararı: **Webshare'in Türkiye IP'si yok**; Türkiye stoğu şart). Proxy'leri **havuza alıp hesap-başına atama** akışını tasarlar.
> Sağlayıcı gerekçesi §6'da. Kaynak kod bağlamı: `01_FAZ0_BUILD_SPEC.md` §proxy, `server/src/lib/linkedin/proxy.ts`.
> Seam **provider-agnostik**. **⚠️ Satın alma gerçeği (canlı doğrulandı 2026-07-10):** normal IPRoyal müşteri API'si (`resi-api.iproyal.com/v1`, Bearer) proxy **SATIN ALAMAZ** — sipariş yalnız **web dashboard**'dan; API yalnız sahip olunan proxy'leri listeler/yönetir. Reseller API (`apid.iproyal.com/v1/reseller`) order açabilir ama **onaylı reseller** ister (mevcut token yetkisiz). → **provizyon = operatör dashboard işi; kod tarafı = server-side import + havuz + atama.**

## 0. Neden static (tek cümle özet)

LinkedIn bir hesabı tutarlı IP/konumla ilişkilendirir; gerçek insan çoğunlukla aynı IP/konumdan girer.
Rotating residential'da (mevcut DataImpulse) IP **max 120 dk** sticky kalıp döner — canlıda `sessttl`
olmadan **~4 dk'da** düştüğünü ölçtük. Dedicated static residential = **pratikte kararlı, tek kullanıcıya
ayrılmış** IP = per-request rotasyonu (asıl ban sinyali) elimine eder. **Not (codex §9-P1.9):** "hiç dönmez"
mutlak değil — sağlayıcı auto-refresh/plan-edit/silme ile IP değiştirebilir; bu yüzden gözlenen çıkış-IP'sini
sürekli **reconcile** eder, değişimde fail-closed davranırız (§9). Ayrıca dedicated static residential = **ISP/
sunucu-barındırmalı** adres; "ev cihazı residential" ile birebir aynı değil — anti-ban garantisi değil, ölçülecek
bir hipotez (§9-P2.26). Yine de per-account dedicated IP, paylaşımlı/rotating'e göre en güçlü kaldıraç.

---

## 1. IPRoyal ISP / Static Residential — doğrulanmış gerçekler

| Özellik | Değer |
|---|---|
| IP kalıcılığı | **Abonelik süresince aynı IP.** Yenileme/uzatmada **aynı IP'ler rezerve kalır.** |
| Lease süreleri | 1 / 30 / 60 / 90 gün (plan seçilir), `auto_extend` ile otomatik yenileme |
| Bant genişliği | **Sınırsız** (lease boyunca) |
| Kimlik doğrulama | (a) **user:pass** (proxy başına özelleştirilebilir) veya (b) **IP whitelist** (kredisiz) |
| Portlar | HTTP/HTTPS **12323**, SOCKS5 **12324** (özelleştirilebilir) |
| Protokol | HTTP\|HTTPS + SOCKS5 |
| Bağlantı string'i | `host:port:username:password` (dashboard "Formatted Proxy List") |
| Coğrafya | Ülke bazında stok (`availability` endpoint'i) |

**Sonuç:** hesap-başına-IP modeli için uygun. Pratikte kararlı (sessid/sessttl gerekmez, verbatim string) ama
"asla dönmez" mutlak değil (§0/§9-P1.9) → gözlenen çıkış-IP reconcile edilir.

---

## 2. Provider API'leri — IPRoyal (BİRİNCİL) + Webshare (TR stoğu yok)

### 2a. IPRoyal — BİRİNCİL (Static Residential / ISP)
**Canlı doğrulanmış gerçekler (2026-07-10, `IPROYAL_API` token ile):**
- **Müşteri API base:** `https://resi-api.iproyal.com/v1` · **Auth:** `Authorization: Bearer <IPROYAL_API>`. Token bu API'de **geçerli** (business-error döndü, auth-error değil), ama hesapta "Residential API not enabled" (dashboard toggle + ürün gerektirir).
- **Satın alma API YOK (normal müşteri):** static residential **siparişi yalnız web dashboard**'dan (`dashboard.iproyal.com/.../static-residential-proxies`). Kart bilgisi orada kullanılır. API yalnız sahip olunan proxy'leri yönetir/generate eder.
- **Reseller API** (`apid.iproyal.com/v1/reseller`, `X-Access-Token`) order açabilir ama **onaylı reseller** ister — mevcut token orada **unauthorized**. (Bu yüzden §9-P2.25'in "legacy" notu: reseller yolu bizde kapalı.)
- **Ürün:** ISP dedicated static — abonelik boyunca **aynı IP** (yenilemede rezerve), lease 1/30/60/90g, **$2.40/IP/ay** (90g) → $1.80 (24s). user:pass veya IP-whitelist; port HTTP 12323 / SOCKS5 12324; format `host:port:user:pass`.

| İş | Nasıl |
|---|---|
| **Provizyon (IP AL)** | **Dashboard** (API değil): Static Residential Proxies → ülke=**TR** → miktar=1 → lease seç → kart ile öde. |
| Sahip olunan proxy'yi al | Dashboard "Formatted Proxy List" (`host:port:user:pass`) VEYA residential API enabled ise `POST /access/generate-proxy-list` (`{hostname,port,location,proxy_count,proxy_format}`). |
| Credential değiştir | Dashboard (sub-user/credential). |
| Lease uzat (aynı IP) | Dashboard auto-extend / renew. |

> **Sonuç (kod):** provizyon = operatör dashboard işi; **kod = server-side import** (operatör `host:port:user:pass`'i sunucuya verir) + havuz + atama. Reseller onayı gelirse P3'te API-provizyon eklenir (seam hazır).

### 2b. Webshare — ELENDİ (Türkiye stoğu yok)
API'si daha basitti (tek `GET /proxy/list/`) ama **TR dedicated static residential stoğu yok** → LinkedIn hesapları TR IP'sinden çıkmalı, o yüzden kullanılamaz. Endpoint referansı geçmiş sürümde; gerekirse başka ülke hesapları için değerlendirilebilir.

> Env: `IPROYAL_API` (Bearer, müşteri API — listeleme/generate) · ops. reseller `X-Access-Token` (onay gelirse). İkisi de **worker secret**; asla client/DB/plaintext'te durmaz.

---

## 3. Havuz mimarisi (pool)

### 3a. Veri modeli (codex §9 revizyonu — TEK yetkili atama ilişkisi + gözlenen-IP denylist + generation)

**codex P1.3/P1.4/P1.6/P1.12 gereği:** çift-pointer (accounts.proxy_id + proxies.assigned_account_id) YOK — çelişkili sahiplik üretebilir. Bunun yerine **tek atama tablosu**, **kalıcı gözlenen-çıkış-IP denylist'i**, ve **endpoint generation**.

```sql
-- Havuz envanteri (provider-agnostik)
create table linkedin_proxies (
  id             uuid primary key default gen_random_uuid(),
  owner_tenant_id uuid,                     -- envanter sahibi (NULL=global). allocated ayrı tabloda.
  provider       text not null default 'webshare',
  provider_plan_id text not null,           -- P1.2: plan-nitelikli (dedicated-static tier doğrulandı)
  ext_id         text not null,             -- provider proxy id (P1.4: NOT NULL — dup-null yok)
  proxy_address  text not null,             -- provider metadata IP
  exit_ip        inet,                      -- P2.24: GERÇEK gözlenen çıkış IP (echo ile doğrulanır)
  host           text not null,
  port           integer not null,          -- direct: /proxy/list/'in döndürdüğü port
  username_enc   text not null,             -- AES-256-GCM
  password_enc   text not null,
  country        text,                      -- ISO-2
  endpoint_generation integer not null default 1,  -- P1.12/P1.13: host/port/cred/IP her değişince ++
  provider_health text not null default 'unknown'  -- P1.16: transport sağlığı (valid/last_verification'dan)
                 check (provider_health in ('unknown','healthy','unhealthy')),
  reputation_state text not null default 'clean'    -- P1.16: LinkedIn-risk ayrı
                 check (reputation_state in ('clean','quarantined','burned','retired')),
  replacement_state text not null default 'none'    -- P1.1: async replacement
                 check (replacement_state in ('none','pending','completed','failed')),
  plan_expires_at timestamptz,              -- P2.23: plan-seviyesinden türetilir
  last_seen_sync uuid,                      -- P1.8: en son tam sync_run_id'de görüldü
  created_at     timestamptz default now(),
  updated_at     timestamptz default now(),
  unique (provider, ext_id)                 -- P1.4: NOT NULL olduğu için gerçek tekillik
);

-- TEK yetkili atama ilişkisi (P1.3/P1.6): bir hesap = bir satır, bir proxy = bir aktif atama
create table linkedin_proxy_assignments (
  account_id     uuid primary key,          -- hesap başına EN FAZLA bir aktif atama
  proxy_id       uuid not null,
  tenant_id      uuid not null,             -- P1.6: tenant damgası
  generation     integer not null default 1,
  assigned_at    timestamptz default now(),
  released_at    timestamptz,               -- NULL = aktif
  unique (proxy_id) where (released_at is null)   -- P1.3: bir proxy aynı anda tek hesapta
  -- composite FK'ler (tenant_id, id) ile hem accounts hem proxies'e (P1.6)
);

-- KALICI yanmış-çıkış-IP denylist'i (P1.4): fiziksel IP tekrar dönse bile bir daha atanmaz
create table linkedin_burned_exit_ips (
  exit_ip        inet primary key,
  burned_at      timestamptz default now(),
  reason         text,
  source_account_id uuid
);

-- hesap tarafı: sadece revalidation kapısı (atama pointer'ı DEĞİL — o assignments'ta)
alter table linkedin_accounts add column proxy_mode text not null default 'legacy_rotating'
  check (proxy_mode in ('static_required','legacy_rotating'));            -- P1.10: fail-closed
alter table linkedin_accounts add column last_validated_proxy_generation integer;  -- P1.12
-- linkedin_accounts.geo (ISO-2) atama için; ŞU AN ACCOUNT_COLUMNS'TA YOK → eklenecek (P1.11)
```

**Değişmezler (codex ile sertleştirildi):**
1. **1 IP ↔ 1 hesap** — `assignments` PK(account_id) + partial-unique(proxy_id where released_at is null). Çift-pointer yok (P1.3).
2. **Yanmış IP asla paylaşılmaz** — kalıcı `burned_exit_ips` denylist'i **gözlenen fiziksel IP** üzerinden; import + atama + replacement-sonrası kontrol edilir. Eski satırı "denylist" diye tutmaya güvenmez (P1.4).
3. **Fail-closed** — `proxy_mode='static_required'` hesap sağlıklı+doğrulanmış atama yoksa **gönderim yapmaz**; DataImpulse'a **düşmez** (P1.10). DataImpulse yalnız açıkça `legacy_rotating` hesaplarda.
4. **Validate=Send aynı IP** — `endpoint_generation`; send ancak `last_validated_proxy_generation == atama.generation` ise (P1.12). Değişimde queued iş iptal + `PROXY_REVALIDATION_REQUIRED`.
5. **Tenant izolasyonu** — atama `tenant_id` damgalı, composite FK'ler (P1.6).
6. **Provider-sağlık ≠ reputation** — `provider_health` (transport) ile `reputation_state` (LinkedIn-risk) ayrı; `valid=false` yakmaz (P1.16).

### 3b. Şifreleme
`crypto.ts` (AES-256-GCM) yeniden kullanılır. **Ayrı `LINKEDIN_PROXY_ENC_KEY`** (öneri: cookie'den bağımsız rotate).
Yalnız `username`/`password` şifreli; `proxy_address`/`exit_ip`/`port`/`country` plaintext (teşhis/geo).

---

## 4. Akışlar

### 4a. Sync — worker `linkedin:proxy-sync` (codex P1.8 — partial-run destructive olamaz)
IPRoyal normal müşteride havuz-listeleme API'si sınırlı ("residential_api_not_enabled"); P0'da **import server-side manuel**. Enabled olursa (`POST /access/generate-proxy-list`) veya reseller onayında sync şu invariant'larla:
```
1. sync_run_id üret. Sağlayıcı listesini TÜM sayfa STAGE'e yaz. Herhangi bir hata/rate-limit → 'incomplete' → HİÇBİR yıkıcı değişiklik.
2. TAM+doğrulanmış snapshot sonrası (provider, ext_id) UPSERT; last_seen_sync; provider_health'i türet (assignment + reputation_state KORUNUR).
3. 'expired'/'gone' YALNIZ: tam snapshot + N ardışık miss (tek eksik listelenme yetmez, P1.8).
4. exit_ip'i echo ile doğrula (P2.24) — iki bağımsız echo + ülke/ASN.
```

### 4b. Atama — TEK security-definer RPC (codex P1.5 — Supabase BEGIN/COMMIT tutamaz)
Sıradan Supabase çağrıları transaction/row-lock'u çağrılar arası tutamaz → atama **tek RPC** olmalı (mevcut `linkedin_try_consume_quota` deseni gibi):
```
linkedin_claim_proxy(p_tenant, p_account) SECURITY DEFINER:
  1. hesabı tenant-scoped KİLİTLE (FOR UPDATE); country'yi al
  2. zaten aktif atama varsa → idempotent döndür (P1.5)
  3. p_country YOKSA / doğrulanmamışsa → FAIL CLOSED, arbitrary ülke ATAMA (P1.7)
  4. uygun proxy seç:
       reputation_state='clean' AND provider_health='healthy'
       AND replacement_state='none' AND country = p_country (KESİN eşitlik, ISO-2)
       AND exit_ip NOT IN (select exit_ip from linkedin_burned_exit_ips)   -- P1.4
       AND plan_expires_at > now() + safety_window                          -- P2.23
       FOR UPDATE SKIP LOCKED LIMIT 1
  5. yoksa → 'NO_PROXY' (fail-closed; alarm) — DataImpulse'a DÜŞMEZ
  6. assignments'e insert (account PK + proxy partial-unique çakışmada retry)
  7. accounts: proxy_mode='static_required', last_validated_proxy_generation=NULL (revalidate şart)
```
Atama **kalıcı**; hesap ömrü boyunca aynı IP (generation değişene dek). Atama SONRASI çıkış-IP echo ile doğrulanır (P2.24), yanık denylist'te değilse aktive.

### 4c. Kullanım — dispatcher seçimi (fail-closed, generation-gate)
`actions.ts::dispatcherFor` **async olur** (atama projeksiyonu DB'den; codex P1.11) veya account load'una atama projeksiyonu eklenir:
```
proj = account load + tenant-scoped assignment projection (host,port,cred,country,generation,exit_ip,states)
if account.proxy_mode == 'static_required':
    if not proj.assignment OR proj.reputation!='clean' OR proj.provider_health!='healthy'
       OR proj.generation != account.last_validated_proxy_generation:   # P1.12 generation-gate
        → SKIP send (fail-closed; NO fallback)                          # P1.10
    creds = decrypt(...); return proxyAgentForStatic(`${proj.assignment_id}:${proj.generation}`, host:port, creds)  # P1.13 cache key = assignment:generation
else:  # legacy_rotating (yalnız açıkça bu modda kurulmuş hesaplar)
    return proxyAgentFor(account.proxy_session_id, account.geo)
```
**Kritik (codex P1.10/P1.11/P1.12/P1.13):** (a) `else` **error-fallback DEĞİL** — yalnız açık legacy mod; (b) `dispatcherFor` sync→**async** (loadProxy DB işi); (c) cache **`assignment_id:generation`** ile (mutable row-id değil) → replacement sonrası eski cred/IP kalmaz; (d) validate ile send generation eşitliği zorunlu — arada replacement olursa send doğrulanmamış IP'ye gitmez. **`ACCOUNT_COLUMNS`'a `geo` + atama projeksiyonu eklenecek** (§5'teki "zaten geo var" iddiası YANLIŞTI, P1.11).

### 4d. Sağlık / yaşam döngüsü
**codex P1.14/P1.15/P1.16:** burn+health+queue-cancel+replace **atomik** olmalı (transactional health RPC + outbox); restricted hesabı **hemen yeni IP'den login ETME**.
```
linkedin_apply_proxy_health(account, classifier) SECURITY DEFINER (tek txn):
  - classifier kaydet + account state (mevcut applyWriteHealth mantığı)
  - RESTRICTED/CHALLENGED → binding'i retire + endpoint_generation++ + queued işleri iptal
  - reputation_state='burned' + exit_ip'i burned_exit_ips'e ekle (politika gerektiriyorsa)
  - outbox event kuyruğa: worker replacement'ı IDEMPOTENT yürütür
```
| Olay | Aksiyon (düzeltilmiş) |
|---|---|
| Hesap RESTRICTED/CHALLENGED | binding retire + gen++ + queued iptal (tek txn). **Hemen reassign YOK** (P1.15): kısıt IP-kaynaklı olmayabilir; yeni IP'den login kimlik-süreksizliğini artırır. Replacement → **karantina**; ülke/exit-IP/erişim doğrulanır; **açık recovery + revalidation** sonrası aktive. |
| Bozuk IP (`provider_health='unhealthy'`) | **yakmaz** (P1.16) — hysteresis + doğrudan erişim testi; kalıcıysa `POST /api/v3/proxy/replace/` (async, poll) |
| Yanmış exit_ip | kalıcı denylist; provider yeni ext_id ile aynı IP'yi dönse bile atanmaz (P1.4) |
| Plan bitişi | plan-seviyesi (`plan_expires_at` türetilir, P2.23); yenileme operatör iş akışı |
| Credential/endpoint değişimi | replacement → yeni cred/IP → gen++ → cache invalidasyonu (assignment:gen) → revalidation |

---

## 5. Seam entegrasyonu (mevcut kodla)

- `proxy.ts`: `proxyAgentFor(sessionId, country?)` **KALIR** (yalnız legacy_rotating). **YENİ** `proxyAgentForStatic(key, hostport, {user,pass})`; cache key **`assignment_id:generation`** (P1.13). `disposeProxyAgent` prefix-temizlemeli (bu oturumda düzeltildi).
- `actions.ts::dispatcherFor(account)`: **async olur** (atama projeksiyonu DB'den) + fail-closed generation-gate (§4c). `ACCOUNT_COLUMNS`'a `geo` + `proxy_mode` + `last_validated_proxy_generation` + atama projeksiyonu eklenir. **⚠️ Şu an `geo` ACCOUNT_COLUMNS'ta YOK** (P1.11 — eski "zaten geo" iddiası yanlıştı).
- `linkedinValidate.ts`: aynı async `dispatcherFor` (şu an `proxyAgentFor`'u doğrudan çağırıyor). Validate, doğruladığı generation'ı `last_validated_proxy_generation`'a yazar (P1.12).
- **Client tarafı değişmez**; opsiyonel bir "Proxy" kolonu (IP/ülke/lease bitişi) Hesaplar sekmesine eklenebilir.
- Yeni job type: `linkedin:proxy-sync` (registry + jobTypes) → provider-adaptör deseni (`syncIproyal()` / `syncWebshare()`, ortak upsert). Yeni route'lar: `POST /admin/linkedin/proxies/import` (internal, server-side `host:port:user:pass` + hesap) + `POST /admin/linkedin/proxies/sync`.
- Env: `IPROYAL_API` (Bearer) + `LINKEDIN_PROXY_ENC_KEY` worker'da. Provider-adaptörü DB'den (`provider='iproyal'` default).

---

## 6. Maliyet modeli + sağlayıcı seçimi (KARAR)

### 6a. Neden shared DEĞİL (LinkedIn'e özel, kritik)
Birden çok bağımsız kaynak (2026): **LinkedIn IP'ye göre hesap korelasyonunu çok agresif yapar — "aynı IP'de 2 hesap bile günler içinde soruşturma tetikler."** Shared/private IP'de kimlerin çıktığını KONTROL EDEMEZSİN; başka bir müşterinin hesabı/davranışı senin IP'nin itibarını yakar → senin LinkedIn hesabın da düşer. Static residential 3 katman gelir: **premium (shared)** · **private (≤2 kullanıcı)** · **dedicated (tek kullanıcı)**. Hesap barındırmak için **yalnız dedicated** uygundur. Gördüğün "astronomik fiyat farkı" tam olarak shared↔dedicated ayrımıdır ve LinkedIn'de ödemen GEREKEN şey budur. (Bonus: mobile IP'ler ~%85 hesap-sağkalımı vs residential ~%50 — en değerli hesaplar için premium seçenek.)

### 6b. Sağlayıcı karşılaştırması (dedicated static residential/ISP, IP/ay)
| Sağlayıcı | Shared (kullanma) | **Dedicated (tek kullanıcı)** | API | Not |
|---|---|---|---|---|
| **Webshare** | $0.30 (premium/shared) · $0.53 (private ≤2) | **$1.47/IP** ✅ en ucuz gerçek dedicated | ✅ tam (country/type/protocol filtre, dynamic list) | TR ISP daha kıt/pahalı (~$3) |
| **IPRoyal** | $0.27 (shared) | **$2.70/IP** | ✅ reseller API (§2) | §2-3'te entegrasyonu yazıldı; sağlam |
| **Decodo (Smartproxy)** | $0.27 (shared) · $1.30/GB | **$2.50–3.33/IP** (hacme göre) | ✅ | "keep IPs forever"; pahalı uç |

- Toplam = (aktif hesap) × (dedicated IP/ay). Düşük hacimde (5–20 hesap) mutlak fark küçük: Webshare $7–30 / IPRoyal $13–54.
- **Coğrafya asıl kısıt:** IP, hesap-sahibinin normalde giriş yaptığı ÜLKEYE uymalı (TR hesap → TR IP). TR dedicated ISP her sağlayıcıda daha kıt/pahalı (~$3). Fiyattan önce **hedef ülkelerde dedicated stok** var mı bak.

### 6c. Öneri (KİLİT: IPRoyal, 2026-07-10)
1. **Shared/private ELE** — LinkedIn hesabı için co-tenant ban bulaşması.
2. **Dedicated static residential/ISP, hesap başına 1 IP, hesabın ülkesine geo-match.**
3. **KARAR = IPRoyal Static Residential (ISP), ~$2.40/IP/ay.** Gerekçe: **Webshare'in TR IP'si yok**; LinkedIn hesapları TR'den çıkmalı → provider'ı belirleyen kısıt coğrafya, fiyat değil. IPRoyal TR stoğuna sahip.
4. **Satın alma dashboard'dan** (API normal müşteride satın alamaz, §2a) — kod tarafı server-side import.
5. **Premium katman (ops.):** kritik hesaplara mobile IP; seam provider-agnostik, havuzda karışır.

**Not — mevcut fallback:** bugün sertleştirdiğim DataImpulse rotating (sessid+sessttl.120+cr) yalnız **fallback/ucuz katman** olarak kalır; hesap barındırmanın birincil yolu dedicated static'tir.

---

## 7. Fazlı build planı (küçükten büyüğe, her adım bağımsız değerli)

| Faz | Kapsam | Bağımlılık |
|---|---|---|
| **P0 — SERVER-SIDE tek proxy (codex P1.18)** | **Client "yapıştır" YOK** (plaintext cred + SSRF). Internal-only route: operatör IPRoyal `host:port:user:pass`'ini **sunucuya** verir → SSRF guard (private/loopback/link-local/metadata/onaysız host reddi; yalnız izinli protokol/port) → echo ile çıkış-IP doğrula (TR + yanık-denylist) → `linkedin_proxies` + `assignments` (tek IP) → `proxy_mode='static_required'` + revalidate. `proxyAgentForStatic` (cache key `assignment:generation`). | `LINKEDIN_PROXY_ENC_KEY` — **IPRoyal TR IP'siyle test** |
| **P1 — havuz import + claim RPC** | (opsiyonel API listeleme `POST /access/generate-proxy-list`, residential API enabled ise) + `linkedin_claim_proxy` RPC (4b) + fail-closed dispatcher (4c) + `geo`/atama projeksiyonu ACCOUNT_COLUMNS'a. | P0 |
| **P2 — sync + async replacement + health RPC** | `linkedin:proxy-sync` (staged, P1.8) + `POST /api/v3/proxy/replace/` async-poll + `linkedin_apply_proxy_health` transactional + burned-IP denylist + generation-gate. | P1 |
| **P3 — provizyon iş akışı** | operatör `checkout/purchase/` (`behavior=add`, fiyat önizle, onay) + plan/expiry tabloları + bandwidth/replacement-kota alarmı. | P2 + bütçe |

> **Tavsiye:** **P0'dan başla** (server-side, SSRF-guard'lı). IPRoyal dashboard'dan bir **TR static residential IP** alıp sunucuya verirsin → çıkış-IP TR doğrulanır → validate/invite o **sabit** IP'den çıkıyor mu kanıtlarız. İyiyse P1→P2.
> **Uyarı (codex verdict):** doküman ilk halinde implementation-ready DEĞİLDİ; §9'daki 18 P1 (RPC atama, tek atama ilişkisi, fail-closed static mode, generation-gate, denylist, server-side import) her biri **inşa sırasında uygulanmalı.**

---

## 8. Açık kararlar (senin onayına)

1. **Provider:** §6 önerisi = **Webshare Dedicated Static Residential ($1.47/IP)** birincil, **IPRoyal ($2.70)** yedek — hedef ülke stoğuna göre. Onaylıyor musun? (shared seçenekler LinkedIn için ELENDİ.)
2. **IPRoyal planı:** kaç IP, lease (30/60/90g), TR (+ diğer ülke) stoğu. Dashboard'dan alınır; auto-extend açık mı.
3. **Havuz kapsamı:** global paylaşımlı mı, tenant başına ayrılmış mı? (çoklu-tenant izolasyonu istiyorsan tenant'a ayrılmış.)
4. **Şifreleme anahtarı:** cookie ile aynı mı, ayrı `LINKEDIN_PROXY_ENC_KEY` mi? (öneri: ayrı.)
5. **Başlangıç fazı:** P0 (IPRoyal TR IP'si → server-side import → bugün test) → sonra havuz/RPC (P1)?

---

## 9. Codex review (gpt-5.6-sol, 2026-07-10) — bulgular + çözümler

Verdict: **"not implementation-ready"** (ilk hali). 18 P1 + 8 P2. Hepsi doküman gövdesine işlendi + 1 canlı kod bug'ı düzeltildi. Kabul durumu:

| # | Bulgu (özet) | Durum |
|---|---|---|
| P1.1 | Webshare replacement/stats endpoint'leri yanlış; replacement **async** (poll) | ✅ §2a düzeltildi (`/api/v3/proxy/replace/`, `/proxy/list/replaced/`, `/api/v2/stats/`) |
| P1.2 | `mode=direct` ≠ dedicated tier; `plan_id` + tier doğrulaması şart | ✅ §2a/§3a `provider_plan_id` |
| P1.3 | Şema 1:1'i zorlamıyor (çift pointer diverge) | ✅ §3a tek `linkedin_proxy_assignments` ilişkisi |
| P1.4 | Yanmış-IP kalıcılığı + fiziksel-IP tekilliği yok (ext_id nullable) | ✅ `ext_id NOT NULL` + kalıcı `burned_exit_ips` (exit_ip) |
| P1.5 | Claim ancak tek DB fonksiyonuysa atomik (Supabase BEGIN/COMMIT tutamaz) | ✅ §4b `linkedin_claim_proxy` RPC |
| P1.6 | Tenant izolasyonu eksik; cross-tenant atama mümkün | ✅ atama `tenant_id` + composite FK |
| P1.7 | Geo null → arbitrary ülke atar | ✅ §4b fail-closed, kesin ISO-2 eşitlik |
| P1.8 | Partial/failed sync canlı atamayı yakabilir | ✅ §4a `sync_run_id` staging + N-miss/replaced-history |
| P1.9 | "Hiç dönmez" mutlak değil (provider auto-refresh/silme) | ✅ §0 yumuşatıldı + reconcile/fail-closed |
| P1.10 | Hibrit dispatcher fail-closed'a aykırı (else→DataImpulse) | ✅ §3a/§4c `proxy_mode='static_required'`, fallback yok |
| P1.11 | `dispatcherFor` uyumsuz: `geo` ACCOUNT_COLUMNS'ta yok, sync→async | ✅ §4c/§5 async + geo/projeksiyon eklenecek |
| P1.12 | validate↔send generation skew (arada replacement) | ✅ `endpoint_generation` + `last_validated_proxy_generation` gate |
| P1.13 | Static agent cache replacement sonrası eski cred/IP tutar | ✅ cache key `assignment:generation`; **`disposeProxyAgent` bug'ı bu oturumda düzeltildi** |
| P1.14 | Burn/health/cancel/replace atomik değil | ✅ §4d `linkedin_apply_proxy_health` transactional + outbox |
| P1.15 | Restricted hesabı hemen yeni IP'den login tehlikeli | ✅ §4d hemen-reassign yok; karantina + recovery |
| P1.16 | provider-health ≠ reputation-burn (valid=false yakmaz) | ✅ §3a ayrı `provider_health`/`reputation_state` |
| P1.17 | Webshare API key tam yetkili (worker compromise riski) | ✅ §8 ayrı hesap + spending-limit + secret-store (karar) |
| P1.18 | P0 client-paste = plaintext cred + SSRF | ✅ §7 P0 server-side + SSRF guard |
| P2.19 | purchase endpoint yanlış; `behavior=replace` ezme; recaptcha koşullu | ✅ §2a `checkout/purchase/`, `behavior=add` |
| P2.20 | "Sınırsız BW" yanlış; tier'lı; maliyet modeli eksik | ✅ §2a bandwidth notu + pricing-API maliyet |
| P2.21 | Direct port açıklaması yanlış (backbone aralığı) | ✅ dönen `port` verbatim |
| P2.22 | Şema, sync'in güncellediği alanları içermiyor | ✅ §3a alanları eklendi |
| P2.23 | Expiry yanlış seviyede (plan vs order) | ✅ `plan_expires_at` türetilir |
| P2.24 | `proxy_address` = görünen çıkış IP varsayımı | ✅ echo doğrulama + `exit_ip inet` |
| P2.25 | IPRoyal yedek API deprecated (2025-09-15) | ⚠️ §2b'de not; yedek yolu **revalidate edilene dek dondur** |
| P2.26 | "dedicated static = ev residential" abartı; survival % kanıtsız | ✅ §0 hipotez olarak işaretlendi; cohort'la ölç |

**Sonuç:** plan sertleşti; kritik yol RPC-tabanlı (mevcut `linkedin_try_consume_quota` fence deseniyle hizalı). İnşa P0'dan başlar ve her faz ilgili P1'leri uygular.

## Kaynaklar
**Webshare (birincil):**
- API genel: https://apidocs.webshare.io/ · Proxy listele: https://apidocs.webshare.io/proxy-list/list · İndir: https://apidocs.webshare.io/proxy-list/download
- Abonelik/satın alma: https://apidocs.webshare.io/subscription/purchase_plan · https://apidocs.webshare.io/subscription/plan · https://apidocs.webshare.io/subscription/pricing
- Dedicated static residential ürün + fiyat: https://www.webshare.io/dedicated-static-residential-proxy · https://www.webshare.io/pricing · TR lokasyon: https://www.webshare.io/proxy-locations/tr

**IPRoyal (yedek):**
- ISP API — proxies/orders: https://docs.iproyal.com/proxies/isp/api/orders · https://docs.iproyal.com/proxies/isp/api/proxies
- ISP quick-start (format/port/sticky): https://iproyal.com/quick-start-guides/static-residential-proxies/

**Anti-ban / provider seçimi:**
- LinkedIn proxy karşılaştırması (dedicated vs shared, IP-korelasyonu): https://aimultiple.com/linkedin-proxies · https://www.linkedhelper.com/blog/proxies-linkedin-automation/
- Decodo ISP fiyat: https://decodo.com/proxies/isp-proxies/pricing
