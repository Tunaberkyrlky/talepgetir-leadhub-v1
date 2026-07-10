# TG-LinkedIn — Static Residential Proxy Havuzu (IPRoyal) — Araştırma & Akış Tasarımı

> Amaç: her LinkedIn hesabına **kendine ait, hiç değişmeyen** bir residential IP vermek.
> Bu doküman **Webshare Dedicated Static Residential'ı BİRİNCİL** alır (IPRoyal = yedek) ve proxy'leri
> **programatik olarak havuza alıp hesap-başına atama** akışını tasarlar. Karar için hazırlanmıştır.
> Sağlayıcı gerekçesi + fiyat karşılaştırması §6'da. Kaynak kod bağlamı: `01_FAZ0_BUILD_SPEC.md` §proxy,
> `server/src/lib/linkedin/proxy.ts`. Seam **provider-agnostik** — Webshare/IPRoyal/mobile aynı havuzda karışır.

## 0. Neden static (tek cümle özet)

LinkedIn bir hesabı tutarlı IP/konumla ilişkilendirir; gerçek insan her gün aynı ev IP'sinden girer.
Rotating residential'da (mevcut DataImpulse) IP **max 120 dk** sticky kalıp döner — canlıda `sessttl`
olmadan **~4 dk'da** düştüğünü ölçtük. Static residential = abonelik boyunca **hiç dönmeyen** dedicated IP =
en güçlü tek anti-ban kaldıracı. IPRoyal bu ürünü açıkça "sosyal medyada çoklu hesap yönetimi" için konumluyor.

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

**Sonuç:** hesap-başına-IP modeli için birebir uygun. IP asla dönmez → sessid/sessttl gerekmez;
proxy string'i verbatim kullanılır.

---

## 2. Provider API'leri — Webshare (BİRİNCİL) + IPRoyal (yedek)

### 2a. Webshare API — BİRİNCİL (Dedicated Static Residential)
- **Base:** `https://proxy.webshare.io/api/v2/`
- **Auth:** `Authorization: Token <API_KEY>` (Dashboard → API keys)
- **Ürün:** Dedicated Static Residential — **tek kullanıcı (exclusive) IP**, sınırsız bandwidth, ~**$1.20–1.47/IP/ay**, 5→500+ ölçek.
- **Auth modu:** user:pass (portlar 80/1080/3128/**9999-19999**) veya IP-whitelist (kredisiz).

| İş | Endpoint |
|---|---|
| **HAVUZU listele (tek çağrı!)** | `GET /proxy/list/?mode=direct&page=1&page_size=100` → her IP doğrudan: `id (örn "d-10513"), proxy_address, port, username, password, country_code, city_name, valid, last_verification, created_at` |
| Ülke/tip filtre | `?country_code__in=TR,DE,US` (`mode=direct` = dedicated/static filtrelenebilir; `backbone` yalnız rotating pool) |
| İndir (opsiyonel) | `GET /proxy/list/download/` (`proxy_list_download_token`, Proxy Config API'den) |
| **Bozuk/yanmış IP değiştir** | `POST /proxy-replacement/proxy_replacement/` → yeni temiz IP (sayı korunur); `GET /proxy-replacement/replaced_proxy/` geçmiş |
| Aktivite/doğrulama | `GET /proxy/list/?...` `valid`/`last_verification` + `/proxy/stats/` |
| Plan/fiyat | `GET /subscription/plan/` · `GET /subscription/pricing/` |
| **Provizyon (IP satın al)** | `POST /subscription/purchase_plan/` (`proxy_type, proxy_subtype, proxy_countries={"TR":5,"DE":10}, bandwidth_limit, payment_method, recaptcha`) |

> **Kritik ayrıntı:** `purchase_plan` **recaptcha** ister → **tam-otomatik satın alma zor** → provizyon **yarı-manuel** (planı dashboard'dan al). Ama **listeleme + atama + yanmış-IP değiştirme (replacement) TAMAMEN API**. Otomatikleştirdiğimiz çekirdek budur; provizyon nadir + operatör işi.

> **Webshare avantajı (IPRoyal'e göre):** havuz **tek `GET /proxy/list/` çağrısı** — order→order-detail zinciri yok; creds doğrudan gelir. `proxy-replacement` yanmış-IP → temiz-IP akışına birebir oturur. Fiyat ~yarısı.

### 2b. IPRoyal reseller API — YEDEK (Webshare'de hedef ülke stoğu yetmezse)
- **Base:** `https://apid.iproyal.com/v1/reseller` · **Auth:** `X-Access-Token: <token>` · **⚠️ legacy API 2025-09-15 deprecate.**
- `GET /access/availability/static-residential` (stok) · `GET /products` (katalog) · `POST /orders` (provizyon) · `GET /orders`+`GET /orders/{id}` (havuz) · `POST /orders/{id}/extend` (aynı IP lease uzat) · `POST /orders/proxies/change-credentials` (IP sabit, cred rotasyonu).
- IPRoyal'de provizyon **tam-API** (recaptcha yok) ama havuz iki-adımlı (orders→detail).

> Env: `WEBSHARE_API_KEY` (birincil) · ops. `IPROYAL_RESELLER_TOKEN` (yedek). İkisi de **worker secret**; asla client/DB/plaintext'te durmaz.

---

## 3. Havuz mimarisi (pool)

### 3a. Veri modeli (yeni tablo + hesap bağı)

```sql
-- Static residential IP havuzu (provider-agnostik; ilk provider = iproyal)
create table linkedin_proxies (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid,                      -- NULL = paylaşımlı global havuz; set = tenant'a ayrılmış
  provider       text not null default 'webshare',   -- webshare | iproyal | mobile...
  ext_id         text,                      -- provider'ın proxy id'si (Webshare "d-10513" / IPRoyal order+ip) — sync anahtarı
  ip             text not null,             -- görünür IP (proxy_address; geo/teşhis; secret değil)
  host           text not null,             -- bağlantı host (Webshare'de = proxy_address)
  port           integer not null,          -- Webshare user:pass portu (ör. 9999-19999)
  username_enc   text not null,             -- AES-256-GCM
  password_enc   text not null,             -- AES-256-GCM
  country        text,                      -- ISO-2 (geo-match)
  status         text not null default 'available'
                 check (status in ('available','assigned','expired','burned','quarantined')),
  assigned_account_id uuid,                 -- 1:1 (unique kısıt aşağıda)
  leased_until   timestamptz,               -- lease/plan bitişi (bilinen sağlayıcılarda)
  last_checked_at timestamptz,              -- son sync/valid kontrolü (Webshare last_verification)
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);
-- Bir IP EN FAZLA bir hesaba bağlı (kısmi unique — burned/expired serbest kalınca tekrar atanmaz)
create unique index linkedin_proxies_one_account
  on linkedin_proxies(assigned_account_id) where assigned_account_id is not null;
create unique index linkedin_proxies_provider_ext on linkedin_proxies(provider, ext_id);

alter table linkedin_accounts add column proxy_id uuid references linkedin_proxies(id);
-- (opsiyonel) hesabın istenen coğrafyası, atama için:
-- linkedin_accounts.geo zaten var (ISO-2 doldurulursa geo-match'e girer)
```

**Değişmezler (invariants):**
1. **1 IP ↔ 1 hesap.** Kısmi unique index garanti eder; bir hesap iki IP'den çıkamaz, bir IP iki hesaba gitmez.
2. **Yanmış IP paylaşılmaz.** Hesap RESTRICTED/CHALLENGED olursa proxy `burned` → **asla** başka hesaba atanmaz (bağ korunur veya karantinaya alınır).
3. **Suppression > pool.** IP tükenirse hesap atamasız kalır → gönderim yapmaz (fail-closed), rastgele/paylaşımlı IP'ye düşmez.
4. **Provizyon idempotent.** Sync `(order_id, ip)` unique ile upsert eder; tekrar çalışınca çift satır olmaz.

### 3b. Şifreleme
`crypto.ts` (AES-256-GCM) yeniden kullanılır. Anahtar: mevcut `LINKEDIN_COOKIE_ENC_KEY` ile aynı domain veya
ayrı `LINKEDIN_PROXY_ENC_KEY` (öneri: ayrı anahtar — proxy secret'ı cookie'den bağımsız rotate edilebilsin).
`ip`/`host`/`port`/`country` plaintext (teşhis/geo); sadece `username`/`password` şifreli.

---

## 4. Akışlar

### 4a. Sync — worker job `linkedin:proxy-sync` (periyodik + manuel) — Webshare
```
1. GET /proxy/list/?mode=direct&page_size=100 (paginate) → TÜM dedicated IP'ler tek akışta,
     creds dahil (order-detail zinciri YOK)
2. Her IP'yi (provider='webshare', ext_id=id) ile linkedin_proxies'e UPSERT:
     - yeni → status='available'
     - mevcut → ip/host/port/username_enc/password_enc/valid güncelle
                (assigned_account_id + status KORUNUR — atama/yanık ezilmez)
3. Listeden düşmüş VEYA valid=false + assigned → status='burned'/'expired' → reassign (4d)
4. (opsiyonel oto-provizyon) available < eşik →
     Webshare purchase_plan RECAPTCHA ister → operatöre "plan büyüt" bildirimi (yarı-manuel);
     plan büyüyünce yeni IP'ler otomatik `/proxy/list/`e düşer → bir sonraki sync onları alır.
```
> **Provizyon yarı-manuel** (recaptcha); **sync + atama + replacement tam-API.** IPRoyal yedeğinde
> provizyon da API'dir (recaptcha yok) ama havuz iki-adımlı — provider'a göre sync adaptörü değişir, tablo aynı.

### 4b. Atama — hesap connect/validate anında (atomik)
```
Hesap ilk kez ACTIVE doğrulandığında (veya proxy_id NULL ise):
  BEGIN
    select * from linkedin_proxies
      where status='available'
        and (tenant_id is null or tenant_id = :tenant)
        and (:geo is null or country = :geo)     -- geo-match
      order by (country = :geo) desc, leased_until desc nulls last
      for update skip locked limit 1;             -- yarış-güvenli tek IP kap
    if none: hesap 'NO_PROXY' → gönderimsiz kalır (fail-closed, alarm)
    update linkedin_proxies set status='assigned', assigned_account_id=:acc where id=:id;
    update linkedin_accounts set proxy_id=:id where id=:acc;
  COMMIT
```
Atama **kalıcı**: hesap ömrü boyunca aynı IP. `proxy_session_id` (DataImpulse sticky) yalnız **fallback** için kalır.

### 4c. Kullanım — dispatcher seçimi (seam, hibrit)
`server/src/lib/linkedin/actions.ts::dispatcherFor` + `proxy.ts`:
```
if account.proxy_id:                       # STATIC (IPRoyal) — tam sticky
    p = loadProxy(proxy_id); creds = decrypt(username_enc,password_enc)
    return proxyAgentForStatic(proxy_id, `${p.host}:${p.port}`, creds)   # sessid YOK, verbatim
else:                                       # FALLBACK — DataImpulse gateway
    return proxyAgentFor(account.proxy_session_id, account.geo)          # sessid+sessttl.120+cr (mevcut)
```
`proxyAgentForStatic` yeni ama küçük: full URL'den `new ProxyAgent`, hesap başına cache.
**validate ve tüm send'ler aynı proxy'yi kullanır** (zaten proxy_id hesapta sabit).

### 4d. Sağlık / yaşam döngüsü
| Olay | Aksiyon (Webshare) | IPRoyal yedek karşılığı |
|---|---|---|
| Hesap RESTRICTED/CHALLENGED | proxy `burned` → yeni hesaba **asla** verilmez; **`POST /proxy-replacement/proxy_replacement/`** ile temiz IP al → hesaba ata | — (order iptal/yeni order) |
| Bozuk/geçersiz IP (`valid=false`) | aynı replacement endpoint → sayı korunur | — |
| Plan bitişi | Webshare abonelik bazlı (sınırsız BW, süre = abonelik); yenileme dashboard | `POST /orders/{id}/extend` (aynı IP) |
| Credential sızıntısı | Webshare'de creds proxy-config'ten dönüyor; şüphede replacement | `POST /orders/proxies/change-credentials` (IP sabit) |
| Geo uyumsuzluğu | atama zaten geo-match'li; yoksa `proxy_countries={cc:N}` ile o ülkeden IP ekle | `availability` + yeni order |

---

## 5. Seam entegrasyonu (mevcut kodla)

- `proxy.ts`: `proxyAgentFor(sessionId, country?)` **KALIR** (fallback). **YENİ** `proxyAgentForStatic(key, hostport, {user,pass})`.
- `actions.ts::dispatcherFor(account)`: yukarıdaki hibrit seçim; `ACCOUNT_COLUMNS`'a `proxy_id` (+ zaten `geo`) eklenir.
- `linkedinValidate.ts`: aynı `dispatcherFor` kullanmalı (şu an `proxyAgentFor`'u doğrudan çağırıyor → `dispatcherFor`'a taşı ki static'i de otomatik alsın).
- **Client tarafı değişmez**; opsiyonel bir "Proxy" kolonu (IP/ülke/lease bitişi) Hesaplar sekmesine eklenebilir.
- Yeni job type: `linkedin:proxy-sync` (registry + jobTypes) → Webshare `GET /proxy/list/` adaptörü (provider-adaptör deseni: `syncWebshare()` / `syncIproyal()`, ortak upsert). Yeni route: `POST /admin/linkedin/proxies/sync` (internal) + ops. manuel `POST /accounts/:id/proxy` (havuzdan ata veya elle yapıştır).
- Env: `WEBSHARE_API_KEY` worker'da. Provider-adaptörü seçimi env/DB'den (`provider='webshare'` default).

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

### 6c. Öneri
1. **Shared/private ELE — LinkedIn hesabı için kullanma** (co-tenant ban bulaşması).
2. **Dedicated static residential/ISP, hesap başına 1 IP, hesabın ülkesine geo-match.**
3. **Değer seçimi: Webshare Dedicated Static Residential ($1.47/IP)** — gerçek tek-kullanıcı + temiz API; IPRoyal'in ~yarısı. Hedef ülkelerde (özellikle TR) dedicated stok yeterliyse birincil.
4. **Yedek: IPRoyal ($2.70)** — API entegrasyonu bu dokümanda zaten yazılı; TR/stok Webshare'de zayıfsa buraya geç.
5. **Premium katman (ops.):** en değerli hesaplara **mobile** IP (en yüksek sağkalım). Seam provider-agnostik (`linkedin_proxies`) olduğu için havuzda karıştırılabilir: çoğu hesap Webshare-dedicated, kritikler mobile.
6. Düşük hacimde per-IP farkı önemsiz → sırala: **(1) dedicated tek-kullanıcı → (2) hedef-ülke stoğu → (3) temiz API**, per-IP fiyatı en son.

**Not — mevcut fallback:** bugün sertleştirdiğim DataImpulse rotating (sessid+sessttl.120+cr) yalnız **fallback/ucuz katman** olarak kalır; hesap barındırmanın birincil yolu dedicated static'tir.

---

## 7. Fazlı build planı (küçükten büyüğe, her adım bağımsız değerli)

| Faz | Kapsam | Bağımlılık |
|---|---|---|
| **P0 — manuel per-account** | `linkedin_accounts.proxy_url_enc` + `proxyAgentForStatic` + Hesaplar'da "Proxy yapıştır" alanı. **Webshare dedicated IP'sini** (`proxy_address:port:user:pass`) elle gir → o hesap tam sticky. Havuz yok. | Yok — **en hızlı, bir Webshare IP'siyle bugün test** |
| **P1 — havuz tablosu + import** | `linkedin_proxies` tablosu + `GET /proxy/list/` tek-çağrı import (veya CSV) + atomik geo-atama (4b) + `dispatcherFor` hibrit. | P0 seam + `WEBSHARE_API_KEY` |
| **P2 — API sync + replacement** | `linkedin:proxy-sync` (Webshare `/proxy/list/` → upsert), yanmış/`valid=false` → `proxy-replacement` ile temiz-IP, reassign. | P1 |
| **P3 — (yarı)oto-provizyon** | havuz eşik altında → operatöre "plan büyüt" bildirimi (Webshare recaptcha) veya IPRoyal yedeğinde tam-oto `POST /orders`; geo-stok kontrolü. | P2 + bütçe kararı |

> **Tavsiye:** **P0'dan başla** — tek migration + küçük seam. Bir **Webshare dedicated static residential IP'si** (hesabın ülkesinde) alıp yapıştırırsın → validate/invite o **sabit** IP'den çıkıyor mu bugün kanıtlarız (ipify + `linkedin_actions`). İyiyse P1 (`/proxy/list/` import) → P2 (sync+replacement) ile havuzu otomatikleştiririm.

---

## 8. Açık kararlar (senin onayına)

1. **Provider:** §6 önerisi = **Webshare Dedicated Static Residential ($1.47/IP)** birincil, **IPRoyal ($2.70)** yedek — hedef ülke stoğuna göre. Onaylıyor musun? (shared seçenekler LinkedIn için ELENDİ.)
2. **Webshare planı:** kaç IP, hangi ülkeler (`proxy_countries`)? Dedicated Static Residential subtype teyidi + hedef ülke (TR/DE/US...) stoğu. (Abonelik bazlı, sınırsız BW.)
3. **Havuz kapsamı:** global paylaşımlı mı, tenant başına ayrılmış mı? (çoklu-tenant izolasyonu istiyorsan tenant'a ayrılmış.)
4. **Şifreleme anahtarı:** cookie ile aynı mı, ayrı `LINKEDIN_PROXY_ENC_KEY` mi? (öneri: ayrı.)
5. **Başlangıç fazı:** P0 (bir Webshare IP'si yapıştır, bugün test) → sonra `/proxy/list/` havuzu? yoksa doğrudan P1/P2 (API sync)?

---

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
