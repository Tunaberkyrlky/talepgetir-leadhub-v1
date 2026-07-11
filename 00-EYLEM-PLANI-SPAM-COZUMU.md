# Eylem Planı — Outlook Spam Sorunu ve Sağlıklı Gönderim Kurulumu

> Bu dosya, 01–07 numaralı teknik analiz dosyalarının **uygulanabilir özetidir**.
> Sadece buradaki adımları takip etmeniz yeterli; teknik derinlik isterseniz ilgili
> dosyalara bağlantı verilmiştir. Tarih: 2026-07-10.

---

## 1. Teşhis: "on behalf of" sorununun kesin nedeni (KANITLANDI)

Alıcıların gördüğü şuydu:

```
ceren oğul <outlook_434CA8BCE302C8F2@outlook.com>; on behalf of; ceren oğul <cerenogul@degisimmotor.com>
Gmail: "outlook.com üzerinden"
```

**Kök neden:** Bağlanan hesap, cerenogul@degisimmotor.com'un **Microsoft 365 iş posta
kutusu değil**; bu e-posta adresi kullanılarak açılmış **kişisel bir Microsoft hesabı
(MSA)**. Microsoft, iş e-postasıyla kişisel hesap açıldığında arka planda
`outlook_XXXX@outlook.com` biçiminde gizli bir gönderim adresi üretir. Mail bu kişisel
altyapıdan (outlook.com) çıkınca:

- Gerçek gönderici (`Sender`) = `outlook_…@outlook.com`, görünen (`From`) = `cerenogul@degisimmotor.com` → Outlook alıcıları "on behalf of" görür.
- SPF/DKIM imzaları outlook.com'a ait, degisimmotor.com'a değil → Gmail "üzerinden/via" gösterir ve spam'e atar.

**Kanıtlar:**
1. `outlook_<hex>@outlook.com` deseni yalnızca kişisel Microsoft hesaplarının otomatik üretilmiş gönderim adresidir.
2. degisimmotor.com'un MX kaydı `degisimmotor-com.mail.protection.outlook.com` → gerçek posta kutusu Microsoft 365 **kurumsal** tarafında duruyor; yani doğru hesap mevcut, sadece OAuth sırasında yanlış hesap türü seçilmiş.
3. Kod tarafı (`server/src/lib/emailSender.ts`) Graph `/me/sendMail` çağırıyor ve `from` override etmiyor — **gönderim kodu doğru**. Sorun kodda değil, bağlanan hesabın türünde.
4. OAuth login ekranında Microsoft "İş veya okul hesabı / Kişisel hesap" seçtirir; kişisel seçildiğinde bile Graph `/me` iş adresini döndürdüğü için sistem farkı göremiyordu. (Bu artık kodda tespit edilip engelleniyor — aşağıda.)

Detay isterseniz: `01-current-state-analysis.md` §"on behalf of root-cause".

---

## 2. Çözüm adımları

### Adım 1 — Doğru hesapla yeniden bağlan (BUGÜN, ~5 dk)

1. Ayarlar → E-posta bağlantıları → mevcut Outlook bağlantısını **sil**.
2. **Yeniden bağlan** → Microsoft giriş ekranı geldiğinde e-postayı yazın; hesap türü sorulduğunda **"İş veya okul hesabı"** (Work or school account) seçin.
3. Parola, Microsoft 365 posta kutusunun parolasıdır (Outlook'ta/Webmail'de mail okurken kullanılan).
4. Bağlantı tamamlanınca Adım 4'teki testi yapın.

> Kod güncellemesi: OAuth callback'ine hesap türü tespiti eklendi. Kurumsal bir adres
> kişisel Microsoft hesabıyla bağlanmaya çalışılırsa bağlantı artık **reddediliyor** ve
> kullanıcıya "İş veya okul hesabı seçin" mesajı gösteriliyor. Yani bu hata bir daha
> sessizce oluşamaz. Gerçek @outlook.com / @hotmail.com kutuları etkilenmez, normal bağlanır.

### Adım 2 — degisimmotor.com DNS kayıtları (BU HAFTA, ~15 dk işlem)

Mevcut durum (2026-07-10'da kontrol edildi):

| Kayıt | Durum | Yapılacak |
|---|---|---|
| MX | ✅ Microsoft 365 | Dokunmayın |
| SPF | ✅ `spf.protection.outlook.com` dahil, `-all` ile bitiyor (7 DNS lookup, 10 limitinin içinde) | Dokunmayın. Not: alastyr/5g-soft include'ları eski hosting kalıntısıysa ileride temizlenebilir, acil değil |
| **DKIM (M365)** | ❌ **ETKİN DEĞİL** — selector1/selector2 CNAME kayıtları yok | **Etkinleştirin (aşağıda)** |
| DMARC | ✅ `v=DMARC1; p=none` | Şimdilik yeterli; 3-4 hafta sorunsuz gönderimden sonra sıkılaştırın (aşağıda) |

**DKIM etkinleştirme (asıl eksik olan bu):**
1. https://security.microsoft.com → **Email & collaboration → Policies & rules → Threat policies → Email authentication settings → DKIM** sekmesi.
2. `degisimmotor.com` seçin → **Create DKIM keys**. Microsoft size 2 CNAME verir:
   - `selector1._domainkey.degisimmotor.com` → `selector1-degisimmotor-com._domainkey.<tenant>.onmicrosoft.com`
   - `selector2._domainkey...` → (aynı desen, selector2)
3. Bu 2 CNAME'i domainin DNS yönetim panelinden ekleyin.
4. DNS yayıldıktan sonra (genelde 15 dk–birkaç saat) aynı ekranda **"Sign messages for this domain with DKIM signatures" → Enable**.

**DMARC sıkılaştırma (3-4 hafta sonra, isteğe bağlı ama önerilir):**
`_dmarc.degisimmotor.com` TXT kaydını şöyle güncelleyin:
```
v=DMARC1; p=quarantine; rua=mailto:dmarc-raporlari@degisimmotor.com; pct=100
```

### Adım 3 — Doğrulama testi (bağlantı yenilendikten hemen sonra, ~5 dk)

1. Uygulamadan bir Gmail adresine test maili gönderin.
2. Gmail'de maili açın → sağ üst üç nokta → **"Orijinali göster" (Show original)**.
3. Üstteki özet tabloda şunları kontrol edin:

| Kontrol | Beklenen |
|---|---|
| SPF | **PASS**, domain `degisimmotor.com` |
| DKIM | **PASS**, `d=degisimmotor.com` (DKIM'i henüz etkinleştirmediyseniz `d=…onmicrosoft.com` görünür — SPF pass olduğu sürece DMARC yine geçer, ama DKIM'i etkinleştirin) |
| DMARC | **PASS** |
| From satırı | Sadece `ceren oğul <cerenogul@degisimmotor.com>` — **"üzerinden/via" YOK, "on behalf of" YOK** |

4. Bir de başka bir Outlook/M365 adresine gönderip From alanında tek kimlik göründüğünü teyit edin.

Bu 4 kontrol geçiyorsa Outlook spam sorunu çözülmüştür. Geçmiyorsa ham başlıkları
kaydedin ve `07-test-and-diagnostic-playbook.md`'deki tanı akışını izleyin.

---

## 3. Gmail tarafı (mevcut ve gelecek müşteriler)

- Nango üzerinden Gmail gönderimi **doğru kurulmuş**: mail, bağlanan hesabın kendisinden `gmail.googleapis.com` ile çıkıyor; Google otomatik DKIM imzalar. Kişisel @gmail.com adresleri için ek iş yok.
- **Google Workspace + özel domain** müşterisi bağlandığında domain sahibinin yapması gerekenler (tek seferlik):
  1. SPF: `v=spf1 include:_spf.google.com ~all`
  2. DKIM: Google Admin Console → Apps → Google Workspace → Gmail → **Authenticate email** → kaydı oluştur, DNS'e TXT ekle, "Start authentication".
  3. DMARC: en az `v=DMARC1; p=none; rua=mailto:...`
- Google/Yahoo toplu gönderici kuralları (2024+): From domaininde **SPF veya DKIM hizalı + DMARC kaydı mevcut** olmak zorunlu, tek tıkla abonelik iptali ve düşük şikâyet oranı (<%0,3) bekleniyor. Düşük hacimde bile bu üçlü standart kabul edilmeli. Detay: `02-deliverability-research-2026.md`.

---

## 4. Yeni müşteri posta kutusu bağlarken kontrol listesi

Her yeni müşteri domaini için sırayla (5 dakikalık kontrol):

```bash
dig +short MX  musteri-domain.com          # posta kutusu kimde?
dig +short TXT musteri-domain.com          # SPF var mı, doğru sağlayıcıyı içeriyor mu, -all/~all ile bitiyor mu?
dig +short TXT _dmarc.musteri-domain.com   # DMARC var mı?
dig +short CNAME selector1._domainkey.musteri-domain.com   # M365 DKIM (M365 ise)
dig +short TXT google._domainkey.musteri-domain.com        # Google DKIM (Workspace ise)
```

| MX şuna işaret ediyorsa | Bağlantı yolu | Not |
|---|---|---|
| `*.mail.protection.outlook.com` | **Outlook (Nango)** — "İş veya okul hesabı" ile | DKIM'i M365'te etkinleştirt |
| `*.google.com` / `smtp.google.com` | **Gmail (Nango)** | Workspace Admin'den DKIM etkinleştirt |
| Başka bir sağlayıcı (yerel hosting vb.) | **SMTP/IMAP** | Kullanıcı adı = gönderen adres olmalı; From ≠ auth kullanıcı ise "on behalf of"un SMTP versiyonu yaşanır |
| MX yok / park halinde | Bağlamayın | Önce gerçek posta kutusu kurulmalı |

**Hacim politikası** (ürün güvenlik limiti, sağlayıcı limiti değil): sağlıklı ve oturmuş
bir iş posta kutusu için günde **20 otomatik mail ile başlayın**, sorunsuz her 3 iş
gününde +5 artırarak **50/gün normal tavanına** çıkın. Yeni açılmış/az kullanılmış
kutular için daha düşük profiller: `05-mailbox-onboarding-and-safety-policy.md`.

---

## 5. Netleşen mimari kararlar (özet)

- **Kendi MTA'nız / özel IP havuzu GEREKMİYOR.** Müşteriler kendi kutularından gönderdiği sürece "temiz IP çıkışı" Google/Microsoft'un kendi altyapısıdır — bundan daha iyi itibarlı IP yoktur. Sizin işiniz kimlik hizasını (SPF/DKIM/DMARC alignment) ve hacim disiplinini korumak.
- **Warmup ağı KURMAYIN.** Yapay warmup ağları 2024'ten beri Google/Microsoft tarafından tespit edilip cezalandırılıyor; kontrollü gerçek gönderim rampası (yukarıdaki 20→50) yeterli ve güvenli.
- **Gmail için doğrudan API + CASA Tier 2 yerine Nango**: mevcut tercih doğru, değiştirmeyin.
- **M365 için Graph `/me/sendMail`** (from override olmadan): doğru, değiştirmeyin. Tek gereken bugünkü hesap-türü tespiti idi.
- Karşılaştırma ve gerekçeler: `03-ideal-email-architecture.md`, `06-provider-comparison.md`.

---

## 6a. Sequencer sonuçlarını etkileyecek adımlar (kod taraması 2026-07-10)

Motorun mevcut durumu tarandı. **Zaten var ve iyi:** spintax, insansı jitter, gönderim
penceresi + saat dilimi, kampanya ve kutu-başı günlük limitler, açılma/tıklama takibi
(aç/kapa), unsubscribe linki + unsubscribed durumu, yanıt gelince diziyi durdurma.

Eksikler, etki/emek sırasına göre:

| # | Adım | Neden sonucu etkiler | Emek |
|---|---|---|---|
| 1 | **List-Unsubscribe + List-Unsubscribe-Post header'ları (RFC 8058 tek tık)** | Gmail/Yahoo 2024+ zorunluluğu; alıcı "Spam" yerine "Abonelikten çık"a basar, şikâyet oranı düşer. Footer linki var ama header YOK. Not: Graph /sendMail özel header'larda yalnızca `X-` kabul eder; Outlook için MIME formatında gönderime geçmek gerekir | Düşük (Gmail/SMTP), Orta (Outlook) |
| 2 | **Follow-up'ları aynı thread'de gönderme (In-Reply-To/References, Graph createReply)** | Şu an her adım yeni mail açıyor; konuşma geçmişi olan mail hem daha az spam'e düşer hem yanıt oranını belirgin artırır | Orta |
| 3 | **Plain-text alternatifi (multipart/alternative)** | Yalnızca HTML gönderiliyor; text/plain parçası eklemek bilinen bir spam skorunu düşürür | Düşük |
| 4 | **Gönderim öncesi liste doğrulama** | Syntax + MX kontrolü (domainHealth resolver'ı hazır) + disposable/rol adresi (info@, admin@) eleme; hard bounce oranını Gmail'in %2 eşiğinin altında tutar | Orta |
| 5 | **Hard bounce → kalıcı suppression + otomatik duraklatma** | Bounce alan adrese bir daha asla gönderilmemeli (tenant bazlı suppression tablosu); kutu bounce oranı eşiği aşarsa kampanya otomatik duraklamalı | Orta |
| 6 | **Otomatik ramp-up** | Kutu-başı limit statik; bağlantı yaşına göre 20→50/gün otomatik artış politikayı kendiliğinden uygular | Düşük |
| 7 | **Paylaşımlı izleme domaini riski** | Açılma pikseli/tıklama linki TÜM müşteriler için aynı API domain'inden geçiyor; bir müşterinin kötü listesi domain'i kara listeye sokarsa herkes etkilenir. Çözüm: müşteri başına custom tracking domain (CNAME) veya düşük hacimde open-tracking'i varsayılan kapalı tutmak | Orta-Yüksek |
| 8 | **Gönderim öncesi içerik denetimi (spam-lint)** | Çok link, URL kısaltıcı, BÜYÜK HARF/ünlem, spam kelimeler, görsel/metin oranı uyarıları | Düşük |
| 9 | **Kutu sağlığı paneli** | Kutu başına bounce/yanıt/unsubscribe oranları + Google Postmaster Tools önerisi; sorunu şikâyete dönüşmeden gösterir | Orta |

Önerilen sıra: önce 1+3 (hızlı kazanım), sonra 2 (en yüksek tekil etki), ardından 4+5 birlikte (liste hijyeni zinciri), 6, 8, 9; 7 müşteri sayısı arttıkça.

## 6. Sırada ne var (öncelik sırasıyla)

1. ☐ Ceren'in kutusunu "İş veya okul hesabı" ile yeniden bağla (Adım 1)
2. ☐ degisimmotor.com'da M365 DKIM'i etkinleştir (Adım 2)
3. ☐ Gmail "Orijinali göster" testi ile 4 kontrolü doğrula (Adım 3)
4. ☐ 3-4 hafta sonra DMARC `p=quarantine`
5. ☐ Yeni müşteri onboarding'inde §4 kontrol listesini standart yap
