# E-posta entegrasyonu — yolculuk raporu (gönderim + yanıt okuma)

**Amaç:** Kullanıcılar TG Core'dan kendi mail hesabından **mail göndersin**, ve sistemden
başlatılan thread'lere gelen **yanıtları** sistemde görsün. **Müşteri tabanı tamamen Google
Workspace.** Bu rapor hangi yolların denendiğini, neyin neden olmadığını ve yol boyunca yapılan
**yanlış varsayımları** kayda geçirir.

---

## TL;DR — nerede karar kıldık
- **Gönderim:** kullanıcının kutusundan, native.
- **Okuma:** mailbox'ı **IMAP ile okumak** (PlusVibe'ın yaptığı) — reply-routing **değil**.
- **Önde gelen seçim:** **IMAP-only** (app-password ile SMTP gönderim + IMAP okuma). Müşteriler
  zaten PlusVibe'a kutularını IMAP ile bağlıyor; ayrıca "outreach için ayrı/yeni kutu açın"
  diyeceğiz → IMAP + app-password kesin açılabilir. Hiç Google Cloud / OAuth doğrulaması gerekmez.

---

## Denenen yollar

| # | Yol | Gönderim | Okuma | Neden seçildi | Neden bırakıldı / olmadı |
|---|-----|----------|-------|---------------|---------------------------|
| 1 | OAuth send-only | `gmail.send` (Nango) | — | İlk durum (test'te çalışıyordu) | Yanıt okuma yok |
| 2 | OAuth + IMAP-attach | `gmail.send` | IMAP (app-pw) | Okumayı CASA'sız eklemek | İki ayrı kimlik; #3 ile sadeleşti |
| 3 | App-password (SMTP+IMAP) | SMTP (app-pw) | IMAP (app-pw) | Tek kimlik, **doğrulama yok** | "Workspace'te admin kapatır" diye eronik bırakıldı (sonra yanlış çıktı) |
| 4 | OAuth + `gmail.readonly` | `gmail.send` | `gmail.readonly` | Gerçek Gmail thread'i okuma | **Restricted scope → CASA** (yıllık denetim) |
| 5 | DWD + reply-routing | DWD `gmail.send` | reply-routing | Per-user consent yok, CASA yok | **SA key oluşturma her yerde bloklu** (aşağıda) — key alınamadı |
| 6 | Per-user OAuth + reply-routing | `gmail.send` (Nango) | reply-routing | OAuth, SA-key policy'sinden etkilenmez | Reply-routing karşı tarafta **iz** bırakır (cold tool'ların kaçındığı şey) |
| 7 | **IMAP-only (PlusVibe'ı aynala)** | SMTP (app-pw) | IMAP (app-pw) | Native/izsiz, cold-kanıtlı, GCP yok, müşteriler zaten IMAP'te | **← şu anki önde gelen seçim** |

---

## Kronolojik yolculuk

1. **Privacy policy** ile başladık (Google OAuth `gmail.send` doğrulaması için). Sonra ürünün
   gerçekten yaptıklarına göre düzelttik (mail içeriği, IMAP/PlusVibe okuma, PostHog, alt-işleyenler).
2. **Yeni istek:** sistemden atılan thread'lerin yanıtlarını görmek.
   - `gmail.readonly` denendi → **restricted → CASA** → elendi (#4).
   - **#2** (OAuth send + IMAP-attach) yazıldı.
3. **Kullanıcı içgörüsü:** "App-password zaten ekleniyorsa API'yi ayırmaya gerek yok; tek kimlikle
   hem gönder hem oku." → **#3**'e geçildi; bunun **Google doğrulamasını tamamen kaldırdığı** fark edildi.
4. **Kullanıcı:** "Tüm müşteriler Workspace." → #3 için "admin app-password/IMAP'i kapatabilir +
   Google basic-auth'u 2026 sonu söndürüyor" endişesiyle **#3 kırılgan** sayıldı.
5. **#5 DWD'ye pivot:** admin bir kez yetkiler, per-user consent yok, `gmail.send` sensitive →
   CASA yok. Kod yazıldı (`gmailDwd.ts`, `/google-workspace`, modal, env).
6. **DWD kurulumu duvara tosladı (çok adım):**
   - `iam.disableServiceAccountKeyCreation` org policy'si SA key oluşturmayı blokluyor.
   - Override için **Organization Policy Administrator** (GCP) rolü gerekti.
   - **Workspace süper admin ≠ GCP org admin** (ayrı sistemler) — bootstrap kilidi.
   - Sadece **managed** constraint vardı; override işe yaramadı / yayılmadı.
   - **Kişisel hesap (Plan B) bile blokladı** — Google artık SA key oluşturmayı org'suz hesaplarda
     da varsayılan kapatıyor (Secure by Default). → **SA-key yolu ortamda kapalı.**
7. **#6 per-user OAuth'a geri dönüş:** kritik nokta — **OAuth Client ID, service account key DEĞİL**;
   o policy onu bloklamaz. Kod OAuth'a döndürüldü.
8. **Okuma için reply-routing** önerildi; mekanik + karşı taraf etkisi konuşuldu → reply-routing'in
   **cross-domain Reply-To izi** bıraktığı dürüstçe ortaya kondu.
9. **Kullanıcı:** "PlusVibe cold'da reply-routing yapıyor ve çalışıyor." →
   **Düzeltildi:** PlusVibe (ve tüm cold tool'lar) reply-routing **yapmaz**, mailbox'ı **IMAP ile okur**.
   Cold'ın izsiz olmasının sebebi tam da bu (native). → **#7'ye yönelindi.**
10. **IMAP-only vs hibrit** karşılaştırıldı; "müşteriler kendi/ayrı iş maili bağlayacak" bilgisiyle
    **IMAP-only** öne çıktı.

---

## Yapılan yanlış varsayımlar (en değerli kısım)

1. **"Ayrı/kişisel GCP hesabı SA-key policy'sini atlar."** → **Yanlış.** Google, SA key oluşturmayı
   artık org'suz kişisel hesaplarda bile varsayılan blokluyor (Secure by Default). En çok zaman bu yanlışta gitti.
2. **"DWD temiz Workspace yoludur, hemen kurulur."** → DWD mimari olarak doğru ama **indirilen SA key'e
   muhtaç**, ve o key bu ortamda alınamıyor. Önceden SA-key engelinin yaygınlığı kontrol edilmeliydi.
3. **"App-password Workspace'te kırılgan, eleyelim (#3)."** → **Aşırı temkinli çıktı.** Müşteriler zaten
   PlusVibe'a kutularını **IMAP ile bağlıyor** → o kutularda IMAP/app-password zaten açık. #3 prematüre bırakıldı.
4. **"PlusVibe reply-routing yapıyor (kullanıcı varsayımı)."** → **Yanlış.** PlusVibe SMTP gönderir,
   **IMAP okur** (dokümanı: *"IMAP retrieves messages, SMTP sends"*). Cold tool'lar reply-routing'den **kaçınır**.
5. **"Reply-routing cold-kanıtlı, izsizdir."** → Tersi: cold'ı izsiz yapan şey **native IMAP okuma**;
   reply-routing **iz bırakır** (cross-domain Reply-To).
6. **"Workspace süper admin GCP org policy'sini düzenleyebilir."** → Hayır; Workspace yönetimi ile GCP IAM
   **ayrı sistemler**. Süper admin'in tek özel gücü GCP'de kendine org-admin bootstrap'ı (o da ayrı adım).
7. **Yanlış constraint düzenlendi:** `iam.managed.disableServiceAccountKeyCreation` (managed) ile sade
   `iam.disableServiceAccountKeyCreation` karıştırıldı (küçük, ama zaman kaybettirdi).

---

## Teknik öğrenilenler (kalıcı notlar)

- **SA key oluşturma artık varsayılan kapalı** (Secure by Default), org'suz hesaplarda bile. SA-key'e dayalı
  yaklaşımlar (klasik DWD) bu ortamda pratik değil. Keyless tek seçenek Workload Identity Federation (ağır).
- **OAuth Client ID ≠ service account key.** OAuth client oluşturmak bu policy'den **etkilenmez**.
- **DWD cross-org çalışır** ama yine de indirilen key ister → engel key'in kendisi.
- **Cold email tool'ları mailbox'ı IMAP/OAuth ile okur** (unibox), reply-routing yapmaz → native, izsiz.
  Bizim müşteriler zaten PlusVibe'a IMAP ile bağlı → IMAP yolu onlarda zaten çalışıyor.
- **Basic-auth ufuk riski:** Google 2026 sonu SMTP AUTH'u varsayılan kapatacak ama admin açık tutabilir;
  PlusVibe kullanıcıları da aynı riskte, sektör hâlâ bununla dönüyor. Ayrı/kontrollü kutuda yönetilebilir.
- **Gönderim teslimatı:** SMTP (smtp.gmail.com) ve OAuth (`gmail.send`) ikisi de Gmail sunucusundan,
  native SPF/DKIM → teslimat farkı yok.

---

## Mevcut kod durumu (bu rapor anında)
- **Client:** E-posta paneli **OAuth** (Gmail/Outlook OAuth + SMTP butonu). DWD/app-password Gmail
  preset modalları kaldırıldı.
- **Backend:** `/smtp` akışı SMTP gönderim + IMAP (verify dahil) destekliyor; **imapInbound poller**
  duruyor; eşleştirme/stage/enrichment pipeline'ı hazır. `gmailDwd.ts` + `sendViaGmail` içindeki DWD dalı
  **dormant** (env yok → Nango'ya düşer; zararsız). `.env.example`'da `GOOGLE_DWD_SA_KEY` dormant duruyor.
- Yani **IMAP-only yolunun ~%90'ı zaten kodda** — eksik olan yalnızca dostça **"Gmail (app-password)" preset butonu**.

## Kalan karar + sonraki adım
- **Önde gelen:** **#7 IMAP-only** — Gmail app-password preset'ini geri ekle; reply okuma poller'la
  zaten çalışır → uçtan uca test.
- **Alternatif:** **hibrit** (OAuth gönder + IMAP oku) yalnızca gönderimi 2026-sonrası için garantiye
  almak şartsa; bedeli OAuth client + doğrulama kurulumunu geri getirmek.

## Kaynaklar
- [Restricted scope verification (Google)](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
- [Winding down less secure apps (Google)](https://workspaceupdates.googleblog.com/2023/09/winding-down-google-sync-and-less-secure-apps-support.html)
- [PlusVibe — SMTP/IMAP ile bağlama](https://help.plusvibe.ai/en/articles/8606065-connect-other-providers-via-smtp-imap)
- [Smartlead — Unified Master Inbox](https://www.smartlead.ai/blog/what-is-unified-master-inbox)
- İlgili: [email-integration-options.md](email-integration-options.md), [google-dwd-setup.md](google-dwd-setup.md)
