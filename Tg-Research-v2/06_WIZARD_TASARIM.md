# TG-Research v2 — Wizard Görsel Tasarım Planı

> **DURUM (2026-07-12): Stage 1 + Stage 2 BİTTİ, canlı doğrulandı.** Detay: `04_ILERLEME.md §4.31`. Stage 2 sırasında gerçek bir uygulama-çökmesi bulunup düzeltildi (IcpCard.tsx Textarea prop çakışması). UNCOMMITTED.

Kaynak: kullanıcı talebi (2026-07-12) — "TG-research wizard'ının frontend'i EXTREMELY GOOD olmalı." Araştırma: Typeform'un "bir soru bir ekran" felsefesi, 2026 SaaS onboarding pattern'leri (conversational/AI-narrated akış, milestone-bazlı stepper >6 adımda düz sayaçtan daha iyi çalışıyor, "everboarding"), AI loading-state pattern'leri (request→thinking→streaming→complete state'leri açıkça ayrılmalı, ilerleme her zaman görünür olmalı), kart-tabanlı onay UI pattern'leri (yoğun admin-panel hissi yerine progressive disclosure). Kaynaklar: Typeform tasarım tarihi (Smashing Magazine), uxpatterns.dev AI loading states, foundey.com stepper pattern'leri, Clay.com (en yakın GTM/prospecting emsali) onboarding analizi.

Gerçek mevcut ekran görüntüleri incelendi (`/private/tmp/.../scratchpad/shots/`, UX incelemesinden). **Teşhis:** yapı taşları GERÇEKTEN iyi (UX incelemesi zaten doğruladı — kalibrasyon puanlama kartı "en iyi ekran"), ama görsel katman TAMAMEN varsayılan Mantine: küçük beyaz kart sol-üstte sabit, altında dev boş beyaz alan, ince düz progress bar, jenerik mor buton, hiç motion yok, ve en önemlisi — **wizard hâlâ TAM CRM sidebar'ının (Dashboard/Şirketler/Pipeline/...) İÇİNDE render ediliyor.** Bu, "TG-Research = TG-Core'un İLK ADIMI" ürün kararıyla doğrudan çelişiyor — yeni bir müşterinin gördüğü ilk şey bir "kurulum deneyimi" değil, "büyük bir CRM'in içine gömülü bir alt sayfa" gibi hissediyor.

## Karar 1 — Wizard kendi kabuğunu alsın (en yüksek etkili, en ucuz değişiklik)

`WizardShell.tsx` sırasında (yalnız `/research` altında, `/research/full` DEĞİL — mevcut sekmeli görünüm aynı kalır) tam CRM sidebar+topbar'ı GİZLE veya minimal bir varyantla değiştir: küçük sabit üst şerit (logo işareti + faz-bazlı ilerleme + "Kaydedildi" durumu + gerekirse "Panele dön" linki), geri kalan TÜM viewport step içeriğine ayrılsın, kart dikeyde ORTALANSIN (şu an sol-üstte sabit + altında kullanılmayan devasa boşluk var). Bu, Linear/Stripe/Notion'ın kurulum akışlarının ortak noktası — kurulum sırasında ana ürün kromu geri çekilir.

## Karar 2 — Düz "Adım X/23" yerine faz-bazlı ilerleme

Araştırma net: 6 adımdan sonra düz sayaç/nokta anlamsızlaşıyor ("kullanıcı 4. noktaya varır, yarıda mı sonda mı bilmez"). Ürünün zaten doğal 7 fazı var (`tg-research-ana-akis.md`): Kurulum → Profil → Ürün/HS → ICP → Kalibrasyon → Coğrafya/Ölçek → Sonuçlar. Üst şeritte 7 etiketli segment (mevcut faz vurgulu, geçmiş fazlar check'li, gelecek fazlar soluk) + faz İÇİNDE ince bir alt-ilerleme. "23 adımdan kaçıncısındayım" değil "hangi AŞAMADAYIM" hissi.

## Karar 3 — Tipografi ve marka rengi (Mantine içinde kalarak, yeniden yaratmadan)

Mevcut mor/violet marka rengi KORUNUYOR (TG-Core'un zaten kurulu kimliği, değiştirilmez) ama şu an yalnız buton/rozet düzeyinde düz kullanılıyor. Her ekranın başlığı ("Sizi tanıyalım", "Kaç firma bulalım?") o ekranın TEK hero anı — şu an ~24px kalın başlık, sıradan form etiketi gibi duruyor. Net tip ölçeği: hero soru başlığı büyük+güvenli ağırlıkta (mevcuttan belirgin şekilde büyük), açıklama satırı gri+küçük (mevcut gibi kalsın, bu doğru), form elemanları arası nefes payı artırılsın (şu an sıkışık).

## Karar 4 — Motion, disiplinli ve amaçlı (her yerde değil, doğru yerlerde)

- **Adım geçişi:** şu an anlık swap. Mantine `Transition` ile içerik fade/slide ile değişsin (`prefers-reduced-motion` saygılı). Bu SADECE step-render noktasına dokunduğu için Track A'nın (ICP kart/kalibrasyon state machine fix'i) aktif dosyalarıyla çakışabilir — **bu parça Stage 2'ye, Track A bitene kadar ERTELENDİ.**
- **AI bekleme ekranları:** UX incelemesi kendi tutarsızlığı zaten buldu — resample ekranı aşama anlatımlı (iyi), revizyon bekleme ekranı çıplak spinner (kötü). Araştırma net bir yapı öneriyor: istek-onayı → aşama etiketi (düz dil: "Aranıyor", "Değerlendiriliyor", değil "Processing") → iptal/bekleme kontrolü → tamamlanma. TEK paylaşılan bir bileşende birleştirilmeli — ama bu bileşen bugün muhtemelen `ResearchFlowPage.tsx` içine gömülü (ayrı dosya olarak bulunamadı), yani bu da **Stage 2'ye, Track A bitene kadar ERTELENDİ.**
- Bu ikisi dışında: buton hover/tık mikro-etkileşimleri, kart giriş animasyonu gibi küçük, düşük riskli motion HEMEN eklenebilir (paylaşılan dosyalara dokunmadan, örn. `WizardShell.tsx`, `OfferCard.tsx` içinde).

## Karar 5 — Kart yoğunluğu: sade ekran + gerçek "detaylar" çekmecesi

UX incelemesi: kart ekranları (ICP, offer/angle) ham sinyal/kural/lookalike editörünü TEK SEFERDE gösteriyor — "admin config panel" gibi hissediyor, ürünün kendi tasarım sözünü ("sade ekran + detayları gör çekmecesi") tutmuyor. Offer kartında dahil, ham internal kod (`PREMIUM-BRAND-PULL`) en belirgin görsel öğe — bu YANLIŞ hiyerarşi. Doğru hiyerarşi: insan-okur sentez (ad, tek cümlelik özet, kanıt noktaları) ÖNDE ve büyük; ham chip/kural editörü bir "Detaylar" aç/kapa arkasında. **`OfferCard.tsx` bu Stage 1'de yapılabilir** (Track A/B'nin dosyaları değil). ICP kartının kendisi (`IcpCard.tsx`) Track A'nın dosyası — **Stage 2'ye ERTELENDİ.**

## Karar 6 — Etkileşim cilası (küçük ama her yerde hissediliyor)

Gated butonlar (precondition sağlanmadan tıklanabilir kalıp SONRA toast hatası) yerine disabled + tek satır sebep. Boş/hata durumları "yön veren" bir sesle yazılsın (ne oldu + ne yapılmalı), özür dileyen/belirsiz değil. Bu değişiklikler dosya-bazında dağınık — Stage 1'de dokunulacak dosyalarda (WizardShell, OfferCard, results panelleri) uygulanır; Track A/B'nin dosyalarındaki örnekler Stage 2'ye kalır.

## Karar 7 — İmza an (skill'in "tek hatırlanacak öğe" ilkesi)

Ürünün özü "AI gerçek araştırma yapıyor ve NEDEN'i gösteriyor." Bu yüzden imza an: AI'ın kanıt/gerekçe gösterdiği her yer (kalibrasyon kanıt metni, ICP/offer kartının "neden" satırı, canlı orkestrasyon sayacı) görsel olarak müşterinin kendi girdisinden AYRIŞTIRILSIN (ör. ince bir "AI değerlendirmesi" etiketi/çerçevesi) — geri kalan her yerde disiplin: form ekranları sade kalır, boldluk buraya harcanır.

## Uygulama sırası (dosya çakışması nedeniyle iki aşamalı)

Track A (ICP kart yığılması + kalibrasyon dead-end fix) ve Track B (4 küçük WP11 cila maddesi) şu an `ResearchFlowPage.tsx`, `useCalibration.ts`, `IcpCard.tsx`, `GeoCellDetail.tsx`, `IcpCountryChips.tsx` dosyalarını aktif düzenliyor. Bu görsel tasarım işi AYNI dosyalara paralel yazarsa gerçek bir çakışma/veri kaybı riski var (önceki bir `git stash` olayı zaten bunun ne kadar kırılgan olduğunu gösterdi).

- **Stage 1 (HEMEN başlar, dosya çakışması riski SIFIR):** `WizardShell.tsx` (kabuk: sidebar gizleme, faz-bazlı ilerleme, dikey ortalama) + `OfferCard.tsx` (hiyerarşi + detaylar çekmecesi + mikro-motion) + sonuç panelleri (`CompaniesPanel.tsx`/`EnrichmentPanel.tsx`, salt görsel/hiyerarşi, WP10'un `lockScope` mantığına DOKUNMADAN).
- **Stage 2 (Track A + Track B bitince):** adım-geçiş motion'ı (`ResearchFlowPage.tsx`), paylaşılan AI-bekleme bileşeni (aynı dosyadan çıkarılacak), `IcpCard.tsx` hiyerarşi/motion, `CalibrationDrawer.tsx` görsel cila (Track A muhtemelen buraya da dokunacak), `GeoCellDetail.tsx`/`IcpCountryChips.tsx` görsel cila.

## Kilitli invariant'lar (04 §5) — dokunma

Hiçbir görsel değişiklik: billing/COGS mantığına, tenant-izolasyonuna, suppress/dedup mantığına, K10'a dokunmaz. Bu SADECE görsel/etkileşim katmanı — state machine, route, DB şeması YOK.
