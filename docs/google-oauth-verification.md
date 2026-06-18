# Google OAuth Doğrulama Rehberi (mail bağlama / `google-mail`)

LeadHub'ın "mail bağlama" özelliği, kullanıcının kendi Gmail/Workspace hesabından
mail göndermek için Nango üzerinden `gmail.send` (sensitive) scope'u kullanır.
External + production'a geçince Google **doğrulama** ister. Bu rehber, doğrulama
formunu **tek seferde** geçmek için gereken her şeyi sırayla toplar.

> Kodun kullandığı scope'lar (referans):
> - `https://www.googleapis.com/auth/gmail.send` — mail gönderme ([emailSender.ts:212-213](../server/src/lib/emailSender.ts#L212-L213))
> - `https://www.googleapis.com/auth/userinfo.email` — bağlanan adresi öğrenme ([email-connections.ts:255](../server/src/routes/email-connections.ts#L255))
> - `openid` — kimlik
>
> `gmail.send` **sensitive**'dir (restricted DEĞİL) → doğrulama var ama **CASA güvenlik denetimi YOK**.

---

## ⚠️ ÖNCE OKU: Authorized domain / custom callback meselesi

Google doğrulamada, OAuth uygulamana bağlı **tüm domain'lerin sahipliğini** doğrulatmanı
ister — buna **redirect URI'nin domain'i** de dahildir. Nango'nun varsayılan callback'i:

```
https://api.nango.dev/oauth/callback
```

`nango.dev` sana ait olmadığı için onu Search Console'da doğrulayamazsın → bu haliyle
**verification reddedilir / takılır.** Çözüm: **kendi domain'inde custom callback** kullanmak
(Nango bunu resmî olarak öneriyor).

### Custom callback kurulumu (production için zorunlu yol)
**Kod tarafı zaten hazır** ✅ — server'a `/oauth-callback` endpoint'i eklendi
([index.ts](../server/src/index.ts), "Nango OAuth custom callback" bloğu). Google'ı
buraya yönlendirip, tüm query paramlarını koruyarak Nango'ya **308 redirect** yapar:
```
https://core.tibexa.com/oauth-callback  →(308)→  https://api.nango.dev/oauth/callback
```

Senin yapman gerekenler (ayar tarafı):
1. **Google Cloud** → Credentials → OAuth client → **Authorized redirect URIs**'e ekle:
   `https://core.tibexa.com/oauth-callback` *(artık `api.nango.dev` değil)*.
2. **Nango** → **Environment Settings → Callback URL**'i şuna güncelle:
   `https://core.tibexa.com/oauth-callback`.
   **Her ortam ayrı** (staging + production ayrı Nango ortamı) → ikisinde de yap.
   Staging için kendi domain'in neyse onu kullan (ör. `https://<staging-domain>/oauth-callback`).
3. Artık redirect domain'i `tibexa.com` olur → Search Console'da onu doğrulayabilirsin.

> Not: Test aşamasında (henüz doğrulamaya girmeden) `api.nango.dev` callback'i ile çalışmaya
> devam edebilirsin. Custom callback yalnızca **production doğrulaması** için gerekli.
> `NANGO_CALLBACK_URL` env'ini SET ETME — default zaten Nango Cloud callback'i; sadece
> self-hosted Nango kullanırsan değiştir.

---

## Doğrulama öncesi tamamlanması gerekenler (checklist)

Bunların **hepsi** hazır olmadan "Submit for verification"a basma; eksik olursa reddedilir.

- [ ] **Custom callback** kendi domain'inde çalışıyor (yukarıdaki bölüm)
- [ ] **App name** kesinleşti (consent ekranında + demo videoda **birebir aynı** görünecek)
- [ ] **App logo** (128×128, transparan/temiz, marka ile tutarlı)
- [ ] **App homepage URL** (authorized domain altında, herkese açık)
- [ ] **Privacy policy URL** (authorized domain altında + **Limited Use** ifadesi içeriyor)
- [ ] **Authorized domain** consent ekranına eklendi (ör. `tibexa.com`)
- [ ] **Domain sahipliği** Google Search Console'da **Domain property (DNS)** olarak doğrulandı
- [ ] **Scope gerekçeleri** yazıldı (aşağıdaki paste-ready metinler)
- [ ] **Demo video** çekildi ve YouTube'a **Unlisted** yüklendi
- [ ] İletişim e-postaları güncel

---

## 1) OAuth consent screen alanları

Google Cloud Console → **APIs & Services → OAuth consent screen / Branding**:

| Alan | Değer |
|---|---|
| App name | **Tibexa** *(consent ekranı + video + form birebir aynı olmalı; uygulama içinde kullanıcı "LeadHub" görüyorsa bunu LeadHub yap)* |
| User support email | `info@tibexa.com` |
| App logo | 128×128 marka logosu |
| Application home page | `https://tibexa.com` *(landing)* |
| Privacy policy URL | `https://tibexa.com/privacy` *(sayfanın gerçekten yayında + Limited Use cümlesini içermesi şart)* |
| Terms of service URL | (varsa) `https://tibexa.com/terms` |
| Authorized domains | `tibexa.com` *(hem tibexa.com hem core.tibexa.com'u kapsar)* |
| Developer contact | yönetici e-postan |

> Uygulamanın kendisi `https://core.tibexa.com` altında; landing `tibexa.com`.
> Authorized domain olarak **kayıtlı domain** (`tibexa.com`) yeterli — tüm URL'ler (homepage,
> privacy, redirect `core.tibexa.com/oauth-callback`) onun altında olduğu için ek doğrulama gerekmez.

---

## 2) Domain doğrulama (Search Console)

1. [Google Search Console](https://search.google.com/search-console) → **Add property → Domain** (URL prefix DEĞİL).
2. Verdiği **TXT kaydını** domain DNS'ine ekle → **Verify**.
3. Search Console'da kullandığın Google hesabı, Cloud projesindeki hesapla **aynı** olsun.
4. Authorized domain'i, redirect/homepage/privacy URL'lerini **eklemeden önce** doğrula.

---

## 3) Scope gerekçeleri (Google'a İngilizce gider — paste-ready)

Verification Center her scope için "neden gerekli" sorar. Aşağıdakiler kullanıma hazır:

**`gmail.send`**
```
Tibexa is a B2B CRM. Each user explicitly connects their own Google account so the
application can send outbound sales and follow-up emails (drip campaigns and one-off
replies) from the user's own mailbox, on the user's behalf and initiated by the user.
We use the gmail.send scope solely to send these user-composed/approved messages via
the Gmail API (users.messages.send). We do not read, search, modify, label, or delete
any messages, and we do not access the mailbox for any other purpose.
```

**`userinfo.email`**
```
We use userinfo.email only to identify which email address the user connected, so we
can display it in the app and use it as the From/sender address for the messages the
user sends. We do not use it for advertising and do not share it with third parties.
```

**`openid`**
```
Standard OpenID Connect identifier used to associate the connected account with the
user's Tibexa account.
```

---

## 4) Privacy policy — Limited Use ifadesi (ZORUNLU)

Gizlilik politikası sayfana **aynen** şu cümleyi ekle (Google bunu kontrol eder):

```
Tibexa's use and transfer to any other app of information received from Google APIs
will adhere to the Google API Services User Data Policy, including the Limited Use
requirements.
```

Ayrıca politikada şunlar net olmalı: hangi Google verisini (gönderici e-posta adresi),
hangi amaçla (kullanıcının kendi adına mail gönderme) kullandığın; veriyi sattığın/
reklam için kullanmadığın; kullanıcının bağlantıyı nasıl iptal edeceği.

---

## 5) Demo video (YouTube → Unlisted)

Google'ın görmek istedikleri (eksikse reddedilir). Çekim sırası:

1. **Uygulama tanıtımı**: `https://core.tibexa.com` açılır, App Name (Tibexa) net görünür.
2. **Giriş**: kullanıcı uygulamaya giriş yapar.
3. **Bağlama akışı**: Ayarlar → "Gmail bağla" → Google consent ekranı açılır.
   - Consent ekranında **App Name doğru** görünmeli.
   - Tarayıcı **adres çubuğunda OAuth client ID** görünmeli (yakın çekim).
   - `gmail.send` ve `userinfo.email` izinleri ekranda görünür.
4. **Scope kullanımı**: kullanıcı izin verdikten sonra uygulamada bir mail oluşturup
   **gönderir** → mailin kullanıcının kendi Gmail "Gönderilenler"inde göründüğünü göster
   (yani `gmail.send`'in gerçek kullanımı).
5. Video **İngilizce** (konuşma veya altyazı), ekran net okunur.

> İpucu: Consent ekranındaki App Name, demo videodaki ve forma yazdığın isim **birebir aynı**
> olmalı; en sık ret sebebi bu uyuşmazlık.

---

## 6) Production'a alma + submit

1. OAuth consent screen → **Audience → Publish App** → "In production".
2. Sensitive scope olduğu için **Prepare for verification / Submit for verification** akışı açılır.
3. Tüm bilgileri (scope'lar, gerekçeler, video linki, privacy URL) doldur → **Submit**.
4. Onaya kadar:
   - Production'da **7 günlük refresh token iptali kalkar** (en önemli kazanım).
   - Doğrulanmamış halde kullanıcı "unverified app" uyarısı görebilir; yeni izin veren
     kullanıcı sayısı ~100 ile sınırlıdır. Onay gelince ikisi de açılır.

---

## En sık ret sebepleri (kaçın)

- App Name / logo, consent ekranı ↔ video ↔ form arasında **uyuşmuyor**.
- Privacy policy'de **Limited Use** cümlesi yok ya da policy domain'i authorized değil.
- **Redirect URI domain'i doğrulanmamış** (Nango'nun `api.nango.dev`'iyle kalmışsın → custom callback gerekli).
- Search Console'da **Domain property yerine URL-prefix** doğrulanmış.
- Demo video scope'un **gerçek kullanımını** göstermiyor (sadece consent ekranı, mail gönderimi yok).
- Scope gerekçesi muğlak ("to improve user experience" gibi) — somut ve dar olmalı.

---

## Kaynaklar
- [Sensitive scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)
- [OAuth consent screen & scopes](https://developers.google.com/workspace/guides/configure-oauth-consent)
- [Verification requirements](https://support.google.com/cloud/answer/13464321?hl=en)
- [Domain verification (Search Console)](https://support.google.com/cloud/answer/13804266?hl=en)
- [Nango: register your own Google OAuth app](https://nango.dev/docs/api-integrations/google/how-to-register-your-own-google-api-oauth-app)
- [Nango: custom callback URL](https://docs.nango.dev/guides/api-authorization/configuration)
