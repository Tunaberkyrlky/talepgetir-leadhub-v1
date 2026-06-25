# TG-Research v2 — Mimari Plan

> Sade dille yazıldı. Amaç: tüm adımların mimari kararlarını netleştirmek.
> Kaynak: `tg-research-ana-akis.md` (akış) + `Tg-Research-v1-bakis/` (gerçek v1 sistemi).

---

## 0. v1 → v2: ne değişiyor

**v1 bugün:** Dosya tabanlı. Her müşteri bir klasör; ICP'ler `.md`, durum `state.json`, bulunan firmalar CSV, "görülen firmalar" `*_FOUND.txt`. Arama elle açılan terminallerde, parça parça (chunk). Veritabanı yok, arayüz yok, dedup CSV okuyarak yapılıyor. Tek kişinin (uzman danışman) elle yürüttüğü bir sistem.

**v2 hedef:** TG-Core'un içinde bir **modül**. Veritabanı + ayrı işçi (worker) servisi + arayüz. **Self-serve ve kullanım bazlı** — trial kullanıcı bile kendi firmasının birkaç ICP'sini birkaç coğrafyada tanımlayıp sonucu CRM'e bağlayabilir.

**Sabitlenen 3 karar:**
1. **Tek akış** — satış öncesi / sonrası ayrımı yok. Her şey tek hat.
2. **Her müşteri = tenant** (trial dahil; lite ön-tenant yok). Sonuçlar CRM'e import edilir.
3. **Ayrı worker + self-host arama** (SearXNG + Gosom) + Postgres iş kuyruğu.

---

## 1. Temel mimari kararlar (her adımı etkiler)

**K1 — Yerleşim (modül sınırı).**
Research, TG-Core içinde izole bir modül: `server/src/routes/research/`, `server/src/lib/research/`, `client/src/pages/research/`, `research_*` tablolar, `/api/research` altında. CRM/kampanya koduna **dokunmaz**; tek köprü "Import to CRM".

**K2 — Tenant + self-serve + kullanım.**
Standart TG-Core çok-tenant yapısı. Her müşteri (trial dahil) bir tenant. Kullanım sayacı = **nitelikli lead** (detay: `01_KREDI_FIYATLAMA.md`). Self-serve; onboarding'de biz gösteririz.

**K3 — Worker + iş kuyruğu.**
Uzun süren işler (web araması, firma doğrulama, liste hasadı, enrichment) istek/yanıt döngüsünde **koşmaz**:
- API işi `research_jobs` tablosuna (Postgres kuyruk) yazar,
- ayrı bir **Railway worker servisi** kuyruğu çeker, eşzamanlılık sınırıyla koşar, ilerlemeyi ve sonucu DB'ye yazar.
Bu, v1'in "elle açılan paralel terminaller" modelinin doğru karşılığı — ama durdurulabilir, tekrar denenebilir, izlenebilir.

**K4 — Self-host arama + fallback scraper.**
- **SearXNG** (kendi sunucumuz, `:8888`, JSON, DataImpulse dönen-proxy) → çok-motorlu web araması.
- **Gosom** → Google Maps üzerinden firma + iletişim.
- **Fallback scraper (v2'de yeni, kurallı):** site düz `fetch` ile alınamazsa (SSL hatası, JS-ağır sayfa, 403/blok) → **başsız tarayıcı** (Playwright) ile dene → o da olmazsa firmayı "incelemeye işaretle". v1'de bu dağınık/elle yapılıyordu; v2'de deterministik kural.
- **Dağıtım:** worker + SearXNG + Gosom + fallback tarayıcı **Railway**'de koşar (Railway CLI ile kurulur).

**K5 — LLM (yapay zekâ) kullanımı.**
- Web'i **deterministik araçlar** tarar (SearXNG/Gosom/liste hasadı). LLM **yorumlar**: firma uygun mu (MATCH/PARTIAL/ELIMINATED), skoru, gerekçesi, tek cümle özeti; ve ICP/coğrafya gibi adımları **üretir**.
- Claude API worker'da, **şemalı çıktı** (şema = sözleşme; yanlış formatta tekrar dener).
- Ağır/çok işte ucuz model (Sonnet), ICP sentezi gibi az ama zor işte güçlü model (Opus).
- **Önemli:** "1 nitelikli firma = sabit fiyat"; arkadaki modeli değiştirsek bile müşteri fiyatı değişmez (model ↔ fiyat ayrık).

**K6 — Kalıcı firma kütüğü + cache (DEDUP — çekirdek).**
- **`research_companies` = kalıcı kütük.** Tenant başına alan adı (domain) **benzersiz**. Tutulan VE elenen firmalar, hepsi **özetiyle** (`site_summary`) burada. Bir firma bir kez işlendiyse **bir daha taranmaz** — kütükten okunur (ücret de alınmaz).
- **`research_search_cache`** = sorgu → sonuç (süreli). Aynı arama sorgusu tekrar koşmaz.
Sonuç: "aynı firmaların sitelerini/URL'lerini tekrar tekrar taramak" tamamen biter; hem hız hem maliyet.

**K7 — İnsan onay kapıları (yarı-rehberli).**
Her AI adımı bir **taslak** üretir → müşteri onaylar / revize eder / puanlar. Onaysız sonraki adıma geçilmez (v1 ilkesi). Müşteri uzman değil; AI **örnek + gerekçe + önerilen varsayılan** sunar, ama müşteri detayı düzenleyebilir (tam-otomatik ile elle arası).

**K8 — CRM sınırı (tek yön) + mesaj devri.**
`research_companies` / `research_contacts` → müşteri seçer/onaylar → mevcut `lib/importProcessor` → `companies` / `contacts`. Devirden önce **AI-destekli mesaj taslakları** üretilir (per-ICP / firmaya özel). Sonra **mevcut** kampanya / e-posta / yanıt modülleri devralır. Research bu tablolara asla doğrudan yazmaz.

**K9 — Uyum / KVKK & veri koruma.**
- **Hukuki sebep:** B2B iş iletişim verisi; KVKK m.5/2(d) **alenileştirilmiş veri** (sitede/LinkedIn'de yayımlanmış iş maili) + m.5/2(f) **meşru menfaat**. Hassas veri toplanmaz; veri minimizasyonu (firma + rol + iş maili/tel).
- **Roller:** tenant = veri **sorumlusu**, Talepgetir = veri **işleyen** → her tenant'la **DPA** (veri işleme sözleşmesi) + gizlilik politikası + **alt-işleyen listesi** (Anthropic, BetterEnrich, Supabase, proxy, DeepL).
- **Silme/suppression birinci sınıf:** `research_contacts`/`research_companies`'de `suppressed`/`deleted` durumu; talep gelince kütük o varlığı **tekrar eklemez** (**suppression > dedup**). Kampanya opt-out'u kütüğe geri akar.
- **Yurt dışı aktarım:** Supabase mümkünse **AB bölgesi**; ABD işleyiciler (Anthropic/BetterEnrich) için SCC / açık rıza duruşu; aktarım dayanağı belgelenir.
- **Saklama:** firma-seviyesi veri tutulur; kişi PII için saklama penceresi + churn/atalette anonimleştirme; iptalde export + silme. **VERBİS** eşik kontrolü + üründe aydınlatma metni.

---

## 2. Akış — adım adım mimari kararlar

Her adım için: **ne olur · kim onaylar · nerede koşar · hangi tablo · hangi araç**.

### FAZ A — Kurulum & profil
- **A1. Firma profili.** Website, ne yapıyor, ürün/hizmetler, hedef müşteri tipleri, hedef pazarlar, mevcut müşteriler, hariç tutulacaklar. AI website'i tarayıp formu **ön-doldurur**, müşteri düzeltir.
  · Onay: müşteri · Koşum: tarama → worker, form → API · Tablo: `research_projects` (+ profil JSON) · Araç: SearXNG/fetch + LLM.

### FAZ B — ICP & pazar tanımı
- **B1. HS Code adayları.** Fiziksel ürünlerden HS Code adayları → müşteri eler/onaylar. · LLM · `research_hs_codes`.
- **B2. Pazar analizi (TradeMap).** Onaylı HS Code'lardan en çok ithalat yapan ülkeler, hacim, büyüme. **TradeMap scrape edilir** (paket bazlı: kaç HS code taranabilir sınırlı). · worker · `research_markets`.
- **B3. Coğrafya hedefleme stratejisi.** Hangi ICP hangi ülkede anlamlı, öncelik, puan → müşteri puanlar/revize. · LLM · `research_geographies`.
- **B4. HS Code'u birincil anahtardan çıkar.** Sonraki adımlar ICP + coğrafya + sinyal + negatif kriterle çalışır (HS yalnız pazar analizi + "nereden arayalım" ipucu).
- **B5. ICP Master.** Segmentler, tercih / negatif / nötr sinyaller, eleme kuralları, lookalike firmalar → müşteri her ICP'yi **/10 puanlar** + not. *(v1'de net /10 yoktu.)* · LLM · `research_icps`.
- **B6. ICP × Coğrafya kombinasyonları.** En güçlü kombinasyonları sırala → müşteri seçer/puanlar/not. · LLM · `research_chunks` (plan tarafı).
- **B7. (Opsiyonel girdi) Gümrük / ticaret datası ingest.** Müşteri başına önce **manuel CSV yükleme** (firma adı, aldığı HS code'lar, ihracat tutarı, website, firma özeti, iletişim email/tel) → aday firmalar; sonra API. v1'in `duzenle.py`'si (içerik-bazlı temizleme) v2'ye **port edilir**. · worker · `research_trade_imports` → `research_companies`.

### FAZ C — Kalibrasyon (ölçeklemeden önce)
- **C1. 10 örnek firma.** En yüksek ICP×Coğrafya'dan 10 firma + neden uygun → müşteri "iyi / değil". · arama+validasyon → worker · `research_companies`.
- **C2. Revize + tekrar 10.** Geri bildirimle ICP/sinyal/arama mantığı güncellenir → tekrar 10 → müşteri **mantığı onaylar**.
- **C3. Ölçek hedefi.** Kaç firmaya genişleyelim — müşteri belirler. · `research_projects`.

### FAZ D — Ölçekli arama (motor)
- **D1. Chunk motoru.** Her **alt-ICP × coğrafya hücresi** için arama → dedup → validasyon → kütüğe yaz. **Detay aşağıda §3.** · Worker, paralel chunk · `research_companies`, `research_chunks`.
- **D2. Coverage agent.** Chunk başına **bulunan (N) / tahmin (E)** + doygunluk → karar: devam / bitti / boşluk. · `research_chunks`.
- **D3. (Opsiyonel) Tesis hedefleme.** Çok-tesisli firmada ICP ürününü yapan **doğru üretim tesisini** bul (konum + hedef rol). · `research_companies`.

### FAZ E — Enrichment (kişi/iletişim) — *en son öncelik*
- **E1. Firma e-postası = scrape** (info@, sitedeki adresler). Kişi/karar verici gerekiyorsa **BetterEnrich** (domain → çalışanlar API'si; `.env`'de yapılandırıldı). *(Bu faz en sona bırakıldı; asıl değer firma kurulumunda.)* · worker · `research_contacts`.

### FAZ F — Mesaj + CRM'e devir
- **F1. AI-destekli mesajlar.** Per-ICP / firmaya özel e-posta taslakları (house-style → ICP → firma). · LLM → müşteri onayı · `research_messages`.
- **F2. Import to CRM.** Seçilen firma + kişi + mesaj → `importProcessor` → `companies` / `contacts`. Sonra **mevcut** kampanya modülü çalışır (yeni yazılmaz).

### Opsiyonel (sonra)
- Gelir projeksiyonu (funnel/ROI), HTML sunum/deck. Ana hat değil.
- **Not:** PROCESS_MAP'teki kampanya → yanıt → raporlama TG-Core'da **zaten var** (`campaigns`, `email-connections`, `email-replies`, `tracking`). F2'den sonra devredilir.

---

## 3. Arama motoru (detay) — ürünün kalbi

**Üç aday-üretim yolu, hepsi tek dedup kütüğüne akar:**

- **Y1 — Liste hasadı (🥇 EN GÜÇLÜ).** İki adım: önce **kanal keşfi**, sonra **hasat**.
  - **Kanal keşfi:** her SEKTÖR × hedef ülke için **erişilebilen TÜM** firma-listesi kaynağını bul (birkaç bilinen kaynakla yetinme):
    - **Dernekler** (ulusal + bölgesel + alt-sektör) → üye listeleri,
    - **Fuarlar** (ülke içi + o ülkenin katıldığı uluslararası) → katılımcı listeleri,
    - **B2B dizinler** (global: Kompass/Europages; ulusal: ThomasNet/ABIMAQ/"Wer liefert was" vb.; sektörel dikey dizinler),
    - **Ticaret/sanayi odaları** (ulusal + bölgesel + ikili odalar),
    - **Resmi kayıtlar** (firma/ihracatçı sicili, Rusprofile, D&B),
    - **Gümrük datası** (HS code → ImportYeti/Volza),
    - **Sanayi kümeleri / OSB / serbest bölge** kiracı listeleri,
    - **İhracatçı birlikleri / alıcı kayıtları**, sektör **marketplace/portalları**,
    - **Harita** (Gosom, küme şehirlerinde), "top N / list of" editöryel sayfalar.
  - **Hasat:** her kanalın üye/katılımcı/kiracı sayfasını **WebFetch et → coğrafyaya göre filtrele** → toplu aday. Tek liste onlarca firma verir; açık-web aramasından çok daha ucuz.
  - Keşfedilen her kanal `research_channels`'a yazılır (tip, URL, üye-liste URL'i, keşif turu, hasat durumu).
- **Y2 — Gümrük-tohumlu.** B7'deki ticaret datası → doğrudan aday firmalar (en saf liste).
- **Y3 — Açık-web açı araması.** Aşağıdaki 11 açı → tekil adaylar (liste hasadının kaçırdıklarını toplar).

**Kaynak kullanım sırası (v1 "KULLANIM SIRASI", birebir korunur):**
1. Gümrük/ithalat datası (ImportYeti/Volza, HS code) → en saf liste
2. **Fuar/dernek üye listeleri** → segment havuzu (🥇)
3. B2B dizin + alıcı kayıtları → boşluk doldur
4. Alt-ICP **keyword + yerel dil** ile süz (importer/wholesaler tut, perakende/üretici ele)
5. **Kümelere odaklan** (blanket şehir araması yerine)

**11 arama açısı (v1 framework, açık-web tarafı):**
1. Doğrudan ICP sorgusu (eyalet + top-5 şehir) · 2. Eşanlamlı / yerel sektör terimleri · 3. Ulusal/bölgesel dizin + `site:` filtre (*tek başına çoğu firmayı yakalar*) · 4. Lookalike domain ("competitors of X") · 5. **Fuar/dernek üye listesi → WebFetch** · 6. LinkedIn (`site:linkedin.com/company`) · 7. Negatif inversion (yanlış-firma örneğiyle ayıkla) · 8. Reverse-lookup (müşteri tarafından) · 9. Marka subsidiary/distribütör ağı · 10. Yerel dil (İng. olmayan coğrafyada **zorunlu**) · 11. Marketplace/portal reverse-lookup.

**Liste-hasadı keşif açıları (kanal bulma, çok-dilli):** `"{sektör} derneği {ülke}"` / `"{sector} association {country}"` / yerel dil (`Verband`, `syndicat`, `ассоциация`...) · `"{sector} manufacturers directory {country}"` · `"{sector} fair exhibitors {country}"` / `"... Aussteller ..."` · `"list of {sector} companies {country}"` / `"top {sector} manufacturers {country}"` · oda & sicil (`"chamber of commerce {sector} {country}"`, resmi firma sicili) · gümrük (HS code) · küme/OSB (`"{sector} industrial zone {country}"`). **Amaç: o ülkeye dair ulaşılabilen HER dizini bulmak.** MATCH / PARTIAL / ELIMINATED + skor (0-100) + kanıt cümlesi (siteden alıntı) + tek cümle özet + email/tel → **kütüğe yaz** (tutulan ve elenen, hepsi özetiyle).

**İki saturasyon kuralı (ikisi birlikte "bitti" der).**

**(A) Liste-hasadı saturasyonu.** Kanal keşfi şu **HEPSİ** sağlanınca durur:
- çok-dilli keşif açılarının hepsi koşuldu,
- **son 2 keşif turunda yeni kanal/dizin çıkmadı**,
- o ülkenin kanonik kaynakları kapatıldı (büyük ulusal dernekler + ilgili fuarlar + global dizinler + ulusal dizin + gümrük kaynağı + ana kümeler),
- keşfedilen her kanal hasat edildi (veya "erişilemez" işaretlendi).
"Biri eksikse DEVAM ET." → bir ülke için **ulaşabildiği tüm dizinleri** tarar.

**(B) Açık-web saturasyonu (v1, birebir).** Bir chunk ancak şunların **HEPSİ** sağlanınca "bitti" (`fully_covered: true`):
- tüm 11 açıdan 2-3'er sorgu (Açı 10 yalnız İng.-olmayan coğrafyada zorunlu),
- **son 2 sorguda tek yeni firma çıkmadı**,
- ICP örnek firmaları arandı, en büyük 5 şehir tarandı, ≥2-3 ulusal dizin tarandı.

Eşik = **2** (config). Coverage matrisi: (A + B doygun) × (N/E) → bitti / boşluk / devam.

**Fallback scraper.** `fetch` başarısız (SSL/JS/403) → başsız tarayıcı (Playwright) → yine olmazsa "incele" işareti (regresyon yok, firma kaybolmaz).

---

## 4. Veri modeli (research_* tablolar) — sade

Hepsi `tenant_id` taşır ve RLS ile izole (cache hariç). Tam SQL sonra; burası niyet.

| Tablo | Ne tutar (özet) |
|---|---|
| `research_projects` | Müşteri firma profili, durum, ölçek hedefi |
| `research_hs_codes` | Aday / onaylı HS Code'lar |
| `research_markets` | TradeMap çıktısı: ülke, ithalat hacmi, büyüme |
| `research_icps` | Segment, alt-ICP kodu, sinyaller (JSON), eleme kuralları, lookalike, **insan /10 skoru**, not, durum |
| `research_geographies` | ICP × coğrafya hücresi: geo kodu, **E tahmin**, güven, dayanak |
| `research_channels` | **Kaynak kanalları** (sektör × ülke): tip (dernek/fuar/oda/sicil/küme/dizin/gümrük/marketplace), ad, URL, üye-liste URL'i, keşif turu, hasat durumu (bekliyor/hasat/erişilemez), not |
| `research_chunks` | Çalışma birimi (ICP × geo) — çalışma anı: status, **N**, coverage, doygunluk |
| **`research_companies`** | **Kalıcı kütük / DEDUP.** tenant + **domain benzersiz**, ad, ülke/şehir, status (match/partial/eliminated), skor, **site_summary**, kanıt, eleme nedeni, email/tel, icp/geo ref, kaynak yolu (Y1/Y2/Y3), ilk görülme, son kontrol |
| `research_contacts` | Kişi: ad, unvan, LinkedIn, email, email durumu (doğrulanmış/tahmini), öncelik |
| `research_trade_imports` | Yüklenen gümrük datası (firma, HS code'lar, ihracat tutarı, website, özet, iletişim) → aday üretir |
| `research_messages` | AI-destekli e-posta taslakları (per-ICP / firmaya özel) |
| `research_search_cache` | Sorgu → sonuç (süreli). Public web verisi; maliyet düşürür |
| `research_jobs` | İş kuyruğu: tip, yük, durum, deneme, ilerleme, zaman |
| `research_usage_ledger` | Kullanım/lead defteri (bkz. fiyatlama dokümanı) |

**Çekirdek dedup:** yeni aday URL → domain normalize → `research_companies`'te var mı → **varsa (elenen bile) tekrar taranmaz**, özet kullanılır. `(tenant_id, domain)` benzersiz.

---

## 5. Araçlar / servisler (özet)

| Katman | Araç | Rol |
|---|---|---|
| Web arama | **SearXNG** (self-host + proxy) | Çok-motorlu arama |
| Harita/firma | **Gosom** | Google Maps firma + iletişim |
| Fallback | **Playwright** (başsız tarayıcı) | SSL/JS/blok olan siteler |
| Kaynaklar | Dernek/fuar listeleri, gümrük datası (ImportYeti/Volza/TradeMap-scrape), B2B dizin, LinkedIn, D&B, Rusprofile | Aday firma |
| Enrichment | Firma maili = scrape · kişi = **BetterEnrich** (domain→çalışan API, `.env`'de; en son) | İletişim |
| LLM | **Claude API** | ICP sentezi + validasyon + özet + mesaj |
| Temizleme | `duzenle.py` port (içerik-bazlı) | Gümrük CSV → aday |
| Çeviri | DeepL | Yerel dil terimleri |
| Ödeme | Stripe | Abonelik / paket |
| Devir | TG-Core mevcut modüller | Kampanya / e-posta / yanıt |

Açık kararlar: `02_ACIK_KONULAR.md`. Fiyatlama: `01_KREDI_FIYATLAMA.md`.
