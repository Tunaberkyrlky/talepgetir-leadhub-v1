# TG-LinkedIn — Strateji, Anti-Ban Playbook ve Mimari

> Durum: **Araştırma tamamlandı, build başlıyor.** 2026-07-07.
> Kaynak repo (yalnızca pattern): `/Users/salihyetim/linkedin-scr` (Sales Nav lead *scraper* — invite/mesaj kodu YOK).
> Hedef stack: TG Core = Express + Supabase (ORM yok) + `research_jobs` Postgres kuyruğu + React/Mantine.

Bu doküman, 6 paralel web-araştırma ajanının (rakip araçların — Expandi, HeyReach, Waalaxy, Dux-Soup, Linked Helper, Dripify, Skylead, MeetAlfred, Zopto, lemlist, La Growth Machine, PhantomBuster, Unipile — canlı dokümanları + açık kaynak reverse-engineering repoları) bulgularının sentezidir.

---

## 0. Yönetici özeti + dürüst risk verdikti

**Ne kuruyoruz:** Ekip üyeleri kendi LinkedIn oturumlarını cookie ile bağlar; TG Core onlar adına **headless** olarak bağlantı isteği + mesaj gönderir. Hesap başına **sabit (sticky) mobil 5G IP**, muhafazakâr limitler, insansı zamanlama, checkpoint'te otomatik durdurma.

**Dürüst risk verdikti (build kararını değiştirmez ama mimariyi şekillendirir):**
1. **2026'da LinkedIn davranıştan çok cloud/proxy MİMARİSİNİ hedefliyor.** Topluluk raporları HeyReach/Expandi/Aimfox gibi araçlarda Oca–Mar 2026'da hesapların ~%40'ının limitlere uysa bile kısıtlandığını söylüyor (temkinli okunmalı, ama tutarlı). → Bu yüzden `LinkedInClient` seam'ini koruyoruz: gerekirse yürütmeyi kullanıcının kendi tarayıcısına (uzantı) çevirebilelim.
2. **Sunucu-replay'in kör noktası:** Gerçek tarayıcı gerektiren parmak izi (navigator.webdriver, canvas, fare telemetrisi) sunucudan taklit edilemez. Ama IP itibarı + UA tutarlılığı + hız/kabul-oranı sunucudan görülebilir ve KONTROL EDİLEBİLİR. Bizim işimiz görülebilenleri temiz tutmak.
3. **Chrome DBSC (Chrome 146, Nis 2026):** Cookie'yi cihaz donanımına kriptografik bağlıyor. LinkedIn benimserse export-cookie replay tamamen kırılır. Modülü, executor'ı değiştirilebilir tutarak buna karşı hedge ediyoruz.
4. **ToS/GDPR:** LinkedIn User Agreement §8.2 otomasyonu yasaklıyor (yaptırım = hesap kapatma, sözleşmesel). GDPR/PECR: PII saklamada legitimate-interest gerekçesi + opt-out zorunlu.

**Verdikt:** Kullanıcının seçtiği gibi headless kuruyoruz, ama (a) executor seam'i, (b) muhafazakâr varsayılanlar, (c) hesap başı sticky mobil IP, (d) checkpoint auto-pause ile. Extension-executor'ı Faz 2 fallback olarak açık bırakıyoruz.

---

## 1. Güvenli varsayılan LİMİTLER (config'e sabitlenecek)

Rakip araçların yakınsadığı muhafazakâr bant. **Yeni/soğuk hesap için düşük başla, yavaş yükselt.**

| Aksiyon | Yeni hesap (warmup) | Plato (ısınmış) | LinkedIn tavanı | Notlar |
|---|---|---|---|---|
| Bağlantı isteği (invite) | 5–20/gün | 20–40/gün | ~100/hafta (Sales Nav 150–200) | Haftalık pencere rolling 7 gün |
| **Notlu** (kişiselleştirilmiş) invite | — | — | **ayda ~5** (bazı kaynak: 3) | → **varsayılan NOTSUZ invite** |
| Mesaj (1. derece) | 20–40/gün | invite'ın ~1.5–3× | yumuşak | yanıt gelince DUR |
| Profil ziyareti | 40/gün | 80–250/gün | commercial-use ~250–350/ay | warmup/karıştırma için |
| InMail | — | — | Sales Nav **50/ay** | v1'de kapsam dışı |

**Warmup rampası (Expandi/Zopto step-fonksiyonu):** başla 5/gün → her 1–2 günde +2–3 → plato 20–40/gün (~2 hafta). Warmup toggle'ı resetlemek ilerlemeyi sıfırlar → durumu DB'de kalıcı tut.

**Günlük dağıtım:** yalnız çalışma-saati penceresinde (yerel ~08:00–18:00, 8–10 saat), hacmi 14-günlük rolling ortalamanın ±%10–20'sinde tut (sabit sayı = clustering imzası).

---

## 2. İnsansı zamanlama (scheduler kuralları)

- **Çalışma saatleri:** hesap zaman dilimine göre pencere (varsayılan Pzt–Cum 09–18). Hafta sonu opsiyonel kapalı. 03:00'te veya hafta sonu gönderim = non-human sinyali.
- **Aksiyon arası gecikme (jitter):** ziyaret ~1 dk, invite/mesaj ~2dk30sn **±%20 rastgele**. Sabit interval YOK. (Dux-Soup: 25–125/saat, her 20 aksiyonda 5 dk mola.)
- **Aksiyon karıştırma:** invite'tan önce düşük-riskli dokunuşlar (profil ziyaret, gönderi beğen) — "like-then-connect" ~%25 daha yüksek kabul. v1'de en azından invite öncesi profil-ziyaret opsiyonu.
- **Bekleyen davet hijyeni:** yanıtlanmayan davetleri **7–30 günde** otomatik geri çek (aşırı pending = haftalık-limit uyarısı tetikler). Yeniden davet öncesi ~21 gün cooldown.
- **Kabul/yanıt tespiti:** inbox'ı **~3 saatte bir** yokla (Linked Helper varsayılanı). Kabul → 1. mesaj adımını tetikle. Yanıt → sekansı DURDUR.

---

## 3. Anti-detection / proxy gereksinimleri

- **Proxy:** hesap başına **1 adet ayrılmış (paylaşılmayan) STICKY IP.** Rotating = açık red flag. Sınıf hiyerarşisi: **mobil 4G/5G > residential > ISP-static > datacenter (datacenter = anında ban)**. → Kullanıcının 5G'si en iyi sınıf; tek şart sticky-per-account.
- **Geo-match:** IP, hesabın olağan lokasyonuna yakın olsun (connect'te ülke/şehir seçtir). Uyarı: IP-geolocation DB'leri tutarsız (bir HeyReach kullanıcısının Almanya proxy'si LinkedIn'e "Bağdat" göründü) — kontrol edemeyeceğimiz artık risk.
- **User-Agent:** cookie'yi oluşturan tarayıcının **gerçek UA'sını yakala ve AYNEN kullan** (Unipile bunu "account stability için şiddetle önerir"). Uzantı zaten `navigator.userAgent` gönderiyor → DB'ye kaydet, her istekte kullan. Accept-Language'i de proxy coğrafyasına eşle.
- **Tek araç kuralı:** bir hesapta aynı anda başka otomasyon çalışmasın (çakışan pattern'ler bireysel limitler içinde olsa bile flag'lenir).
- **Sunucudan görülebilen sinyaller** (temiz tutulacak): IP/ASN itibarı, impossible-travel/olağan-IP uyuşmazlığı, eşzamanlı uzak oturum, yazma-hızı/kabul-oranı, UA tutarlılığı.

---

## 4. Voyager WRITE API config (hot-update surface)

> **Kritik disiplin:** `decorationId`/endpoint/queryId AYLAR içinde döner (`-1`→`-2` gözlendi). Asla uzun-vadeli hardcode etme; tek dosyada topla, canlı doğrulamayla güncelle. (linkedin-scr'deki `voyager.ts` "hot-update surface" pattern'i aynen taşınacak.)

### 4.1 Invite (bağlantı isteği) — güncel (2025–26, 3 bağımsız repoda doğrulandı)
```
POST /voyager/api/voyagerRelationshipsDashMemberRelationships
     ?action=verifyQuotaAndCreateV2
     &decorationId=com.linkedin.voyager.dash.deco.relationships.InvitationCreationResultWithInvitee-2
```
Payload (notsuz):
```json
{ "invitee": { "inviteeUnion": { "memberProfile": "urn:li:fsd_profile:<PROFILE_ID>" } } }
```
Notlu: üstüne `"customMessage": "..."` ekle. Not limiti: **tüm planlarda düz 300 karakter** (eski 200/300 ayrımı güncel değil).
Header'lar ("golden recipe"): `csrf-token: <JSESSIONID value>`, `x-restli-protocol-version: 2.0.0`, `accept: application/vnd.linkedin.normalized+json+2.1`, `content-type: application/json`, `cookie: li_at=...; JSESSIONID="ajax:..."`.
Legacy (STALE, fallback bilgisi): `POST /voyager/api/growth/normInvitations`.

### 4.2 Mesaj (1. derece) — canlı doğrulandı (2026-06-14)
```
POST /voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage
```
Yeni konuşma (`hostRecipientUrns`):
```json
{
  "message": { "body": {"attributes": [], "text": "Merhaba!"}, "originToken": "<uuid-v4>", "renderContentUnions": [] },
  "mailboxUrn": "urn:li:fsd_profile:<MY_ID>",
  "trackingId": "<16 HAM rastgele byte — UUID DEĞİL, base64 DEĞİL>",
  "dedupeByClientGeneratedToken": false,
  "hostRecipientUrns": ["urn:li:fsd_profile:<RECIPIENT_ID>"]
}
```
Yanıt (mevcut thread'e): `hostRecipientUrns` yerine `message.conversationUrn` koy.
**trackingId tuzağı:** 16 ham byte doğrudan char'a map edilmeli; UUID string yollarsan çıplak `400`. Mevcut konuşma var mı → `GET /voyagerMessagingDashComposeOptions/...` → `existingConversationUrn`.

### 4.3 Profil URN çözümleme
En güvenilir: public profil HTML sayfasını çek, inline `<code id="bpr-guid-N">` JSON blob'undan `identityDashProfilesByMemberIdentity` → `entityUrn` regex ile ayıkla (GraphQL CSRF tuhaflıklarını atlar). Alternatif: GraphQL `voyagerIdentityDashProfiles` (queryId döner, 403 eğilimli).

### 4.4 Hata taksonomisi (HTTP status'a ASLA tek başına güvenme)
- **429** → rate limit / haftalık kota bitti.
- **403** (write'ta) → çoğunlukla hesap kısıtı/checkpoint, expired session değil.
- **409** veya **400** body `{"data":{"code":"CANT_RESEND_YET"}}` → zaten pending/duplicate davet.
- **200 + gömülü hata** (`exceptionClass`, `errors[]`) → LinkedIn başarısız write'ı 200'leyebilir → body'de `restrict|challenge`, `quota|limit`, `already_connected` substring taraması yap.
- **999** → IP/anomali kaynaklı, write-spesifik değil, düşük güven.
- **401** → session geçersiz → hesabı NEEDS_REAUTH işaretle, kuyruğu durdur, kullanıcıya bildir.

---

## 5. Sekans / kampanya modeli + dedup

**Standart akış:** `profil ziyaret → invite (varsayılan notsuz) → 5–15 gün bekle → [kabul edildiyse] mesaj 1 → 3–7 gün → mesaj 2 → mesaj 3`. Dallanma: kabul/yanıt/N-gün-kabul-yok(geri çek).

**Durdurma koşulları:** herhangi bir yanıt sekansı anında durdurur (global stop: yanıt / toplantı / manuel do-not-contact tag'i tüm hesap ve kampanyalarda durdurur).

**Dedup / suppression (çekirdek — HeyReach modeli):**
- **Workspace-genelinde central suppression list:** aynı lead'e iki ekip üyesi asla dokunamaz.
- Bir lead aynı anda tek aktif kampanyada.
- Zaten 1. derece bağlantı / pending davet olanları otomatik atla ("already_connected"/"CANT_RESEND_YET").
- Global blocklist (do-not-contact) + opt-out.

**Çoklu-hesap:** bir kampanyaya birden çok gönderen ata, per-account limitleri onurlandırarak **sender rotation**; unified inbox (v2).

**Kişiselleştirme:** `{firstName} {lastName} {company}` + CSV custom değişkenler + spintax (`{{A|B}}`) pattern-detection'ı azaltır.

---

## 6. Hesap sağlığı + uyumluluk

- **Auto-pause tetikleyicileri:** checkpoint/challenge ekranı, 429/999, "restricted account", 403-write serisi, kabul oranı ~%20 altına düşüş, invite/mesaj hata serisi, LinkedIn "otomatik aktivite" uyarı banner'ı.
- **Checkpoint'te davranış:** hesabı+kampanyayı durdur, pending kuyruğu boşalt/beklet, kullanıcıya "re-login/verify gerek" bildir. Hiçbir araç CAPTCHA/kimlik doğrulamayı otomatik çözmez — insan müdahalesi.
- **Session canlılık:** periyodik hafif smoke-test (`/voyager/api/me`) + 401 tespiti → NEEDS_REAUTH.
- **Uyumluluk (builder yükümlülüğü):** opt-out/unsubscribe (CAN-SPAM 10 iş günü, PECR B2B'ye de uygulanır), scraped PII saklama sınırı, legitimate-interest için belgelenmiş LIA. hiQ v. LinkedIn: CFAA riski düşük ama ToS/sözleşme riski gerçek.

---

## 7. TG Core mimarisine oturtma

`linkedin-scr`'den **pattern'ler** taşınır (kod değil — stack farklı):

| linkedin-scr (kaynak) | TG-LinkedIn (hedef, TG Core stack) |
|---|---|
| Prisma modelleri | Supabase migration'ları (izole `linkedin_*` tabloları) |
| BullMQ + Redis | mevcut `research_jobs` Postgres kuyruğu (atomic claim/lease/heartbeat/reaper) |
| `LinkedInClient` seam (ServerLinkedInClient) | aynı seam; `ServerLinkedInClient` proxy-aware `undici` `ProxyAgent` ile |
| `config/voyager.ts` hot-update | `server/src/lib/linkedin/engine/voyager.ts` (invite+message+profile config) |
| AES-256-GCM `crypto.ts` | TG Core'da cookie şifreleme (env: `LINKEDIN_COOKIE_ENC_KEY`) |
| MV3 extension (cookie capture) | aynı extension pattern'i, TG Core origin'ine POST |
| Next.js API routes | Express router `server/src/routes/linkedin/*` |
| Next.js dashboard | Mantine panel `client/src/components/linkedin/*` |

**Yeni job type'ları** (`jobTypes.ts`'e eklenecek, handler registry'ye register):
- `linkedin:validate` — session canlılık + UA/proxy sağlık.
- `linkedin:invite` — tek bağlantı isteği (kota-hold + fenced).
- `linkedin:message` — tek mesaj (kabul sonrası / sekans adımı).
- `linkedin:poll` — kabul/yanıt tespiti (periyodik).
- `linkedin:sequence-tick` — sekans motorunu ilerleten scheduler.
- `linkedin:withdraw` — bekleyen davet geri çekme.

**Proxy katmanı:** `ROTATING_5G_PROXY` env (base endpoint + kimlik). Hesap başına **sticky session token** (`linkedin_accounts.proxy_session_id`) → `undici ProxyAgent`'a geçir. Rotating değil; sticky.

---

## 8. Veri modeli (taslak — izole `linkedin_*` tablolar, tenant-scoped, RLS)

- `linkedin_accounts` — tenant_id, owner_user_id, li_at_enc, jsessionid_enc, user_agent, proxy_session_id, geo, status(ACTIVE|NEEDS_REAUTH|CHALLENGED|RESTRICTED|PAUSED), warmup_day, last_validated_at, daily_counters (jsonb), timezone, working_hours.
- `linkedin_leads` — tenant_id, profile_urn, public_id, first/last/company/title, source, dedupe_key (unique per tenant).
- `linkedin_suppression` — tenant_id, dedupe_key, reason (connected|opted_out|do_not_contact|replied), created_by.
- `linkedin_campaigns` — tenant_id, name, status, sender_account_ids[], settings(caps/hours/withdraw_days).
- `linkedin_sequence_steps` — campaign_id, order, type(visit|invite|message|wait|withdraw), wait_days, template, branch.
- `linkedin_enrollments` — campaign_id, lead_id, account_id, current_step, state(pending|invited|accepted|messaged|replied|stopped|failed), next_action_at.
- `linkedin_actions` — audit/append-only: account_id, lead_id, type, status, request/response classifier, error, created_at (COGS + rate-limit sayacı + hesap-sağlığı buradan).
- `linkedin_link_tokens` — extension eşleme (tek-kullanımlık, hash).

---

## 9. Fazlı build planı

**Faz 0 — İzolasyon + sunucu iskeleti (TAMAMLANDI 2026-07-08):** `linkedin` modül klasörleri; migration `083` (3 tablo + deny-all RLS + `research_jobs` uyumu); crypto (`LINKEDIN_COOKIE_ENC_KEY`) + sticky proxy util; `linkedin:validate` job tipi + Faz-0 stub handler; **çalışan sunucu tarafı**: public cookie-capture endpoint (token-gated) + `/api/linkedin` account route'ları + Mantine "LinkedIn Hesapları" paneli. (Sunucu iskeleti hazır ki Faz 1 yalnızca extension + gerçek validate olsun — strateji §9/spec §0 boundary reconcile.) Server+client tsc temiz; adversarial review 0 P0/P1.

**Faz 1 — Bağlan + gerçek doğrula:** MV3 extension (cookie yakala → `/api/linkedin/capture`'a POST) + `linkedin:validate` stub'ını gerçek `/voyager/api/me` çağrısına doldur (decrypt + sticky proxy + gerçek UA; §4.4 sınıflandırma; member_urn çakışma stratejisi). Canlı smoke (bir gerçek hesapla).

**Faz 2 — Tek aksiyonlar:** `ServerLinkedInClient` proxy-aware; `voyager.ts` invite+message config; profil-URN çözümleme; `linkedin:invite` + `linkedin:message` handler'ları (kota-hold, hata taksonomisi, 200-gömülü-hata sınıflandırıcı). **DRY-RUN modu** (gerçek göndermeden "ne giderdi" önizleme) önce. Codex review + canlı smoke.

**Faz 3 — Limitler + zamanlama:** per-account günlük/haftalık sayaçlar, warmup rampası, çalışma-saati penceresi, jitter, bekleyen-davet geri çekme. Checkpoint auto-pause + NEEDS_REAUTH akışı.

**Faz 4 — Sekans + dedup:** kampanya + sequence-step + enrollment modeli; `linkedin:sequence-tick` + `linkedin:poll` (kabul/yanıt); workspace suppression + opt-out; sender rotation.

**Faz 5 — UI tamamlama + sertleştirme:** kampanya kurucu, enrollment durumları, hesap-sağlığı göstergesi, unified inbox (v2). Uyumluluk (opt-out, PII retention).

Her faz: **codex review → canlı smoke → devam.** İzole test DB; prod temiz. Kullanıcı açıkça `versiyonla` demeden commit YOK.
