# TG-LinkedIn — İlerleme & Resume Dokümanı

> Son güncelleme: 2026-07-08. Bu doküman `/clear` sonrası devam için "nereden devam edilir" özetidir.
> Tam strateji: `00_STRATEJI_VE_MIMARI.md` · Faz-0 spec/kritik: `01_FAZ0_BUILD_SPEC.md`, `02_FAZ0_CRITIQUE.md`.

## Tek cümle
Headless LinkedIn outreach modülü TG-Core'a **izole modül** olarak ekleniyor (research worker/queue'ya biniyor). **Faz 0 (iskelet) + Faz 1 (bağlan + gerçek validate) + Faz 2 (tek invite + mesaj, DRY-RUN varsayılan) kodu yazıldı, tsc yeşil, quota smoke ALL_PASS.** Canlı gönderim testi henüz yapılmadı (env key + gerçek hesap + staging gerekiyor; kod dry-run varsayılanıyla kaza-koruma altında).

## Sabit gerçekler (ezber gerektirmesin)
- **Branch:** `ssalihyetim/TG-Research` (origin'de). PROD = `main` (dokunulmadı).
- **Supabase projeleri:** PROD (müşteriler) = `ehnbhkxmsdticaodndvy` ("TG Core") · **İZOLE TEST DB** = `iehqsuludghrhosgxhnr` ("TG-Core-coldcrm-test"). Local `.env` → `SUPABASE_URL` test DB'ye bakıyor (`RESEARCH_SUPABASE_URL` yok → Model A, tüm veri test DB'de). `ROTATING_5G_PROXY` `.env`'de var.
- **Migration durumu (test DB):** uygulanmış → research 055-078, coldcall 079-082, **linkedin 083** (bu modül). UYGULANMAMIŞ → calibration `084-087` (kullanıcının calibration/geo işi; CalibrationDrawer staging'de bunlar olmadan 500 verir).
- **Env (Faz 1 canlı için gerekli, HENÜZ set değil):** `LINKEDIN_COOKIE_ENC_KEY=67093e7459874c6b7b31cd1c8ab99f0cb39f27f3a03f4eb853820f328a00cdf4` (bu session'da üretildi) · `LINKEDIN_APP_ORIGIN=<staging/local origin>`.
- **LinkedIn resmî API/OAuth invite/DM GÖNDEREMEZ** → cookie-uzantı yolu tek teknik yol (tüm ticari araçlar böyle).

## Yapıldı — Faz 0 (izolasyon + iskelet)
Migration `083_linkedin_foundation.sql`: `linkedin_accounts` (şifreli `li_at_enc`/`jsessionid_enc` + `proxy_session_id` + warmup + status enum), `linkedin_link_tokens` (tek-kullanım hash'li), `linkedin_actions` (audit+COGS). **Deny-all RLS** (ENABLE + 0 policy). Test DB'ye uygulandı + doğrulandı. Kuyruk aynen research_jobs; worker değişmedi. `crypto.ts` (AES-256-GCM, `LINKEDIN_COOKIE_ENC_KEY`, fail-closed), `proxy.ts` (sticky undici ProxyAgent). Route: `/api/linkedin` (accounts list/health/link-token/validate) + public `/api/linkedin/capture` (token-gated, auth öncesi mount). Mantine "LinkedIn Hesapları" sekmesi + TR/EN i18n. Adversarial review: 0 P0/P1, P2'ler düzeltildi.

## Yapıldı — Faz 1 (bağlan + gerçek doğrula) — KOD HAZIR, CANLI TEST YOK
- `server/src/lib/linkedin/voyager.ts` — golden-recipe header'lar, csrf tırnak-strip, **deterministik** `/me` kimlik çözümü (`data['*miniProfile']` pointer), accept-language.
- `server/src/lib/linkedin/client.ts` — `validateSession`: sticky proxy üzerinden `/voyager/api/me`, §4.4 sınıflandırma, **2xx-ama-JSON-değil → "unknown"** (ölü oturumu canlı raporlamaz), 30sn hard deadline.
- `server/src/lib/research/worker/handlers/linkedinValidate.ts` — decrypt → proxied probe → status+kimlik. **member_urn çakışması RACE-SAFE** (23505 yakala → RESTRICTED'e katla, job düşürme). PAUSED health-probe'a karşı sabit. dup-read + audit hataları kontrollü.
- `linkedin-extension/` — MV3 uzantısı: `chrome.cookies` → `/api/linkedin/capture` POST, origin doğrulamalı, https zorunlu, token pre-check, `host_permissions`'da app origin (CORS fix). README'de kurulum + iki akış (app-driven / manuel popup).
- Adversarial review (wquvwvgel): 2 P1 (member_urn yarışı; extension CORS) + 12 P2 → değerli olanlar düzeltildi. Server+client tsc 0.

## Yapıldı — Faz 2 (tek aksiyon: invite + message, DRY-RUN varsayılan) — KOD HAZIR + codex SHIP, CANLI TEST YOK
- **voyager.ts** (hot-update yüzeyi genişletildi): `invitePath`+`inviteDecorationId` (`verifyQuotaAndCreateV2`), `buildInvitePayload` (NOTSUZ varsayılan, not ≤300 hard-trim), `messagePath` (`createMessage`), `buildMessagePayload` (`originToken`=uuid-v4, `randomTrackingId`=16 kod-noktası 0-255 → `String.fromCharCode`; JSON.stringify→UTF-8→parser round-trip'i açıklandı; uuid/base64 DEĞİL), `parseProfileUrnFromHtml` (§4.3 public HTML blob regex). **decorationId/queryId CANLI doğrulanmalı.**
- **client.ts**: `WriteClassifier` + `classifyWriteResponse` (**§4.4: status'a asla tek başına güvenme** — 2xx gövdesinde gömülü quota/restrict/challenge/already_connected/cant_resend_yet taraması; temiz 2xx = tek `sent`), `sendInvite`/`sendMessage` (sticky proxy seam), `resolveProfileUrn` (best-effort GET, miss=null), `isNotSent` (refund kararı).
- **Migration 093** `linkedin_quota.sql` (izole test DB'ye UYGULI): `linkedin_try_consume_quota` (FOR UPDATE fence + UTC gün devri + cap kontrolü + artış, atomik) + `linkedin_release_quota` (aynı-gün refund, floor 0). Service-role only. `temp/linkedin-quota-smoke.sql` **ALL_PASS P1-P4**.
- **actions.ts** (paylaşılan spine): load/decrypt/dispatcher, `consumeQuota`/`releaseQuota`, `statusForWrite`+`applyWriteHealth` (403→RESTRICTED,999→CHALLENGED,401→NEEDS_REAUTH; PAUSE kalkmaz), `auditAction`. **DAILY_CAPS** Faz-2 güvenlik tavanı (invite 40 / message 60 — warmup rampası Faz 3).
- **Handler'lar** `linkedinInvite.ts` + `linkedinMessage.ts`: **DRY-RUN VARSAYILAN** (`dry_run!==false`) → decrypt/network/consume YOK, sadece plan önizlemesi (would_send, quota, target, noteless). Gerçek gönderim: ACTIVE guard (hard state=skip, throw yok=retry yakmaz) → **reserve-before-send** (atomik) → decrypt+proxy → gönder → §4.4 sınıflandır → **isNotSent ise refund** → health geçişi → tek audit satırı. message ayrıca `member_urn` (mailboxUrn) şart → yoksa `no_identity` skip. `maxAttempts=1`.
- **Route'lar**: `POST /api/linkedin/accounts/:id/invite` + `/:id/message` (202, `dry_run` body default TRUE — bare çağrı önizler; gerçek gönderim `dry_run:false` şart). Sanitized job echo. jobTypes + handler registry kaydı (`linkedin:invite`/`linkedin:message`).
- **Client**: LinkedInAccountsPanel'e **"Davet denemesi"** dry-run modal (profil URN/public id → dry_run invite → `/research/jobs/:id` poll → önizleme kartı: would_send/quota/noteless/target). Faz-1 kalan **`/linkedin/connect`** köprü sayfası (hash token → extension `CONNECT_LINKEDIN` [VITE_LINKEDIN_EXTENSION_ID] + her zaman manuel kopya fallback). i18n TR+EN. App route eklendi.
- server tsc + client `tsc -b` + eslint (yeni dosyalar) temiz.
- **Codex gpt-5.5 xhigh review: FIX FIRST (3×P1 + 2×P2) → hepsi düzeltildi:** (P1) `parseProfileUrnFromHtml` geniş fallback KALDIRILDI — scoped-only owner match, yoksa null → skip (yanlış kişiye davet engellendi); (P1) `classifyWriteResponse` yeniden yazıldı — gövdeyi JSON parse eder, hata ZARFINI yalnız status≥400/exceptionClass/errors[] varken çıkarır ve **sadece code/message/exceptionClass alanlarını** tarar (mesaj metni echo'su false-positive vermez), non-JSON 2xx = 'unknown' (sent değil); (P1) migration **094** ACTIVE gate consume RPC'sine FOR UPDATE altında katıldı (reason=not_active) + `applyWriteHealth` DB-guard `.neq('status','PAUSED')` (eşzamanlı PAUSE ezilmez); (P2) `resolveProfileUrn` `{urn,httpStatus}` döner → 401/403/999'da health geçişi; (P2) generic `POST /api/research/jobs` linkedin write tiplerini 400'le reddeder (yalnız dedike route, maxAttempts=1). Codex ayrıca dry-run'ın decrypt/network/consume YAPMADIĞINI doğruladı. `temp/linkedin-quota-smoke.sql` ALL_PASS **P1-P5** (094 ACTIVE gate dahil). tsc yeşil. **codex verify: 5/5 FIXED + 1 yeni P2** (non-JSON 2xx / `unknown` refund edilmiyordu → quota sızıntısı) → düzeltildi: `isNotSent` artık `sent`/`already_connected`/`cant_resend_yet` DIŞINDA her sonucu refund eder (dead-session 2xx slot yakmaz; nadir 5xx-sonrası-send bilinçli kabul — cap billing değil, backstop). tsc yeşil. **→ SHIP.**

## Faz 2'de KALAN
- **Canlı smoke** — gating: `LINKEDIN_COOKIE_ENC_KEY`+`LINKEDIN_APP_ORIGIN`(+ops. `VITE_LINKEDIN_EXTENSION_ID`) set → full-app staging test DB'de → gerçek hesap bağla+validate → **önce dry-run** (would_send/quota doğrula) → sonra `dry_run:false` tek invite (gerçek profil URN) → `linkedin_actions` + hesap status izle → tek mesaj. decorationId/trackingId shape'i canlı doğrula (§4.1/4.2).
- **Faz-1 kalan (2)** — canlı smoke aynı gating (yukarıdaki ile birleşti).

## Sıradaki fazlar (özet — detay 00 §9)
- **Faz 2:** `linkedin:invite` + `linkedin:message` (voyager.ts'e invite=`voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2`, message=`voyagerMessagingDashMessengerMessages?action=createMessage` — `trackingId`=16 ham byte; decorationId'ler CANLI doğrulanmalı; 200-gömülü-hata sınıflandırıcı). DRY-RUN önce.
- **Faz 3:** günlük/haftalık limitler + warmup rampası + çalışma-saati penceresi + jitter + bekleyen-davet geri çekme + checkpoint auto-pause. **+ geo & gerçek Accept-Language capture** (uzantıda; anti-detection).
- **Faz 4:** kampanya + sequence + enrollment + poll (kabul/yanıt) + workspace suppression + sender rotation.
- **Faz 5:** UI tamamlama + uyumluluk (opt-out, PII retention).

## Staging kararı (00 + memory)
research-api = dar servis (full app değil), coldcall/linkedin UI'ını servis edemez. → mevcut `tg-research` Railway projesine **full-app `tg-core-staging` servisi** ekle (test DB'ye bakan). LinkedIn worker'ı mevcut research worker'ından gelir. Prod-hardening'de LinkedIn kendi microservice'ine ayrılabilir (egress izolasyonu).

## Nasıl devam edilir (/clear sonrası)
Memory `tg-core-linkedin-automation.md` + bu doküman = tam durum. Faz 0/1/2 kod-tamam. Sıradaki seçenekler: **"Faz 3"** (günlük/haftalık limit + warmup rampası + çalışma-saati + jitter + davet geri-çekme + checkpoint auto-pause; DAILY_CAPS sabitini warmup ile değiştir) · **"Faz 4"** (kampanya/sequence/enrollment/poll/suppression/rotation) · **"canlı test için staging kur"** (env key + gerçek hesap → dry-run → gerçek invite). Migration numarası: sıradaki boş için `ls supabase/migrations` (linkedin 083+093 aldı; coldcall/research paralel numara kapıyor).
