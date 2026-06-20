# Gmail / e-posta entegrasyon yolları — karşılaştırma

> **⚠️ NİHAİ KARAR GÜNCELLENDİ:** DWD (#5) **terk edildi** — Google, SA key oluşturmayı her
> yerde varsayılan blokluyor, key alınamadı. Seçim: **IMAP-only — app-password ile SMTP
> gönderim + IMAP okuma (#3)**. Gerekçe ve tüm yolculuk: [email-integration-retrospective.md](email-integration-retrospective.md).

Bağlam: TG Core, kullanıcının kendi mail hesabından **gönderim** ve sistemden başlatılan
thread'lere gelen **yanıtları** görmek istiyor. **Müşteri tabanı tamamen Google Workspace.**
Aşağıda konuşulan tüm yollar; artı/eksi, risk, kullanım ve kurulum aşamalarıyla.

## Özet tablo

| # | Yol | Gönderim | Okuma | Google doğrulama | CASA (yıllık denetim) | Workspace uyumu | Dayanıklılık | Durum |
|---|-----|----------|-------|------------------|------------------------|------------------|--------------|--------|
| 1 | OAuth send-only | `gmail.send` (Nango) | — (PlusVibe/dış) | Gerekli (1 kez) | Yok | Orta | Orta | İlk doküman |
| 2 | OAuth send + IMAP-attach read | `gmail.send` (Nango) | IMAP (app-pw) | Gerekli (send için) | Yok | Zayıf | Orta | Yazıldı → geri alındı |
| 3 | App-password (SMTP+IMAP) | SMTP (app-pw) | IMAP (app-pw) | **Yok** | Yok | **Zayıf** (admin-gated) | **Düşük** (2026 sonu) | Pivot → geri alınacak |
| 4 | OAuth send + readonly | `gmail.send` | `gmail.readonly` | Gerekli | **Var** | Orta | Orta | Değerlendirildi, red |
| **5** | **DWD send + reply-routing** | **DWD `gmail.send`** | **Reply-routing** | **Yok\*** | **Yok** | **En iyi** | **Yüksek** | **✅ SEÇİLEN** |
| 6 | DWD send + readonly | DWD `gmail.send` | DWD `gmail.readonly` | Yok\* | **Olası var** | İyi | Yüksek | Okuma alternatifi |
| — | Outlook | Microsoft OAuth (Nango) | Graph/IMAP | Microsoft tarafı | — | (n/a) | — | Korunuyor |
| — | Genel SMTP/IMAP | SMTP | IMAP | Yok | Yok | (Gmail dışı) | Orta | Mevcut, duruyor |

\* DWD: müşterinin **admin'i** yetkilendirir → per-user consent, "unverified app" uyarısı ve marka doğrulaması **yok** (domain-wide installation istisnası). `gmail.send` *sensitive* (restricted değil) → CASA hiç yok.

---

## 1) OAuth send-only (`gmail.send`)
- **Kullanım:** Kullanıcı Gmail'i OAuth ile bağlar; uygulamadan mail atılır. Yanıt okuma yok (yalnız PlusVibe gibi dış kaynaktan).
- **+** Standart, Google-onaylı; CASA yok.
- **−** Yanıtları göremezsin; her kullanıcı ayrı consent; doğrulanana kadar uyarı + ~100 kullanıcı limiti.
- **Risk:** Marka doğrulaması reddedilirse takılır (app adı/video/Limited Use uyumsuzluğu en sık sebep).
- **Kurulum:** OAuth consent screen + scope gerekçeleri + demo video + Search Console domain + (custom callback) → submit.

## 2) OAuth send + IMAP-attach okuma
- **Kullanım:** Gönderim OAuth; okuma için aynı Gmail'e app-password ile IMAP iliştirilir.
- **+** Okuma için restricted scope yok → CASA yok.
- **−** **İki ayrı kimlik** (OAuth + app-password) — onboarding sürtünmesi; send için yine Google doğrulaması.
- **Risk:** App-password Workspace'te admin-gated; iki sistemi senkron tutmak karmaşık.
- **Kurulum:** (1) gibi OAuth doğrulama + kullanıcı app-password üretip girer + IMAP açık olmalı.

## 3) App-password (SMTP gönderim + IMAP okuma) — *yazdığımız pivot*
- **Kullanım:** Tek app-password; `smtp.gmail.com` gönderir, `imap.gmail.com` yanıt okur. Google doğrulaması hiç yok.
- **+** En basit kod; **hiç Google doğrulaması/CASA yok**; mevcut `/smtp` akışı zaten yapıyor.
- **−** **Workspace'te kırılgan:** admin 2SV + app-password + IMAP'i açmış olmalı (çoğu güvenlik için kapatır).
- **Risk:** Google basic-auth'u söndürüyor — **2026 sonu SMTP AUTH varsayılan kapalı.** Tüketici Gmail'de iyi, Workspace'te güvenilmez.
- **Kurulum:** (Her kullanıcı) 2SV aç → app-password üret → forma gir. (Admin) app-password + IMAP açık olmalı.

## 4) OAuth send + `gmail.readonly`
- **Kullanım:** Yanıtlar kullanıcının gerçek Gmail thread'inde API ile okunur; uygulama yalnız kendi thread'leriyle sınırlar.
- **+** En temiz "gerçek Gmail thread'i" okuma.
- **−** `gmail.readonly` **restricted** → marka doğrulaması + **CASA Tier 2** (yıllık, ücretli, ~4-8 hafta).
- **Risk:** Yıllık denetim yükü/maliyeti; küçük SaaS için ağır.
- **Kurulum:** OAuth doğrulama + restricted scope onayı + Google-onaylı denetçiyle CASA.

## 5) DWD gönderim + reply-routing — ✅ SEÇİLEN
- **Kullanım:** Service account, kullanıcıyı impersonate edip `gmail.send` ile gönderir. `Reply-To: reply+<token>@mail.tibexa.com` → yanıt sizin domaininize düşer, webhook thread'e bağlar, unibox'ta görünür. **Gmail okuması yok.**
- **+** Per-user consent yok; **doğrulama yok, CASA yok**; admin-ayar bağımlılığı yok; basic-auth ölümünden etkilenmez. **Workspace için kalıcı/temiz.**
- **−** Yeni kod (GCP SA + JWT impersonation, Nango'nun yerine); inbound mail altyapısı (MX + parse) gerekir; yanıt kullanıcının kendi Gmail'inde "okunmuş thread" olarak görünmez (sistemde görünür).
- **Risk:** Müşteri admin'i DWD yetkilendirmesini yapmazsa o müşteri gönderemez (ama tek, standart B2B adımı). Inbound domain/DNS doğru kurulmalı.
- **Kurulum:**
  1. **(Siz, 1 kez)** GCP service account + JSON key → `GOOGLE_DWD_SA_KEY`; DWD aç.
  2. **(Her müşteri admin, 1 kez)** Admin console → Security → API controls → Domain-wide delegation → Client ID'yi `gmail.send` ile yetkiler.
  3. **(Siz, 1 kez)** Inbound subdomain (`mail.tibexa.com`) + MX → parse sağlayıcı (Cloudflare Email Routing ücretsiz / Mailgun / SendGrid / Postmark / Resend inbound).
  4. **(Kod)** `gmailDwd.ts` gönderim; tokenli `Reply-To`; `POST /api/webhooks/inbound-reply`.

## 6) DWD gönderim + DWD `gmail.readonly`
- **Kullanım:** (5) gibi gönderim; okuma da API'den ama admin-yetkili DWD ile, per-user consent'siz. Yanıt gerçek Gmail thread'inde okunur.
- **+** Gerçek Gmail thread'i; per-user consent yok.
- **−** `gmail.readonly` restricted → **dış müşteri verisi için olası yıllık CASA** (DWD ile bile durabilir; kaynaklar çelişiyor → Google'la netleştir).
- **Risk:** CASA çıkarsa yıllık maliyet/yük; "domain-wide install istisnası CASA'yı da kapsıyor mu" belirsiz.
- **Kurulum:** (5)'in 1-2. adımları + scope'a `gmail.readonly` eklenir + gerekirse CASA.

---

## Karar
- **Gönderim:** (5) **DWD `gmail.send`** — Workspace-native, doğrulama/CASA yok, kalıcı.
- **Okuma:** (5) **reply-routing** — restricted scope/CASA yok, admin-ayar bağımsız, "sistemde thread devamı" hedefini karşılar.
- **Outlook:** Microsoft OAuth (Nango) korunur (Microsoft basic-auth'u kapattı).
- **Geri alınacak:** (3) app-password Gmail akışı.

## Kaynaklar
- [Restricted scope verification (Google)](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
- [Winding down less secure apps (Google Workspace Updates)](https://workspaceupdates.googleblog.com/2023/09/winding-down-google-sync-and-less-secure-apps-support.html)
- [Turn POP & IMAP on/off for users (Admin Help)](https://support.google.com/a/answer/105694?hl=en)
- [Domain-wide delegation best practices (Google)](https://knowledge.workspace.google.com/admin/apps/domain-wide-delegation-best-practices)
- [Google CASA 2025: tiers & costs](https://deepstrike.io/blog/google-casa-security-assessment-2025)
