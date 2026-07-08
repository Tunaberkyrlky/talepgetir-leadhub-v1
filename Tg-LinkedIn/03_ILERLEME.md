# TG-LinkedIn — İlerleme & Resume Dokümanı

> Son güncelleme: 2026-07-08. Bu doküman `/clear` sonrası devam için "nereden devam edilir" özetidir.
> Tam strateji: `00_STRATEJI_VE_MIMARI.md` · Faz-0 spec/kritik: `01_FAZ0_BUILD_SPEC.md`, `02_FAZ0_CRITIQUE.md`.

## Tek cümle
Headless LinkedIn outreach modülü TG-Core'a **izole modül** olarak ekleniyor (research worker/queue'ya biniyor). **Faz 0 (iskelet) + Faz 1 (bağlan + gerçek validate) kodu yazıldı, adversarial review'lı, tsc yeşil.** Canlı test henüz yapılmadı (env key + gerçek hesap + staging gerekiyor).

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

## Faz 1'de KALAN
1. **Client `/linkedin/connect` köprü React sayfası** (app-driven connect akışı) — ertelendi (kullanıcı client'ı canlı düzenliyordu). **Manuel popup akışı çalışıyor**, bu sayfa olmadan da test edilebilir.
2. **Canlı smoke** — gating: `LINKEDIN_COOKIE_ENC_KEY`+`LINKEDIN_APP_ORIGIN` set → calibration 084-087 test DB'ye uygula → full-app staging'i test DB'de ayağa kaldır → gerçek LinkedIn hesabı bağla → `linkedin:validate` job'ını izle (`linkedin_actions` satırı + `linkedin_accounts.status`/`member_urn`).

## Sıradaki fazlar (özet — detay 00 §9)
- **Faz 2:** `linkedin:invite` + `linkedin:message` (voyager.ts'e invite=`voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2`, message=`voyagerMessagingDashMessengerMessages?action=createMessage` — `trackingId`=16 ham byte; decorationId'ler CANLI doğrulanmalı; 200-gömülü-hata sınıflandırıcı). DRY-RUN önce.
- **Faz 3:** günlük/haftalık limitler + warmup rampası + çalışma-saati penceresi + jitter + bekleyen-davet geri çekme + checkpoint auto-pause. **+ geo & gerçek Accept-Language capture** (uzantıda; anti-detection).
- **Faz 4:** kampanya + sequence + enrollment + poll (kabul/yanıt) + workspace suppression + sender rotation.
- **Faz 5:** UI tamamlama + uyumluluk (opt-out, PII retention).

## Staging kararı (00 + memory)
research-api = dar servis (full app değil), coldcall/linkedin UI'ını servis edemez. → mevcut `tg-research` Railway projesine **full-app `tg-core-staging` servisi** ekle (test DB'ye bakan). LinkedIn worker'ı mevcut research worker'ından gelir. Prod-hardening'de LinkedIn kendi microservice'ine ayrılabilir (egress izolasyonu).

## Nasıl devam edilir (/clear sonrası)
Memory `tg-core-linkedin-automation.md` + bu doküman = tam durum. Devam için kullanıcıya sor: "084-087 uygula" / "connect sayfası" / "Faz 2" / "canlı test için staging kur".
