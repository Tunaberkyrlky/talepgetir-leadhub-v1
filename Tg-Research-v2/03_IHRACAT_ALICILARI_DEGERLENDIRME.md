# İhracat Alıcıları — Funnel & Ürün Değerlendirmesi

> Sade dille. Amaç: "İhracat Alıcıları'nı ayrı bir funnel/marka yapmak doğru mu, nasıl?" → net karar.
> Kaynak: bu oturumdaki kararlar + `İhracat Alıcıları — Marka Sesi & Kılavuzu` + `00_MIMARI_PLAN.md` + `01_KREDI_FIYATLAMA.md` + `02_ACIK_KONULAR.md`.
> Hedef (sen): **reklamdan maksimum gelir, minimum operasyonel efor.**

---

## 0. Özet (TL;DR)

**Karar:** Ayır — ama **şirket/ürün/backend katmanında değil, sadece edinim katmanında.** İhracat Alıcıları = keskin, tek-vaatli ön kapı (ucuz CAC), **kendi domain'i** (`ihracatalicilari.com`) + "powered by Tibexa Global". Arkada **aynı** motor (TG-Research engine + lisanslı veri + dedup kütük). İki yüz, tek sistem.

**Marka ailesi (bu oturumda netleşti):**
```
Tibexa Global  = şemsiye/şirket (+ mevcut ihracat danışmanlığı & veri satışı)
   ├─ İhracat Alıcıları  = veri kaması · kendi domain'i · "powered by Tibexa Global"
   ├─ Tibexa Core        = ana yazılım (CRM + outreach; eski "TG Core") — pricing ŞİMDİLİK KAPALI
   └─ TG-Research engine = motor (müşteriye görünmez plumbing; her ikisini besler)
```

**Sabitlenen girdiler (bu oturum):**
1. **Lisans:** lisanslı veriyi **yeniden satabiliyorsun ✓** → vaat bugün karşılanabilir. (Kalan ufak teyit: §8-1.)
2. **Funnel = tam concierge.** Tek-tık otomatik örnek **yok**; her lead'e bir kişi bakar (örnek çıkarma + cevap + kapanış). Min-ops bunun etrafında kurulur (§6).
3. **Kapsam = TR **ve** Dünya, ayrı ayrı.** Bir GTİP için "Türkiye'den alanlar" ve "Dünyadan alanlar" iki ayrı liste.
4. **Ücretsiz örnek = 1 HS code'da 5 TR + 5 Dünya firma** (10 firma).
5. **İletişimde üst sınır yok** — LinkedIn'deki tüm personel bulunur. (→ KVKK yüzeyi büyüdü, §8-2.)
6. **Tibexa Core pricing şimdilik devrede değil** → ilk faz GTM = **yalnız İhracat Alıcıları.**

**Merdiven (GÖR → ARAŞTIR → ULAŞ):**
```
Ücretsiz örnek → Gümrük Alıcıları (veri) → Her alıcıyı araştırma → Tibexa Core (outreach)
   (5+5 firma)      "kim alıyor — GÖR"        "her birini ARAŞTIR"     "senin için ULAŞ"
        ▲                  ▲                          ▲                       ▲
        └────────────── TEK MOTOR: TG-Research engine + lisanslı veri ───────┘
```
"Upsell karmaşık mı?" → **Hayır.** Güven merdiveni: küçük/güvenmeyen firma $3000'ı soğuk vermez; küçük veri alır, işe yaradığını görür, derin araştırmaya/outreach'e çıkar. Backend tek olduğu için geçiş sürtünmesiz.

---

## 1. İki yüz, tek motor (mimari çerçeve)

| Katman | Ne | Müşteri görür mü |
|---|---|---|
| **Edinim (marka/funnel)** | İhracat Alıcıları (kendi domain) · (sonra) Tibexa Core | **Evet — ayrı yüzler** |
| **Teklif (SKU)** | Gümrük Alıcıları (veri) · Her alıcıyı araştırma · (sonra) Tibexa Core outreach | Evet |
| **Motor** | TG-Research engine: lisanslı veri lookup + web research (SearXNG/Gosom) + dedup kütük + validasyon + mesaj taslağı | **Hayır — görünmez** |
| **Backend** | Tek tenant + kredi + DB + worker (`00 K1–K8`) | Hayır |

**İlke:** funnel/landing'de **ayır** (odak = dönüşüm); hesap/backend'de **birleştir** (tek sistem = min ops + sürtünmesiz upsell).

**Üç teklifin işi farklı — yamyamlığı bu engeller:**

| | Gümrük Alıcıları | Her alıcıyı araştırma | Tibexa Core |
|---|---|---|---|
| **İş** | GÖR (kim alıyor — liste) | ARAŞTIR (her alıcıyı derinleştir) | ULAŞ (kampanya/outreach) |
| **Kaynak** | lisanslı gümrük/BoL verisi | gümrük tohumları → engine ile enrichment | research çıktısı → import → kampanya |
| **Birim** | kayıt/liste (TR+Dünya, HS bazlı) | araştırılmış firma + tüm iletişim | ulaşılan firma |
| **Marjinal maliyet** | düşük (lisans + operatör zamanı) | orta (engine: LLM/scrape) | yüksek (outreach) |

**Sinerji notu:** Gümrük verisi, soğuk web aramasından **daha iyi tohum** — bunlar **kanıtlanmış ithalatçılar.** "Her alıcıyı araştırma" tier'ı, TG-Research engine'ini bu kanıtlanmış firmalara uygular → daha yüksek isabet, daha iyi marj, daha iyi sonuç. (Öneri: bu tier engine'i kullansın, §9-K3.)

---

## 2. Neden kama (wedge) çalışır

1. **En keskin reklam kancası.** "Almanya'da ürününü alan 84 firma var — görmek ister misin?" → "B2B platformu"ndan 10× ucuz CAC. (`marka-sesi §7`)
2. **Düşük-riskli ilk işlem.** Güvenmeyen/küçük segment $3000'ı soğuk vermez; küçük alım + ücretsiz örnek = güven → yüksek bilet.
3. **Sıfır yeni kabiliyet riski.** Zaten veri satıyorsun (farklı isimle). Bu, mevcut işin ürünleşmesi.
4. **Kendi kendini niteleyen lead.** Veriyi alıp beğenen = "araştır/ulaş" için sıcak prospect.
5. **Cömert örnek, ~sıfır risk.** Lisanslı veride 10 firmalık örnek marjı yemez; güven kurar.

---

## 3. Ürün: İhracat Alıcıları

**Tek cümle:** "GTİP'ini ver; o ürünü **Türkiye'den** ve **dünyadan** kimin aldığını isim, ülke, iletişim ve hacimle göster."

**Birim = HS code.** Her sorgu **iki ayrı liste** döner: (a) Türkiye'den alanlar, (b) Dünyadan alanlar. (a) = mevcut talep + rakip istihbaratı; (b) = kazanabileceğin tüm alıcılar.

**İletişim:** üst sınır yok — firma + LinkedIn'deki **tüm personel/karar vericiler** (→ KVKK, §8-2).

**Ücretsiz örnek:** 1 HS code → **5 TR + 5 Dünya** firma. WhatsApp lead magnet.

**KVKK ayrımı (`00 K9`):** firma-seviyesi ticaret verisi düşük risk; **kişi-seviyesi (tüm personel) yüksek risk** → aydınlatma + meşru menfaat + DPA + suppression + VERBİS zorunlu (§8-2).

---

## 4. Fiyat & merdiven

> Senin tablona göre. Birim = HS code; iki ürün (GÖR / ARAŞTIR). İletişimde üst sınır yok.

| HS code | **Gümrük Alıcıları** (veri: TR+Dünya listesi, tüm iletişim) | **Her alıcıyı araştırma** (veri + derin araştırma/enrichment) |
|---|---|---|
| **1 HS** | **$500** | **$1.000** |
| **5 HS** | **$1.250** | **$2.500** |
| **10 HS** | **$2.000** | **$3.500** |
| **Örnek** | 1 HS → 5 TR + 5 Dünya firma | bedava |

**Merdiven:** Ücretsiz örnek → Gümrük Alıcıları (GÖR) → Her alıcıyı araştırma (ARAŞTIR) → **Tibexa Core** (ULAŞ — outreach; pricing sonra, `01` ankuru ~$3000/3000 firma).

**İlke:** her rung'un farklı **işi** var (gör / araştır / ulaş), sadece daha büyük sayı değil → yamyamlık yok. Hacim (5/10 HS) iskontosu doğru kurulmuş (HS başı düşüyor). "Araştır" sütunu = "veri" + engine emeği; makas (~2×→1.75×) makul.

---

## 5. Gösterim mantığı

> Senin soruların: ayrı domain mi subdomain mi? "powered by Tibexa Global" mantıklı mı? → **Kendi domain + powered-by, evet.**

**Faz 1 (şimdi): yalnız İhracat Alıcıları sitesi.** Tibexa Core pricing kapalı → entegre edilecek "ana fiyatlama" henüz yok. Tek odak: kama.

```
ihracatalicilari.com  (reklamın indiği yer)
┌─────────────────────────────────────────┐
│  "Ürününü dünyada kim alıyor?"           │
│  Türkiye'den VE dünyadan alanları göster │
│  [GTİP gir]                               │
│  ► Ücretsiz örnek alıcı listesi al        │  ← TEK CTA, turuncu
│  ► WhatsApp'tan sor                        │
│  ...                                       │
│  KVKK aydınlatma linki (görünür)           │
│              powered by Tibexa Global ┐    │  ← köşe rozet (güven, odağı bozmaz)
└─────────────────────────────────────────┘
```

**Neden kendi domain (subdomain değil):**
- Trafik **reklamdan** → SEO/domain otoritesi önemsiz; subdomain'in tek avantajı burada işe yaramaz.
- Güvenmeyen küçük ihracatçıya **kendi başına gerçek ürün** gibi görünmeli; `...tibexa.com` "alt-sayfa" hissi verir.
- Pivot/A-B/yeniden konumlama bağımsız; ana marka agresif direct-response'tan korunur.
- **"powered by Tibexa Global" köşede** = endorsed-brand: bağımsız odak + ana markanın (danışmanlık) güveni → "az güvenen" segmentin şüphesini kırar. Header'da değil, **footer/köşede** (tek CTA boğulmasın, `marka-sesi §8`).
- Maliyet önemsiz → baştan doğru: `ihracatalicilari.com` + savunma için `.com.tr`.

**Faz 2 (sonra):** Tibexa Core pricing açılınca, İhracat Alıcıları ana merdivenin "buradan başla" giriş rung'u olarak da gösterilir; **aynı tenant** (`00 K2`) → geçiş tek tık.

---

## 6. Funnel & operasyon (tam concierge + min-ops uzlaşması)

Sen **tek-tık otomasyon olmayacak, her lead'e bir kişi bakacak** dedin. Bu insan-yoğun; "min ops" ile gerilimi dürüstçe yönet:

**Akış:**
```
Reklam → ihracatalicilari.com → WhatsApp lead
       → operatör: iç araçla HS+ülke sorgular → TR & Dünya listesi + iletişim → temizler/kalite
       → 5+5 örneği gönderir + konuşur → kapanış (GÖR / ARAŞTIR)
       → memnun müşteri → (sonra) Tibexa Core outreach upsell
```

**Min-ops gerçeği (dürüst):** otomasyon olmadan ops ≈ lead sayısıyla **lineer.** Bunu kabul et ve domine et:
- **Operatör verimi = asıl kaldıraç.** İç araç tek-tık değil ama **dakikalar** olmalı (saat değil): operatör lisanslı veriyi HS+ülke ile hızlı sorgulasın, TR+Dünya + iletişimi çeksin, insan kalite/temizlik yapsın (`duzenle.py` mantığı, `02 A.13`).
- **WhatsApp şablonları + triyaj** → lead başı insan-dakikası minimum.
- **Reklam harcamasını operatör kapasitesine göre kıs;** talep artınca operatör ekle. Bilet yüksek ($500–3.500) → 1 kişi günde birkaç kapanışla op maliyetini rahat domine eder. Yani "min ops" = sıfır-insan değil, **lead başı insan-dakikasını minimize + yüksek bilet/lead ile maliyeti domine et.**

**Darboğaz uyarısı:** otomasyon yokken **operatör kapasitesi = ölçek tavanı.** Reklamı bu tavana göre aç; aşarsan CAC öder lead'i kaybedersin. (İleride yarı-self-serve "araştır/ulaş" küçük alımları otomatikleştirilebilir; örnek-çıkarma insan kalır.)

---

## 7. Min-ops backend (tek motor neyi sağlıyor)

`00`/`01` kararları bu funnel'ı taşıyor — yeni sistem gerekmez:
- **Tek tenant + kredi defteri** (`01 §5`) → tek bakiye, iki yüz.
- **Dedup kütük** (`00 K6`) → aynı firma iki kez taranmaz/faturalanmaz; "araştır" tier'ı kütükten beslenir.
- **Operation→ücret = config** (`01 §5`) → Gümrük Alıcıları + Araştırma SKU'ları **deploy'suz** eklenir.
- **Worker + kuyruk** (`00 K3`) → liste çıkarma/enrichment döngü dışı.
- **CRM köprüsü tek yön** (`00 K8`) → araştırma → import → mevcut kampanya/e-posta = Tibexa Core'un "ulaş" kısmı zaten var.

**Sonuç:** İhracat Alıcıları mimaride **yeni kutu değil**; motorun üstüne **2 SKU + 1 landing + 1 veri-lookup adaptörü (operatör aracı).**

---

## 8. Riskler & dikkat

1. **🟢 Lisans (çözüldü).** Yeniden satış ✓. Kalan ufak teyit: **ücretsiz örnek dağıtımı** ve per-record/hacim/redistribution sınırı sözleşmede net mi.
2. **🔴 KVKK — en büyük hukuki yüzey (yükseldi).** "Üst sınır yok, **tüm LinkedIn personeli**" = kişi-seviyesi PII toplama **ve satma.** Firma-seviyesi ticaret verisinden çok daha hassas. Zorunlu: aydınlatma metni (landing'de görünür) + hukuki sebep (alenileştirilmiş veri + meşru menfaat, `00 K9`) + **DPA** + **suppression** (`02 A.21`) + VERBİS. Meşru menfaat dengesi testi yap; kişiye özel hassas veri toplama. **Lansman öncesi avukat onayı.**
3. **Concierge tavanı (§6)** — otomasyon yok → operatör kapasitesi ölçeği sınırlar; reklamı buna göre aç.
4. **Yamyamlık → yok:** GÖR/ARAŞTIR/ULAŞ farklı iş, farklı fiyat.
5. **Veri tazeliği/kapsam.** Lisanslı BoL'de gecikme + ülke boşlukları olur (özellikle "Dünya" tarafı ülkeye göre değişir). `marka-sesi §5` itiraz-kırıcıları dürüst beklenti kursun — abartma.

---

## 9. Açık kalibrasyonlar (azaldı)

- **K1 — 🔴 KVKK paketi:** tam-personel verisi için aydınlatma + meşru menfaat dengesi + suppression akışı + VERBİS. **En kritik açık** (§8-2).
- **K2 — Lisans teyidi:** ücretsiz örnek dağıtım + hacim/redistribution sınırı (§8-1).
- **K3 — "Araştır" tier'ı engine kullansın mı:** öneri **evet** — gümrük alıcıları motora pre-qualified tohum (§1 sinerji).
- **K4 — Operatör kapasitesi:** lead başı dakika + günlük kapanış hedefi → reklam-harcaması kapısı + ne zaman 2. operatör.
- **K5 — Domain teyidi:** `.com` (önerilen) + `.com.tr` savunma; "powered by Tibexa Global" footer yerleşimi.
- **K6 — "Dünya" kapsam dürüstlüğü:** hangi ülkeler güçlü/zayıf (lisanslı kaynağın kapsamı) → landing'de over-promise etme.

---

## 10. Önerilen ilk adım (yalnız İhracat Alıcıları; Tibexa Core pricing sonra)

1. **Domain + landing:** `ihracatalicilari.com` (+`.com.tr`); tek vaat, tek CTA, WhatsApp, KVKK aydınlatma, footer "powered by Tibexa Global".
2. **🔴 KVKK paketi** (avukat onaylı): aydınlatma + DPA + suppression + VERBİS — özellikle personel verisi. **Lansman gate'i.**
3. **Operatör + iç veri-sorgu aracı:** HS+ülke → TR & Dünya listesi + tüm iletişim, hızlı; temizleme `duzenle.py` portu (`02 A.13`).
4. **WhatsApp iş hattı** + cevap şablonları + triyaj.
5. **Config'e SKU** (`01 §5`): Gümrük Alıcıları + Araştırma, 1/5/10 HS fiyatları; ücretsiz örnek = 5 TR + 5 Dünya.
6. **Pilot (10–20 reklam lead'i)** → operatör/lead süresi + dönüşüm + gerçek CAC → fiyat & kapasite kalibrasyonu (`01 §6` ruhu).
7. **Sonra:** Tibexa Core pricing + "araştır → ulaş" entegrasyonu + ana merdivene giriş rung'u (§5 Faz 2).

---

> **Tek cümle:** İhracat Alıcıları = **kendi domain'li, powered-by-Tibexa-Global, tek-vaatli reklam kaması**; arkada **aynı TG-Research motoru.** Merdiven GÖR ($500–2.000) → ARAŞTIR ($1.000–3.500) → ULAŞ (Tibexa Core, sonra). İnsan her lead'de (tam concierge) ama lead-başı dakika minimize + yüksek bilet maliyeti domine eder. Tek büyük gerçek risk: **personel verisinde KVKK** — onu lansman gate'i yap.
