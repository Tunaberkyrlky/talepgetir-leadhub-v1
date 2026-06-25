# TG-Research v2 — Kararlar & Açık Konular

Senin cevaplarınla çoğu netleşti. Aşağıda: **verilen kararlar** (plana işlendi) + **hâlâ açık / kalibre edilecek** + **önerilen ilk adım**.

---

## A. Verilen kararlar (plana işlendi)

**Fiyatlama**
1. Değer metriği = **nitelikli lead** (içeride ve dışarıda aynı). Büyük firmada **seat başına ek ücret**.
2. **Sadece MATCH ücretli**; PARTIAL/ELIMINATED ücretsiz.
3. **Trial = 50 firma** (maliyet dert değil; aha garanti).
4. Taban para birimi = **USD** (TR tahsilat TRY olsa da fiyat USD).
5. Tier iskeleti **Free / Starter / Growth / Scale** uygun (sayılar pilot sonrası).
6. **Paketler yıllık** (devreder); abonelik lead kotası aylık yanar.

**Veri kaynakları / araçlar**
7. **TradeMap = scrape** (paket bazlı HS-code sayı limiti).
8. Firma maili = **scrape**; kişi/karar verici = **BetterEnrich** ama **en son öncelik** — asıl iş firma kurulumu.
9. Self-host: **hem VPS hem Railway var**; ilk adımda **kurulumu kolay olanla** başla.
10. Gümrük datası: **önce manuel yükleme** (firma adı, HS code'lar, ihracat tutarı, website, firma özeti, iletişim email/tel), **sonra API**. Paket bazlı HS-code limiti.
11. Saturasyon = **v1 kuralı** (çıkarıldı: tüm açılar + son 2 sorguda yeni firma yok + örnekler + top-5 şehir + ≥2-3 dizin; eşik 2). **+ SSL/JS için fallback scraper** (Playwright).
12. Ana hat = **research + AI-destekli mesajlar**. Projeksiyon / HTML deck **sonra**.
13. `duzenle.py` (gümrük temizleme) **v2'ye port edilecek**.
14. Onay kapıları = **yarı-rehberli** (AI öneri + müşteri düzenleme; tam-otomatik ile elle arası).

**Multi-tenancy / ürün**
15. Her prospect = **tenant** (lite ön-tenant **yok**, sadeleştir).
16. **Self-serve**; onboarding'de biz gösteririz.

### Bu turda kapatılanlar (2026-06-25)
17. **Lead fiyatı = varsayımsal kapatıldı.** PAYG $1.00/MATCH; Free(50) · Starter $49·200 · Growth $199·1.000 · Scale $599·3.500; enrichment $0.25/kişi; yıllık 2 ay bedava. (`01 §4`) Pilot ince ayar yapar.
18. **Enrichment sağlayıcı = BetterEnrich** (domain→çalışan API, `.env`'de). En son öncelik.
19. **Self-host makine = Railway** (Railway CLI ile kurulur).
20. **Scrape dayanıklılığı:** mevcut fallback yapısı yeterli, böyle ilerliyoruz.
21. **KVKK duruşu (öneri kabul):** hukuki sebep = alenileştirilmiş veri + meşru menfaat; **tenant=sorumlu / Talepgetir=işleyen** → DPA + alt-işleyen listesi; **silme/suppression birinci sınıf (suppression > dedup)**; Supabase AB bölgesi + SCC; saklama penceresi + churn'de export; VERBİS. (`00 K9`)

---

## B. Hâlâ açık / kalibre edilecek (azaldı)

1. **Pilot COGS teyidi** — fiyatlar varsayımsal kapatıldı (`01 §4`); 1 gerçek run'da MATCH başı maliyet ölçülünce ince ayar (tier kotaları + trial maliyeti dahil).
2. **Saturasyon eşiği** — v1'de 2; v2'de config. Arama açıları v2'de aynen 11 (öneri kabul: config'lenebilir).
3. **Scrape dayanıklılığı** — mevcut fallback'le ilerliyoruz; pratikte blok/captcha çıktıkça sertleştirilir (izlenecek, blokör değil).

---

## C. Önerilen ilk adım

**Önce iskelet + en güçlü kaynaktan dikey dilim**, sonra pilot:

1. `research_*` tabloları + `/api/research` + worker + iş kuyruğu (boş ama çalışır).
2. Dikey dilim: **ICP Master üretimi** (B5) — uçtan uca (form → LLM → /10 puan ekranı → kayıt).
3. Motor çekirdeği: **liste hasadı (Y1 — dernek/fuar üye listesi) + dedup kütük + validasyon + saturasyon**. En güçlü kaynaktan başla; açık-web açıları (Y3) ve gümrük (Y2) sonra.
4. **Pilot müşteri** → gerçek COGS → lead fiyatı + tier kotaları (`01_KREDI_FIYATLAMA.md` §6).

Her adımda kullanım/marj ölçülür; fiyat ona göre oturur.
