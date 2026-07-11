# TG-Research — Ana Akış (yeniden kurgu, 2026-07-09)

> Bu dosya ürünün **kanonik müşteri akışıdır**. Mimari karşılıklar `Tg-Research-v2/00_MIMARI_PLAN.md`'de, inşa durumu `Tg-Research-v2/04_ILERLEME.md`'dedir. Akış ile mimari çelişirse **bu dosya kazanır**; mimari plan buna göre güncellenir.
>
> Önceki sürüm (23 maddelik liste) tamamen korunarak yeniden kurgulandı; hiçbir adım atılmadı, sonradan inşa edilen katmanlar (kalibrasyon döngüsü, sub-ICP coğrafya uyarlama, kanal keşfi/hasadı, offer/açı haritası, kampanya geri-beslemesi, kişi enrichment, CRM devri ve pinleme) akıştaki doğru yerlerine oturtuldu. En sonda v1 → yeni adım eşlemesi var.

---

## 0. Değişmez ilkeler

1. **Tek ekran, tek iş (Typeform ilkesi).** Müşteri her an yalnız BİR şey görür: tek soru, tek onay, tek liste, tek firma. Asla bir dashboard'a fırlatılmaz; akış onu adım adım taşır. İlerleme çubuğu her ekranda görünür ("Adım 4/6" gibi, faz bazında).
2. **AI taslak üretir, insan onaylar.** Her AI çıktısı taslaktır; müşteri onaylamadan sonraki adıma geçilmez (K7). Müşteri uzman değildir: AI her zaman örnek + gerekçe + önerilen varsayılanla gelir, müşteri düzenleyebilir.
3. **Uzun işler arka planda, bekleme ekranı canlı anlatır.** Worker'da koşan her iş için müşteri "…araştırıyoruz" ekranı görür: insan dilinde canlı ilerleme satırları ("web siteniz okunuyor", "Almanya'daki sektör dernekleri taranıyor", "34 firma bulundu, inceleniyor…"). Boş spinner yasak.
4. **Kredi görünür, dolar asla.** Müşteri yalnız kredi görür (COGS/dolar admin'e özel). Kredi yalnız **uygun bulunan (MATCH) firma** ve **kişi bulunan firma** için düşer; elenen firmalar, tekrar taramalar ve veri yüklemeleri ücretsizdir. Kredi düşen ilk adımdan itibaren ekranda kredi rozeti durur.
5. **Geri dönmek serbest; onay zinciri korunur.** Müşteri önceki adıma dönebilir. Onaylı bir şeyi değiştirmek (ürün listesi, ICP sinyali, ülke seti…) ona bağlı sonraki onayları otomatik "yeniden onay gerekli" durumuna düşürür (ruleset bump mantığı). Sessizce bayat veriyle devam edilmez.
6. **Her şey kaldığı yerden sürer.** Akış bir durum makinesidir (proje başına `flow_state`); tarayıcı kapansa da müşteri girdiğinde tam kaldığı ekranda devam eder. Her girdi anında otomatik kaydedilir.
7. **Bastırma > tekrar.** Müşterinin "istemiyorum" dediği ya da kampanyada opt-out olan firma bir daha hiçbir listede karşısına çıkmaz.
8. **Akış yaşar.** İleride adım eklense / revize edilse de (yeni kalibrasyonlar, yeni veri kaynakları) aynı teker-teker ilkesiyle akışa yerleşir; bu dosya güncellenir.

---

## Akışın tek bakışta hali

```
FAZ 1 Tanışma        →  FAZ 2 Hedef tanımı   →  FAZ 3 Kalibrasyon  →  FAZ 4 Mesaj açıları
(kurulum + AI profil)   (sub-ICP × ülke)        (~10 firma döngüsü)   (offer/angle kartları)
        ↓
FAZ 7 CRM & öğrenme  ←  FAZ 6 Kişiler        ←  FAZ 5 Derin araştırma
(export + geri-besleme) (Hunter enrichment)     (Y1+Y2+Y3, doygunluk)
        ↺ yaşayan döngü: 24 → 10 / 13 / 17
```

---

## FAZ 1 — Tanışma & kurulum *(mimari: FAZ A / A1)*

1. **Kurulum ekranı.** Tek form, dört alan: **kullanıcı adı, firma adı, website, sosyal medya hesap linkleri** (LinkedIn, Instagram, diğer). Başka hiçbir şey sorulmaz. (Human)
2. **"Firmanızı araştırıyoruz."** AI website'i ve sosyal hesapları tarar; ekranda canlı anlatım: "web siteniz okunuyor… ürünleriniz çıkarılıyor… sektörünüz belirleniyor…". (AI/System — arka plan işi)
3. **Firma özeti onayı.** "Sizi doğru anladık mı?" — tek kart: firmanın güzel bir özeti (ne yapar, kime satar, nerede güçlü). Müşteri metni düzenleyebilir, onaylar. (AI → Human)
4. **Ürün/hizmet listesi.** AI'ın çıkardığı ürün ve hizmetler liste halinde sunulur; müşteri ekler, çıkarır, düzeltir → **firma onaylı ürün/hizmet listesi** tamamlanır. (AI → Human)
5. **Farklılaştırıcılar.** "Sizi ne öne çıkarır?" — MOQ, termin süresi, sertifikalar, kapasite, referans müşteriler, konuşulan diller. AI website'ten bulabildiklerini ön-doldurur; müşteri tamamlar. Opsiyonel ama teşvikli: FAZ 4'teki mesaj açılarının hammaddesidir. (AI → Human)
6. **İpuçları (opsiyonel, atlanabilir).** Üç kısa soru tek ekranda: en iyi mevcut müşterileriniz kimler (lookalike tohumu) · aklınızda hedef pazarlar var mı · kimlere/nelere hiç gitmeyelim (negatif liste). (Human)

## FAZ 2 — Hedef tanımı: sub-ICP × ülke *(mimari: FAZ B / B1–B7)*

7. **HS/GTIP kod adayları** *(yalnız fiziksel ürün satan firmada; hizmet firmasında bu ekran hiç görünmez)*. AI onaylı ürünlerden kod adaylarını çıkarır ve **TradeMap API** ile eşleştirip doğrular (serbest metin tahmini değil, TradeMap'in ürün sınıflandırma aramasından gelen gerçek kod); müşteri eler/onaylar. (AI → Human)
8. **"Pazarları analiz ediyoruz."** Onaylı kodlardan **TradeMap API** (scrape değil, resmi API) üzerinden iki veri seti çekilir: **(a)** dünya geneli ithalat verisi — en çok ithalat yapan ülkeler, hacimler, büyüme eğilimleri; **(b) satıcı ülkesinden yapılan ihracat** — firmanın kendi ülkesinden (adım 1-6'da tespit/teyit edilen firma ülkesi) her aday ülkeye, onaylı HS kodlarıyla, geçmiş yıllardaki **ihracat hacmi + büyüme trendi** (ör. "Türkiye'den Almanya'ya bu HS koduyla geçen yıl $X ihracat yapıldı, %Y büyüme"). (b) yalnız genel pazar büyüklüğü değil, **gerçek ticaret emsali** verir — sonraki adımın ülke önerilerini (a)'dan daha güçlü şekilde besler. Bekleme ekranı; çıktı adım 9'un ülke önerilerini ve adım 10'un onay kartlarını besler. **HS kodu buradan sonra akıştan çıkar** — sonraki her adım ICP + coğrafya + sinyal + negatif kriterle yürür (ticaret verisi kanıt olarak adım 10'da görünmeye devam eder). (AI/System)
   - *Bağımlılık:* bu adımın (b) kısmı firmanın kendi ülkesini bilmeyi gerektirir — adım 2 (profile:crawl, FAZ 1) `profile.company_country` alanını (website adresi/ccTLD/telefon kodundan tahmin) doldurmalı; müşteri adım 3 özet onayında bunu teyit eder.
9. **Sub-ICP kartları — teker teker.** Her ekranda BİR hedef müşteri profili: kim (segment), neden sizin alıcınız, öne çıkan sinyaller (tam tercih/negatif/nötr sinyal listesi "detayları gör" çekmecesinde — ekran sade kalır) ve altında **önerilen hedef ülkeler** (gerekçeli chip'ler; pazar analizinden beslenir). Müşteri: **ülke ekler (dropdown) / çıkarır**, profili **/10 puanlar**, not düşer, onaylar veya reddeder. Tüm kartlar bitince tek özet ekranı: onaylı sub-ICP × ülke matrisi. (AI → Human)
10. **"Ülkelere uyarlıyoruz."** Onaylı her sub-ICP × ülke hücresi için yerelleştirme: yerel dildeki sektör terimleri, yerelleştirilmiş sinyaller ve eleme kuralları, o ülkedeki kanallar (dernek/fuar/dizin/oda), sertifikalar, alıcı unvanları ve **tahmini firma sayısı (E)**. Kart üstünde **adım 8'in TradeMap verisi**: satıcı ülkesinden bu ülkeye onaylı HS kodlarıyla yapılan ihracat hacmi + büyüme trendi (varsa) — müşteri onay kararını "AI böyle dedi"den çok **gerçek ticaret emsaline** dayandırır. Bekleme ekranı bir kez koşar; sonra sub-ICP başına tek ekranda ülke kartları — müşteri her kartı gözden geçirip onaylar. (AI → Human)
11. **Gümrük verisi (opsiyonel).** "Elinizde gümrük/ithalat verisi ya da hazır firma listesi var mı?" → CSV yükleme → önizleme → aday firmalar kütüğe girer (ücretsiz; derin araştırmada değerlendirilir). Yoksa tek tıkla geçilir. (Human → System)

## FAZ 3 — Kalibrasyon: ölçeklemeden önce mantığı doğrula *(mimari: FAZ C / C1–C3, WP1)*

12. **"İlk hedef firmalarınızı arıyoruz."** En yüksek puanlı sub-ICP × ülke hücresinde küçük ama **gerçek** bir arama (~10 firma). Kredi kullanımı burada başlar — yalnız uygun bulunan firmalar için düşer; ekran bunu önceden net söyler ve kredi rozeti belirir. (AI/System)
13. **Örnek firma değerlendirme — teker teker.** Her ekranda BİR firma: ad, website, tek cümle özet, "neden uygun" kanıt cümlesi (siteden alıntı), skor. Müşteri **👍 / 👎** + isterse kısa not ("bunlar çok küçük", "bu üretici, istemem"…). Typeform'un en saf hali. (Human)
14. **Revizyon önerisi (diff).** AI geri bildirimden ne öğrendiğini söyler ve araştırma mantığında somut değişiklik önerir: "şu sinyal eklendi, şu eleme kuralı geldi" — mevcut ↔ öneri yan yana. Müşteri düzenleyip **uygular** → sub-ICP yeniden onaya düşer, müşteri yeniden onaylar. (AI → Human)
15. **Tekrar örneklem → "mantığı onayla".** Revize mantıkla yeni ~10 firma → yine teker teker 👍/👎. Beğeni oranı müşteriyi tatmin edince **"araştırma mantığını onaylıyorum"** der (hücre kalibre edildi). Gerekirse 13→15 döngüsü tekrar eder — her turda mantık ölçülür şekilde iyileşir. (AI → Human)

## FAZ 4 — Mesaj açıları (offer/angle) *(WP4 — sonradan eklendi)*

16. **Offer/açı kartları.** Onaylı her sub-ICP için 3-5 outreach açısı üretilir: ağrı hipotezi, değer önerisi, kanıt noktaları, muhtemel itirazlar — **farklılaştırıcılarınız (adım 5) + kalibrasyonda gerçekten bulunan firma kanıtlarından**. Müşteri kart kart düzenler, /10 puanlar, onaylar/reddeder. Mesaj METNİ burada yazılmaz (o TG-Core kampanyasında); onaylı açılar bundan sonra bulunan her firmaya otomatik eşlenir. (AI → Human)

## FAZ 5 — Derin araştırma *(mimari: FAZ D / D1–D2, WP3)*

17. **Ölçek & kredi kararı.** "Kaç firma bulalım?" — hücre başına tahmini firma sayısı (E, adım 10'dan), kredi bakiyesi ve seçilen hedefin en fazla kaç krediye mal olacağı gösterilir. Müşteri hedefi seçer (hücre bazında veya toplam). (Human)
18. **"Derin araştırma çalışıyor."** Üç yol paralel, hepsi tek dedup kütüğüne akar: **(Y1)** o ülkenin dernek/fuar/dizin/oda/sicil/küme listeleri keşfedilir ve hasat edilir, **(Y2)** yüklenen gümrük adayları değerlendirilir, **(Y3)** açık web 11 açıdan, yerel dilde taranır. Bir firma bir kez incelenir (elenen bile); "istemiyorum" denilenler hiç gelmez. Doygunluk kuralları (A: liste-hasadı + B: açık-web) hücre **gerçekten** "bitti" diyene kadar sürer. Ekranda canlı sayaçlar: bulunan firma, taranan kanal, hücre kapsama rozetleri (devam / boşluk / doydu). (AI/System)
19. **Sonuçlar.** Uygun firmalar tabloda: skor, ülke/şehir, tek cümle özet, kanıt, **kişiselleştirme kancaları (hook)**, **önerilen mesaj açısı**, sitede bulunan email/telefon. Müşteri inceler; istemediğini "istemiyorum" ile düşürür (bastırılır + öğrenmeye girer). Kapsama paneli hücre başına N/E gösterir; müşteri dilerse "devam et / derinleş" der (kredisi yettiğince). (AI → Human)

## FAZ 6 — Kişiler (enrichment) *(mimari: FAZ E / E1)*

20. **Kişi araştırması kurulumu.** Müşteri kişi bulunmasını istediği firmaları seçer; unvan önceliğini sıralar (satın alma, kurucu/GM, satış…), kendi anahtar kelimelerini ekler, firma başına kişi sayısını seçer (1-10). Ekran maliyeti önceden net söyler: "En fazla X kredi — kişi bulunan firma başına 1; daha önce araştırılmış firmadan tekrar kredi düşmez." (Human)
21. **Kişiler gelir.** Ad, unvan, LinkedIn, email (doğrulanmış/tahmini), iletişim önceliğiyle firma kartına eklenir. (AI/System)

## FAZ 7 — CRM'e devir & sürekli öğrenme *(mimari: FAZ F / F2 + WP5)*

22. **CRM'e aktar.** Seçilen firmalar + kişiler; "hangi ICP, hangi açı, hangi kancalar" bilgisiyle TG-Core CRM'e geçer (tek yön; aktarım anındaki ICP/coğrafya kaydedilir — sonraki ölçüm doğru hücreye yazılsın diye). Outreach üç kanaldan TG-Core'da yürür: cold email, LinkedIn, cold call. (Human onayı → System)
23. **Geri-besleme (görünmez, sürekli).** Kampanya sonuçları (gönderim, yanıt, olumlu yanıt, opt-out) her gün otomatik toplanır → sub-ICP × ülke × açı bazında istatistik → ICP ve açı kartlarında **yanıt-oranı rozetleri**. Opt-out'lar otomatik bastırılır. Bu ölçümler bir sonraki revizyon önerisinin (adım 14) kanıtıdır: sistem artık "bence" değil **"ölçtüm"** der. (System/AI)
24. **Yaşayan döngü.** Müşteri istediği an geri döner: yeni ülke ekler (→ adım 10), mantığı yeniden kalibre eder (→ adım 13), araştırmayı derinleştirir (→ adım 17), yeni kişi/firma aktarır (→ adım 20). Hangi kapıdan girerse girsin akış onu yine **teker teker** taşır. (Human)

---

## Adım → motor eşlemesi (inşa durumu, 2026-07-09)

| Adım | Motor karşılığı | Durum |
|---|---|---|
| 1-6 | `research_projects` profil JSONB; website/sosyal tarama job'ı (`profile:crawl`) | ❌ YOK — form + tarama + özet/ürün/farklılaştırıcı ön-doldurma ekranları yeni yapılacak |
| 7-8 | `research_hs_codes` / `research_markets` (tablolar 056'da var) | ❌ handler YOK — **WP11'e planlandı (2026-07-09 eklendi):** TradeMap API ile HS eşleme + (a) global ithalat + (b) satıcı-ülkesi→aday-ülke bilateral ihracat (hacim+büyüme); (b) adım 10'un onay kartına kanıt olarak akar |
| 9 | `icp:generate` + `research_icps` (/10 skor, CAS onay) + `research_geographies` create-or-reuse | ✅ motor · ❌ kart-kart wizard UI |
| 10 | `geo:analyze` + `research_geographies.spec` onayı (E tahmini dahil) | ✅ motor · 🟡 UI drawer var, akış yok |
| 11 | `trade:ingest` + Gümrük Verisi sekmesi (ücretsiz, `review`) | ✅ |
| 12-15 | `calibrate:run` + `research_company_feedback` + `icp:revise` + apply (ruleset bump) + mark-calibrated | ✅ motor + CalibrationDrawer · 🟡 teker-teker firma ekranı |
| 16 | `offer:generate` + `research_offers` + OffersPanel (onay/red/tavan) | ✅ |
| 17 | kredi/hold sistemi + tier dönem grant'ları | 🟡 kredi tarafı ✅; hücre-E toplamı + maliyet önizleme + proje "ölçek hedefi" alanı YOK |
| 18 | `channels:discover/harvest` (Y1) + trade Araştır (Y2) + `harvest:run` 11 açı (Y3) + `maps:harvest` + kalıcı hücre saturasyonu | ✅ motor · ❌ tek-tık orkestratör + canlı anlatım (şu an ayrı butonlar) |
| 19 | CompaniesPanel + hooks/angle chip'leri + CellCoveragePanel (N/E, doygunluk) | ✅ · 🟡 müşteri-yüzü "istemiyorum" (suppress + 👎) eksik |
| 20-21 | Hunter enrichment (strict domain match, ömürde-bir fatura) + Kişiler sekmesi + maliyet önizleme | ✅ |
| 22 | export RPC + export-anı ICP/geo pinleme (mig 104) + kontak sweep + custom_fields (ICP/Angle/Hooks) | ✅ |
| 23 | `feedback:aggregate` (günlük) + `research_outcome_stats` + yanıt-oranı rozetleri + opt-out→suppression | ✅ |
| genel | wizard durum makinesi (`flow_state`), kaldığı yerden devam, onay-zinciri düşürme | ❌ YOK |

**Özet:** motor ve "akıl katmanı" büyük ölçüde hazır; eksik olan **akışın kendisi** — müşteriyi teker teker taşıyan wizard kabuğu ve FAZ 1-2'nin ön-doldurma job'ları.

## İnşa sırası önerisi (delta)

1. **Wizard iskeleti:** `research_projects.flow_state` + tek-ekran çerçevesi (ilerleme çubuğu, geri dön, otomatik kayıt). Mevcut sekmeli ResearchPage'in ÜSTÜNE, mevcut panelleri adımlara giydiren kabuk — paneller yeniden yazılmaz.
2. **`profile:crawl` job'ı:** website + sosyal → firma özeti + ürün/hizmet listesi + farklılaştırıcı ön-doldurma (FAZ 1'in kalbi; adım 2-5'i besler).
3. **Sub-ICP kart akışı:** icp:generate çıktısını kart-kart sun; ülke chip'leri (öneri + dropdown) doğrudan geographies create-or-reuse'a bağlanır.
4. **Kalibrasyonu teker-teker'e giydir:** CalibrationDrawer'ın örneklem tablosunu firma-başına-ekran akışına çevir.
5. **Ölçek ekranı:** hücre E toplamı + kredi maliyet üst-sınır önizlemesi + proje ölçek hedefi alanı.
6. **Derin-araştırma orkestratörü:** tek "başlat" → hücre sırasıyla Y1 keşif→hasat → Y3 → (Y2 varsa) zinciri + canlı anlatım satırları (job progress → insan dili).
7. **Müşteri-yüzü "istemiyorum":** sonuç tablosunda suppress + 👎 kaydı.
8. **HS/TradeMap** (adım 7-8): en sona — ilk sürümde ülke önerileri LLM + eldeki veriyle gelir.
9. **WP11 — TradeMap API entegrasyonu** (2026-07-09 eklendi, kullanıcı talebi): HS eşleme + satıcı-ülkesi bilateral ihracat verisi. Spec: `Tg-Research-v2/05_SONRAKI_ADIMLAR.md` A-1 WP11. WP6-10'dan sonra sıraya girer (TradeMap API erişimi/plan onayı gerektirir — açık konu).

---

## v1 (eski 23 madde) → yeni adım eşlemesi

| v1 | Konu | Yeni adım |
|---|---|---|
| 1-2 | Anlaşma + büyük kurulum formu | 1-6 (form parçalandı: 4 alanlı kurulum + AI ön-doldurmalı mikro-adımlar) |
| 3-4 | HS Code adayları + onay | 7 |
| 5-6 | TradeMap + coğrafya stratejisi | 8 + 9 (ülke önerileri sub-ICP kartlarının içine gömüldü) |
| 7 | Coğrafya onayı | 9-10 |
| 8 | HS Code akıştan çıkar | 8 (sistem notu) |
| 9-10 | ICP Master + /10 skor | 9 |
| 11-12 | ICP × Coğrafya komboları + seçim | 9 (kart içi ülke chip'leri) + 10 (hücre onayı) |
| 13-17 | 10 örnek firma → geri bildirim → revize → tekrar 10 → mantık onayı | 12-15 (kalibrasyon döngüsü, WP1 ile inşa edildi) |
| 18 | Ölçek hedefi | 17 |
| 19-20 | Geniş araştırma + sonuç listesi | 18-19 (Y1/Y2/Y3 + doygunluk + hook/açı eklendi) |
| 21 | Çalışan araştırması firma seçimi | 20 |
| 22-23 | Enrichment + lead listesi | 20-21 (Hunter ile inşa edildi) |
| — | *(v1'de yoktu)* farklılaştırıcılar, gümrük CSV, offer/açılar, CRM devri, geri-besleme, yaşayan döngü | 5, 11, 16, 22, 23, 24 |
