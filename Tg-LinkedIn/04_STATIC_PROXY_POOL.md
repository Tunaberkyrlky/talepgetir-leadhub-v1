# TG-LinkedIn — Static Residential Proxy Havuzu (IPRoyal) — Araştırma & Akış Tasarımı

> Amaç: her LinkedIn hesabına **kendine ait, hiç değişmeyen** bir residential IP vermek.
> Bu doküman IPRoyal static residential (ISP) ürününü + API'sini araştırır ve proxy'leri
> **programatik olarak havuza alıp hesap-başına atama** akışını tasarlar. Karar için hazırlanmıştır.
> Kaynak kod bağlamı: `01_FAZ0_BUILD_SPEC.md` §proxy, `server/src/lib/linkedin/proxy.ts`.

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

## 2. IPRoyal API — programatik yönetim

İki API yüzeyi var; ikisini de kullanacağız:

### 2a. Reseller API (provizyon + order yönetimi) — ana yüzey
- **Base:** `https://apid.iproyal.com/v1/reseller`
- **Auth:** `X-Access-Token: <token>` (Dashboard → Settings → API; reset edilebilir) · `Content-Type: application/json`
- **⚠️ Eski (legacy) API 2025-09-15'te deprecate edildi** → yeni API kullanılmalı.

| İş | Endpoint |
|---|---|
| Stok kontrolü (ülke bazında müsait IP) | `GET /access/availability/static-residential` → `country_code, country_name, available_ips` |
| Ürün/plan/lokasyon kataloğu | `GET /products` → `product_id`, `product_plan_id` (lease planı), `product_location_id` |
| Fiyat önizleme | `GET /orders/calculate-pricing` (`product_id, product_plan_id, product_location_id, quantity, coupon_code`) |
| **Provizyon (IP satın al)** | `POST /orders` (`product_id, product_plan_id, selection.locations[]={product_location_id, quantity}, auto_extend, card_id`\|balance) → **Order ID + proxy portları + lokasyon** |
| Order listele (HAVUZ kaynağı) | `GET /orders` (filtre: `product_id, location_id, status, page, per_page`) |
| Tek order detayı (proxy string'leri) | `GET /orders/{order_id}` → tüm proxy bağlantı verisi |
| **Lease uzat (AYNI IP kalır)** | `POST /orders/{order_id}/extend` (`product_plan_id`, ops. `proxies[]`) |
| Oto-yenileme aç/kapa | `POST /orders/toggle-auto-extend` (`order_id, is_enabled, product_plan_id, payment_type, card_id`) |
| **Credential rotasyonu (IP sabit, user/pass değişir)** | `POST /orders/proxies/change-credentials` (`order_id, proxies[], username, password, random_password, is_reset`) |

### 2b. Dashboard API (listeleme/bandwidth) — yardımcı
- **Base:** `https://dashboard.iproyal.com/api/v1` · **Auth:** `Authorization: Bearer <api_key>`
- `GET /proxy-manager/proxies?type=&country=&count=&sessionType=` → **önceden formatlanmış proxy string listesi**
- `GET /usage/bandwidth`, `GET /usage` → kullanım/limit (static'te sınırsız ama izleme için)

> Env: `IPROYAL_RESELLER_TOKEN` (X-Access-Token) + ops. `IPROYAL_DASHBOARD_KEY`. İkisi de **worker secret**;
> asla client/DB/plaintext'te durmaz.

---

## 3. Havuz mimarisi (pool)

### 3a. Veri modeli (yeni tablo + hesap bağı)

```sql
-- Static residential IP havuzu (provider-agnostik; ilk provider = iproyal)
create table linkedin_proxies (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid,                      -- NULL = paylaşımlı global havuz; set = tenant'a ayrılmış
  provider       text not null default 'iproyal',
  order_id       text,                      -- IPRoyal order id (sync anahtarı)
  ip             text not null,             -- görünür IP (geo/teşhis; secret değil)
  host           text not null,             -- gw host (çoğu zaman = ip)
  port           integer not null,          -- 12323 vb.
  username_enc   text not null,             -- AES-256-GCM
  password_enc   text not null,             -- AES-256-GCM
  country        text,                      -- ISO-2 (geo-match)
  status         text not null default 'available'
                 check (status in ('available','assigned','expired','burned','quarantined')),
  assigned_account_id uuid,                 -- 1:1 (unique kısıt aşağıda)
  leased_until   timestamptz,               -- lease bitişi (extend ile ilerler)
  last_checked_at timestamptz,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now()
);
-- Bir IP EN FAZLA bir hesaba bağlı (kısmi unique — burned/expired serbest kalınca tekrar atanmaz)
create unique index linkedin_proxies_one_account
  on linkedin_proxies(assigned_account_id) where assigned_account_id is not null;
create unique index linkedin_proxies_order_ip on linkedin_proxies(order_id, ip);

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

### 4a. Sync/provizyon — worker job `linkedin:proxy-sync` (periyodik + manuel)
```
1. GET /orders (status=confirmed) → her order için GET /orders/{id} → proxy string'leri
2. Her proxy'yi (order_id, ip) ile linkedin_proxies'e UPSERT:
     - yeni → status='available'
     - mevcut → host/port/cred/leased_until güncelle (assigned_account_id/status KORUNUR)
3. leased_until geçmiş + assigned → status='expired' (aşağıda reassign)
4. (opsiyonel oto-provizyon) available sayısı eşiğin altındaysa:
     GET /access/availability/static-residential → geo seç →
     GET /orders/calculate-pricing → POST /orders (quantity=N, auto_extend=true) →
     order sonucu tekrar sync'e girer
```
> Oto-provizyon **karar/onay kapılı** olmalı (para harcar). Faz olarak en sona konur; başta manuel/CSV import.

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
| Olay | Aksiyon |
|---|---|
| Hesap RESTRICTED/CHALLENGED | proxy `burned` → yeni hesaba **asla** verilmez; hesaba yeni temiz IP atanabilir (opsiyonel) |
| Lease bitişi yaklaşıyor | `POST /orders/{id}/extend` (aynı IP korunur) veya `auto_extend` açık |
| Lease bitti + yenilenmedi | proxy `expired` → bağı düş → hesaba yeni `available` IP ata (4b) |
| Credential sızıntısı şüphesi | `POST /orders/proxies/change-credentials` → yeni user/pass sync'le (IP sabit) |
| Geo uyumsuzluğu | atama zaten geo-match'li; yoksa doğru ülkeden yeni IP provizyonla |

---

## 5. Seam entegrasyonu (mevcut kodla)

- `proxy.ts`: `proxyAgentFor(sessionId, country?)` **KALIR** (fallback). **YENİ** `proxyAgentForStatic(key, hostport, {user,pass})`.
- `actions.ts::dispatcherFor(account)`: yukarıdaki hibrit seçim; `ACCOUNT_COLUMNS`'a `proxy_id` (+ zaten `geo`) eklenir.
- `linkedinValidate.ts`: aynı `dispatcherFor` kullanmalı (şu an `proxyAgentFor`'u doğrudan çağırıyor → `dispatcherFor`'a taşı ki static'i de otomatik alsın).
- **Client tarafı değişmez**; opsiyonel bir "Proxy" kolonu (IP/ülke/lease bitişi) Hesaplar sekmesine eklenebilir.
- Yeni job type: `linkedin:proxy-sync` (registry + jobTypes). Yeni route: `POST /admin/linkedin/proxies/sync` (internal) + ops. manuel `POST /accounts/:id/proxy` (havuzdan/elle ata).

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
| **P0 — manuel per-account** | `linkedin_accounts.proxy_url_enc` + `proxyAgentForStatic` + Hesaplar'da "Proxy yapıştır" alanı. IPRoyal string'ini elle gir → o hesap tam sticky. Havuz yok. | Yok — **en hızlı, hemen IPRoyal test edilir** |
| **P1 — havuz tablosu + import** | `linkedin_proxies` tablosu + manuel/CSV import + atomik atama (4b) + `dispatcherFor` hibrit. | P0 seam |
| **P2 — API sync** | `linkedin:proxy-sync` (GET /orders → upsert), lease-expiry reassign, credential-rotate route. | IPROYAL_RESELLER_TOKEN |
| **P3 — oto-provizyon** | havuz eşik altına düşünce `POST /orders` (onay kapılı), `auto_extend`, geo-availability. | P2 + bütçe kararı |

> **Tavsiye:** **P0'dan başla** — tek migration + küçük seam, IPRoyal'i gerçek bir hesapla bugün doğrularız
> (bir static IP alıp yapıştır → validate/invite o IP'den çıkıyor mu). Sonuç iyiyse P1→P3 ile havuzu otomatikleştiririz.

---

## 8. Açık kararlar (senin onayına)

1. **Provider:** §6 önerisi = **Webshare Dedicated Static Residential ($1.47/IP)** birincil, **IPRoyal ($2.70)** yedek — hedef ülke stoğuna göre. Onaylıyor musun? (shared seçenekler LinkedIn için ELENDİ.)
2. **Lease planı:** 30 / 60 / 90 gün? `auto_extend` açık mı? (uzun lease = az yönetim, aynı IP daha uzun.)
3. **Havuz kapsamı:** global paylaşımlı mı, tenant başına ayrılmış mı? (çoklu-tenant izolasyonu istiyorsan tenant'a ayrılmış.)
4. **Şifreleme anahtarı:** cookie ile aynı mı, ayrı `LINKEDIN_PROXY_ENC_KEY` mi? (öneri: ayrı.)
5. **Başlangıç fazı:** P0 (manuel yapıştır, bugün test) → sonra havuz? yoksa doğrudan P2 (API sync)?

---

## Kaynaklar
- IPRoyal ISP API — proxies/orders: https://docs.iproyal.com/proxies/isp/api/orders · https://docs.iproyal.com/proxies/isp/api/proxies
- IPRoyal genel API rehberi: https://use-apify.com/blog/iproyal-api-proxy-management
- ISP quick-start (format/port/sticky): https://iproyal.com/quick-start-guides/static-residential-proxies/
- Reseller API (Postman): https://documenter.getpostman.com/view/10917935/Uz5KjZ8k
- Scrapoxy IPRoyal static connector: https://scrapoxy.io/connectors/iproyal/static/guide
