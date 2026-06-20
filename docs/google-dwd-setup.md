# Google Workspace DWD — kurulum rehberi (Gmail gönderimi)

> **⚠️ TERK EDİLDİ — uygulanmadı.** Google, service account **key oluşturmayı** her yerde
> (kurumsal org + org'suz kişisel hesap) varsayılan blokluyor (Secure by Default); DWD bu
> indirilen key'e muhtaç olduğu için bu yol kapandı. Ürün **IMAP-only (app-password)**
> kullanıyor. Bu belge yalnızca **arşiv** (ileride keyless WIF düşünülürse). Detay:
> [email-integration-retrospective.md](email-integration-retrospective.md).

TG Core, Gmail gönderimini **Domain-Wide Delegation (DWD)** ile yapar: tek bir GCP
**service account**, her kullanıcının adına (`gmail.send`) mail gönderir. Avantaj:
kullanıcı tek tek OAuth onayı vermez, **consent screen / marka doğrulaması / CASA YOK**.

İki taraf var:
- **A) Siz (bir kez):** GCP'de service account + key + env.
- **B) Her müşteri admin'i (bir kez):** kendi Workspace'inde Client ID'yi yetkiler.

> Not: DWD service account kullandığı için **OAuth consent screen kurmanıza gerek yok** —
> kullanıcı onay akışı hiç çalışmaz.

---

## A) Sizin tarafınız (bir kez, GCP)

### A1. Proje + Gmail API
1. [console.cloud.google.com](https://console.cloud.google.com) → üstten bir proje seç ya da **New Project**.
2. **APIs & Services → Library** → "Gmail API" ara → **Enable**.

### A2. Service account oluştur
3. **IAM & Admin → Service Accounts → + Create service account**.
4. İsim: ör. `tg-core-gmail-dwd` → **Create and continue**.
5. **Rol VERME** (DWD projede IAM rolü istemez; impersonation yetkisi Workspace tarafında verilir) → **Done**.

### A3. JSON key indir
6. Oluşan service account'a tıkla → **Keys** sekmesi → **Add key → Create new key → JSON → Create**.
7. İnen `.json` dosyası `GOOGLE_DWD_SA_KEY`'e gidecek. **Bu dosya gizlidir; git'e koyma, sadece env'e.**

### A4. Client ID'yi al
8. Service account **Details** sekmesinde **Unique ID** (≈21 haneli sayı) var — **bu, DWD için Client ID'dir.** Kopyala (müşteri admin'ine vereceksin).

### A5. Env'e koy (Railway)
9. Railway → ilgili ortam (staging/production) → Variables → `GOOGLE_DWD_SA_KEY` = **JSON dosyasının tüm içeriği** (tek değer olarak yapıştır; çok satır olabilir, kod `\n`'i de tolere eder).
10. Set edilince Gmail gönderimi otomatik DWD'ye geçer. **Set edilmezse eski Nango yoluna düşer** (bozulmaz).

---

## B) Müşteri admin tarafı (her Workspace, bir kez)

Müşterinin **süper yöneticisi** şunu yapar (siz Client ID + scope'u verirsiniz):

1. [admin.google.com](https://admin.google.com) → **Security → Access and data control → API controls**.
2. **Manage Domain Wide Delegation → Add new**.
3. **Client ID:** A4'teki sayısal Unique ID.
4. **OAuth scopes (virgülle):** `https://www.googleapis.com/auth/gmail.send`
5. **Authorize**.

> Müşteriye vereceğiniz hazır metin:
> *"TG Core ile mail gönderebilmek için: Admin console → Security → API controls →
> Manage Domain Wide Delegation → Add new. Client ID: `<SAYISAL_ID>`, Scope:
> `https://www.googleapis.com/auth/gmail.send` → Authorize."*

---

## C) Uygulamada bağlama
1. TG Core → Ayarlar → E-posta Bağlantısı → **Gmail**.
2. Göndereceğiniz **Workspace adresini** yazın → **Doğrula & Bağla**.
3. Sunucu, o adres için DWD yetkisini test eder; yetki yoksa net hata verir (admin henüz yetkilememiş).

---

## Sorun giderme
- **`unauthorized_client` / yetki doğrulanamadı:** Admin Client ID'yi yetkilememiş, **yanlış Client ID**, ya da scope **birebir** aynı değil. Scope tam olarak `https://www.googleapis.com/auth/gmail.send` olmalı.
- **Yeni yetki hemen çalışmıyor:** Admin yetkilendirmesi genelde dakikalar içinde, bazen ~24 saate kadar yayılır.
- **`Gmail API has not been used/enabled`:** A1'de Gmail API enable edilmemiş.
- **Impersonate edilen adres geçersiz:** Adres o Workspace domain'inde **gerçek bir kullanıcı** olmalı (alias/dağıtım grubu değil).
- **Key sızdı:** GCP → service account → Keys → eski key'i sil, yenisini üret, env'i güncelle.

## Güvenlik
- `GOOGLE_DWD_SA_KEY` çok güçlüdür: yetki verilmiş her domain'de, yetkili scope'larla mail gönderebilir. Yalnızca Railway env'inde tut, **asla commit etme**, ortam başına ayrı key kullan.
- İleride yanıt **okuma** eklenirse (`gmail.readonly`) admin'in o scope'u da ayrıca yetkilemesi gerekir (ve restricted scope → olası CASA — bkz. [email-integration-options.md](email-integration-options.md)).
