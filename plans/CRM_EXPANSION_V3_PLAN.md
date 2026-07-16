# Tibexa CRM Expansion v3 — Lead Generation & Revenue Automation

**Durum:** Önerilen kanonik v3 ürün ve uygulama planı
**Oluşturulma:** 2026-07-10
**Ürün tanımı:** Acquisition, kişiselleştirilmiş içerik, multichannel nurture, booking, meeting intelligence ve post-meeting otomasyonu içeren uçtan uca lead generation platformu
**V2 ile ilişki:** V3, `CRM_EXPANSION_V2_PLAN.md` içindeki CRM çekirdeğini iptal etmez. Task, sahiplik, birleşik timeline, deal ve pipeline çalışma modeli v3'ün ön koşulu ve sistem-of-record katmanıdır.
**Kapsam dışı:** Reklam satın alma/optimizasyon motoru, video prodüksiyonu, ödeme/tahsilat, müşteri destek ticket sistemi ve tam pazarlama sitesi CMS'i

---

## 1. Yönetici özeti

Tibexa'nın hedefi yalnız ihracat araştırması veya klasik CRM değildir. Hedef ürün şu kapalı döngüyü yöneten bir **Lead Generation & Revenue Automation Platform** olmalıdır:

```text
Lead kaynağı
→ form/yanıt yakalama
→ kişi ve şirket oluşturma/eşleme
→ website araştırması ve qualification
→ kişiye özel rapor/lead magnet
→ email + WhatsApp + SMS nurture
→ booking
→ show-up sequence
→ meeting notetaker ve meeting intelligence
→ toplantı sonrası materyal + takip
→ opportunity/deal ve insan devri
→ sonuçlardan öğrenme
```

V3'ün asıl ürün değeri beş ayrı entegrasyon sunmak değildir. Değer, bu entegrasyonların aynı lead lifecycle, aynı conversation memory ve aynı durdurma/branch kuralları üzerinde çalışmasıdır:

- Lead cevap verirse satış mesajları durur ve conversation akışına geçer.
- Meeting booked olursa pre-booking nurture durur, show-up sequence başlar.
- Booking iptal veya reschedule olursa eski hatırlatmalar iptal edilir.
- Meeting biterse transcript/özet üretilir ve post-meeting sequence başlar.
- Negatif cevap, unsubscribe veya kanal opt-out ilgili kanalı anında durdurur.
- İnsan satış temsilcisi lead'i devralırsa otomasyon pause edilebilir.
- Yeni bir kişisel mesaj üretilirken lead'in geçmiş cevapları, toplantı özetleri, itirazları, vaatleri ve açık aksiyonları sürümlenmiş bağlam olarak kullanılır.

Bu nedenle v3 için email campaign tablolarını genişletmek yeterli değildir. Yeni bir kanal-bağımsız **event, automation, message ve lifecycle katmanı** gerekir.

---

## 2. V2 ve V3 ürün sınırı

| Katman | V2 sorumluluğu | V3 sorumluluğu |
|---|---|---|
| CRM kayıtları | Şirket, kişi, task, activity, owner, deal | Bu kayıtları otomatik üretir ve günceller |
| Pipeline | Stage, next action, ownership, deal | Lifecycle event'lerinden stage önerir veya kural bazlı ilerletir |
| Timeline | İnsan ve sistem etkileşim geçmişi | Tüm otomasyon event'lerini timeline'a besler |
| Acquisition | Kapsam dışı | Form, reklam, YouTube/landing, cold email reply intake |
| Enrichment | Temel firma alanları | Website crawl, qualification ve personalization context |
| Content | Not/attachment | Kişiye özel report/lead magnet üretimi ve hosting |
| Outreach | Mevcut email, cold call, LinkedIn modülleri | Kanal-bağımsız nurture ve stop/branch kuralları |
| Booking | Meeting activity | Cal.com booking lifecycle |
| Meeting | Manuel not | Bot, transcript, summary, action item ve materyal üretimi |
| Analytics | Pipeline/CRM metrikleri | Source → report → booking → show → opportunity attribution |

### 2.1 V3 için V2 ön koşulları

V3 geliştirilirken şu V2 işleri paralel yürüyebilir, fakat production otomasyonları açılmadan tamamlanmalıdır:

1. Task ve next-action modelinin tamamlanması
2. Firma, lead ve task sahipliği
3. Birleşik timeline event sunumu
4. Deal/opportunity karar kapısı
5. Stage transition sözleşmesinin tekleştirilmesi
6. Saved views ve operasyon kuyrukları

---

## 3. Hedef kullanıcı ve kullanım senaryoları

### 3.1 Kullanıcılar

- B2B growth/sales ekibi
- Ajans veya outbound operasyon ekibi
- Founder-led sales yapan küçük ekip
- Pazarlama operasyon yöneticisi
- Satış temsilcisi
- Müşteri hesabını yöneten client admin

### 3.2 Ana lead kaynakları

1. Cold email yanıtı
2. Google/YouTube Ads lead formu
3. Meta lead formu
4. YouTube açıklama/CTA üzerinden landing page formu
5. Organik website formu
6. Webinar, lead magnet veya assessment formu
7. Manuel kayıt/API/import
8. TG-Research tarafından üretilen outbound lead
9. LinkedIn reply veya bağlantı kabulü
10. Inbound WhatsApp/SMS mesajı

### 3.3 Ana sonuçlar

- Qualified lead
- Report viewed
- CTA clicked
- Reply received
- Meeting booked
- Meeting attended
- Meeting no-show
- Opportunity created
- Won/lost
- Nurture later
- Disqualified

---

## 4. Uçtan uca lifecycle

### 4.1 Lifecycle state'leri

```text
captured
→ identity_pending
→ enriched
→ qualified | disqualified | needs_review
→ asset_generating
→ asset_ready
→ nurture_active
→ engaged
→ booked
→ meeting_confirmed
→ attended | no_show | cancelled
→ post_meeting
→ opportunity
→ won | lost | long_term_nurture
```

Lifecycle, pipeline stage ile aynı şey değildir:

- **Lifecycle:** Sistemin acquisition/automation durumudur.
- **Pipeline stage:** Satış ekibinin ticari ilerleme durumudur.
- **Automation enrollment:** Belirli bir workflow'un çalıştırma durumudur.
- **Channel conversation:** Email/WhatsApp/SMS thread durumudur.

Bu dört kavram ayrı tutulur ve event'lerle senkronize edilir.

### 4.2 Stop koşulları

Her automation run aşağıdaki global koşulları değerlendirmelidir:

- Lead veya contact unsubscribe oldu
- Kanal opt-out kaydı var
- Email bounce/hard failure aldı
- WhatsApp template gönderimi engellendi
- Lead negatif yanıt verdi
- Meeting booked oldu
- Opportunity oluşturuldu ve insan devri yapıldı
- Lead disqualified edildi
- Kullanıcı automation'ı manuel pause etti
- Aynı amaçla çalışan daha yüksek öncelikli automation başladı

### 4.3 Branch koşulları

- Report görüntülendi / görüntülenmedi
- CTA tıklandı / tıklanmadı
- Email açıldı / tıklandı / cevaplandı
- WhatsApp mesajı delivered / read / replied
- Booking tamamlandı / iptal / reschedule
- Meeting attended / host no-show / guest no-show
- Lead score eşiği
- Qualification sonucu
- Tercih edilen kanal
- Yerel saat ve timezone
- İnsan owner aksiyonu

---

## 5. Mevcut sistemden yeniden kullanılacak parçalar

Graphify taraması sonucunda aşağıdaki parçalar korunmalı ve adapter olarak kullanılmalıdır.

| Mevcut parça | V3'te kullanım |
|---|---|
| `companies`, `contacts` | Canonical CRM entity'leri |
| `tasks` | İnsan devri, next action ve meeting action item'ları |
| `activities` | Birleşik timeline'ın mevcut event kaynağı |
| `campaigns`, `campaign_steps`, `campaign_enrollments` | Email-only legacy automation adapter'ı |
| `campaignEngine.ts` | Email template, sender rotation, tracking ve send-window mantığı |
| Mail router | Transactional ve automation email gönderimi |
| PlusVibe webhook + matcher | Cold-email reply intake ve thread matching |
| `webhookEnricher.ts` | Inbound payload ile boş CRM alanlarını doldurma kalıbı |
| `importProcessor.ts` | Company/contact normalize, dedupe ve batch upsert kalıbı |
| Research website fetch/profile crawl | Firma website analizi ve personalization context |
| Research LLM router/meter | Provider seçimi, JSON schema ve maliyet ölçümü |
| Cold-call/Twilio altyapısı | Tenant provisioning ve Twilio hesap hiyerarşisi |
| LinkedIn worker/sequence | Queue, pacing ve event-driven action kalıpları |
| PostHog | Funnel ve ürün davranış ölçümü |

### 5.1 Yeniden kullanılmaması gereken yaklaşım

Mevcut `campaign_steps.step_type = email|delay|condition` tablosu WhatsApp, SMS, report generation, booking ve meeting bot için doğrudan genişletilmemelidir. Aksi durumda:

- Kanal payload'ları tek tabloda birbirine karışır.
- Booking ve meeting event'leri email enrollment semantiğine zorlanır.
- Retry/idempotency ve stop koşulları kanal bazında farklılaşır.
- Legacy email campaign davranışı kırılma riski taşır.

Çözüm: Legacy email campaign engine çalışmaya devam eder; v3 automation runtime email aksiyonunu mevcut mail adapter'ına yollar. Daha sonra legacy campaign'ler isteğe bağlı migrate edilir.

---

## 6. Hedef ürün nesne modeli

## 6.1 Lead

Lead, contact veya company'nin kendisi değildir. Lead belirli bir acquisition intent'idir. Aynı kişi farklı zamanlarda farklı kampanya/teklif için birden fazla lead oluşturabilir.

| Alan | Amaç |
|---|---|
| `id`, `tenant_id` | Kimlik ve tenant |
| `company_id` | Eşlenen/oluşturulan şirket |
| `contact_id` | Eşlenen/oluşturulan kişi |
| `deal_id` | Qualification sonrası fırsat |
| `source_type` | cold_email, google_ads, meta_ads, youtube, website, whatsapp, import, research |
| `source_id` | Connector veya form kaynağı |
| `external_lead_id` | Kaynak dedupe anahtarı |
| `campaign_ref` | Reklam/campaign attribution |
| `lifecycle_status` | V3 lifecycle |
| `qualification_status` | qualified, disqualified, needs_review |
| `score` | Normalize lead score |
| `owner_id` | Lead sahibi |
| `captured_at` | İlk yakalama |
| `last_engaged_at` | Son anlamlı engagement |
| `booked_at`, `attended_at` | Conversion zamanları |
| `raw_submission_id` | Orijinal form submission referansı |
| `metadata` | Kaynağa özgü ek bilgiler |

## 6.2 Lead source ve connector

### `lead_sources`

- Tenant
- Provider/type
- Görünen ad
- Default owner
- Default automation
- Default form mapping
- Default lead magnet recipe
- Default booking event type
- Aktif/pasif

### `lead_source_connectors`

- Provider account reference
- Connection status
- Last event timestamp
- Configuration
- Cursor/sync state
- Health state

## 6.3 Form ve submission

### `lead_forms`

- Form name/source
- External form ID
- Field mapping
- Consent copy/version
- Success behavior
- Automation mapping
- Report recipe mapping

### `lead_submissions`

- Immutable raw payload
- External lead ID
- Normalized fields
- UTM/click IDs
- Submitted at
- Processing status
- Dedupe result
- Lead/company/contact IDs
- Test lead flag
- Error/review reason

Raw submission değiştirilemez; normalized CRM kayıtları daha sonra düzenlenebilir.

## 6.4 Attribution touchpoint

`lead_touchpoints` first-touch ve multi-touch attribution için tutulur:

- Source, medium, campaign, content, term
- GCLID/fbclid veya platform ref
- Landing URL/referrer
- Event type
- Event time
- Lead/contact/company

## 6.5 Generated asset

### `asset_recipes`

- Input requirements
- Prompt/schema version
- Template/theme
- CTA configuration
- Supported output: HTML/PDF/JSON
- Approval policy

### `generated_assets`

- Lead/company/contact
- Recipe/version
- Source evidence snapshot
- Generation status
- Structured content JSON
- Rendered HTML/PDF object keys
- Public/gated delivery mode
- Access slug/token version
- CTA/booking URL
- Approved by/at
- Published at

### `asset_events`

- viewed
- unique_viewed
- section_reached
- CTA clicked
- PDF downloaded
- booking opened
- booking completed

## 6.6 Automation

### `automations`

- Trigger
- Entry criteria
- Global stop conditions
- Version
- Status
- Goal event

### `automation_nodes`

Node türleri:

- trigger
- wait
- condition
- email
- whatsapp
- sms
- generate_asset
- publish_asset
- create_task
- assign_owner
- update_lifecycle
- update_stage
- booking_link
- meeting_bot
- human_approval
- webhook

### `automation_runs`

- Lead ve automation version
- Current node
- Run status
- Wake time
- Goal state
- Pause/stop reason
- Started/completed timestamps

### `automation_actions`

Her node execution için idempotent ledger:

- Run/node/attempt
- Input snapshot
- Provider request ID
- Status
- Scheduled/started/completed timestamps
- Retry reason
- Output/event reference

## 6.7 Conversation ve message

### `conversations`

- Lead/contact/company
- Channel
- Provider thread ID
- State: open, waiting_us, waiting_lead, closed
- Last inbound/outbound
- Owner

### `messages`

- Direction
- Channel
- Provider ID
- Template ID/version
- Body/media refs
- Delivery state
- Error
- Sent/delivered/read/replied timestamps
- Automation run/action reference

## 6.8 Booking ve meeting

### `bookings`

- Lead/contact/company/deal
- Provider/UID
- Event type
- Owner/host
- Start/end/timezone
- Status: requested, confirmed, rescheduled, cancelled, attended, no_show
- Join URL
- Booking answers
- Reschedule lineage

### `meetings`

- Booking
- Provider meeting ID
- Recording/transcript status
- Consent/recording disclosure state
- Started/ended
- Attendance
- Notetaker provider/bot ID

### `meeting_artifacts`

- Transcript object key
- Recording ref
- Structured summary
- Pain points
- Goals
- Objections
- Buying signals
- Commitments
- Questions
- Suggested stage
- Suggested follow-up
- Approved/published state

### `meeting_action_items`

Meeting insight'tan üretilen task adaylarıdır. İnsan onayıyla `tasks` kaydına dönüşür veya tenant ayarına göre otomatik oluşturulur.

## 6.9 Channel permission ve preference

Lead/contact bazında:

- Email subscribed/opted-out
- SMS consent state/source/time
- WhatsApp opt-in state/source/time
- Preferred channel
- Preferred contact time
- Locale/timezone
- Suppression reason

Bu kayıt yalnız teknik uyumluluk için değil, kullanıcıya “hangi kanaldan ulaşabilirim?” cevabını vermek için CRM yüzeyinde görünür olmalıdır.

## 6.10 Conversation memory

Conversation memory, her mesajda bütün email thread'ini veya ham transcript'i modele vermek değildir. Lead hakkında doğrulanabilir, güncel ve amaç odaklı bir bağlam katmanıdır.

### `conversation_memory`

- Lead/contact/company/deal scope
- Current relationship summary
- Lead'in açıkça ifade ettiği hedefler
- Pain points
- Objections
- Preferences ve yasaklı konular
- Geçmiş sorular ve verilen cevaplar
- Bizim verdiğimiz sözler/commitment'lar
- Lead'in verdiği sözler/commitment'lar
- Son meeting özeti
- Açık task ve next action
- Son meaningful touch
- Tone/language preference
- Last rebuilt at
- Source event watermark

### `memory_facts`

Her önemli memory parçası kaynak referansı taşır:

- Fact type
- Normalized value
- Source: email, WhatsApp, SMS, form, meeting, task, human note
- Source message/meeting/activity ID
- Observed at
- Superseded by
- Confidence
- Human pinned/edited state

### `generation_context_snapshots`

Her otomatik veya taslak mesaj üretiminde kullanılan bağlam immutable snapshot olarak saklanır:

- Message/automation action
- Prompt/recipe version
- Seçilen memory fact ID'leri
- Son konuşma turn'leri
- Meeting summary version
- Asset engagement
- Açık commitments/tasks
- Oluşturulan mesaj
- Human edit diff/approval

Bu snapshot, kullanıcının “bu mesaj neden böyle yazıldı?” sorusunu yanıtlar ve sonraki kalite değerlendirmesine veri sağlar.

---

## 7. Lead intake ve identity resolution

## 7.1 Canonical intake pipeline

```text
Provider webhook/API
→ raw submission kaydı
→ provider payload normalize
→ email/phone/domain normalize
→ existing contact/company match
→ create or enrich contact/company
→ lead intent oluştur
→ attribution touchpoint yaz
→ lifecycle event yayınla
→ enrichment automation başlat
```

### Kimlik eşleme sırası

1. Provider `external_lead_id`
2. Exact normalized work email
3. Exact normalized phone
4. Exact canonical website domain
5. Company name + country/location
6. Kişi adı + company/domain
7. Confidence düşükse `needs_review`

Otomasyon intake'i enrichment beklerken bloklamaz. Lead saniyeler içinde CRM'e düşer; website crawl async çalışır.

## 7.2 Company oluşturma

Formda website varsa:

- URL normalize edilir.
- Canonical domain çıkarılır.
- Aynı tenant'ta domain match aranır.
- Bulunamazsa company oluşturulur.
- Website profile crawl job'ı kuyruğa alınır.

Website yok, şirket adı varsa:

- Exact/fuzzy name + country match aranır.
- Tek güçlü sonuç varsa bağlanır.
- Belirsiz sonuç review kuyruğuna düşer.
- Uydurma website/domain üretilmez.

Şirket bilgisi yoksa:

- Contact + lead oluşturulur.
- Company bağlantısı `identity_pending` kalır.
- Kullanıcı veya enrichment daha sonra bağlar.

## 7.3 Contact oluşturma

- Cold email reply: mevcut sender/contact matcher kullanılır.
- Form lead: ad, email, telefon, unvan, tercih ve form cevapları normalize edilir.
- Aynı kişi tekrar form doldurursa yeni lead intent oluşabilir; contact duplicate oluşturulmaz.
- Form cevaplarının tamamı contact custom field'e gömülmez; submission'da kaynak kayıt olarak korunur, seçili alanlar CRM'e promote edilir.

## 7.4 Kaynak adapter'ları

### Generic website form

- Public form endpoint veya JS embed
- Tenant/form scoped endpoint
- Hidden UTM ve referrer alanları
- Success redirect veya inline asset/booking deneyimi

### Google/YouTube Ads lead forms

- Google Lead Form Webhook adapter
- `lead_id` dedupe anahtarı
- `form_id`, `campaign_id`, `adgroup_id`, `creative_id`, `gcl_id` attribution
- `is_test` ayrı işleme
- YouTube/video lead formu aynı Google adapter üzerinden gelir

### YouTube organic

- Açıklama, pinned comment veya video CTA'dan landing page
- UTM content = video ID/slug
- Landing form veya assessment
- Video bazlı conversion raporu

### Meta Lead Ads

- Webhook ile lead reference alma
- Provider API ile lead field retrieval
- Form mapping ve campaign/ad attribution
- Provider retry/dedupe ledger

### Cold email

- PlusVibe inbound reply mevcut adapter üzerinden
- Reply ilk kez eşleşiyorsa lead intent oluşturma
- Sent/replied thread'i conversation'a bağlama
- Sentiment/label automation branch'i

---

## 8. Website enrichment ve qualification

## 8.1 Yeniden kullanılacak TG-Research yetenekleri

- Canonical URL/domain
- Website fetch
- Homepage/about/social crawl
- Structured company summary
- Product/service extraction
- Company country evidence
- Differentiator extraction
- LLM provider routing ve schema validation
- Job queue, metering ve retry

V3, TG-Research tablolarını doğrudan CRM runtime olarak kullanmaz. Ortak engine fonksiyonları adapter üzerinden çağrılır; sonuç CRM-owned `lead_enrichment_runs` ve company/lead alanlarına kontrollü olarak yazılır.

## 8.2 Qualification recipe

Tenant veya lead source bazında yapılandırılır:

- Zorunlu form alanları
- Website evidence kriterleri
- Positive/negative signals
- ICP uyumu
- Coğrafya
- Firma büyüklüğü
- İhtiyaç/zamanlama/bütçe cevapları
- Work email/phone availability
- Intent signal

Çıktı:

- Score
- qualified/disqualified/review
- Evidence list
- Reason codes
- Suggested owner
- Suggested automation
- Suggested report recipe

## 8.3 Human review queue

Review sebepleri:

- Company identity belirsiz
- Website fetch başarısız
- Contact duplicate adayı
- Qualification confidence düşük
- Report için zorunlu veri eksik
- Kanal consent bilgisi belirsiz

Kullanıcı tek ekranda match seçer, alanı düzeltir veya lead'i disqualify eder.

---

## 9. Kişiselleştirilmiş report / lead magnet engine

## 9.1 Ürün deneyimi

1. Lead formu doldurur veya cold-email'e cevap verir.
2. Sistem website ve form cevaplarından personalization context oluşturur.
3. Seçili recipe structured report üretir.
4. HTML/PDF render edilir.
5. Satış temsilcisi gerekiyorsa preview/approve eder.
6. Asset Cloudflare üzerinden yayınlanır.
7. Email/WhatsApp mesajı kişiye özel linkle gönderilir.
8. View/CTA/booking event'leri automation branch'lerini tetikler.

## 9.2 Asset türleri

- Website growth audit
- Export readiness report
- ICP opportunity map
- Competitive positioning brief
- Cost/revenue calculator sonucu
- Personalized benchmark
- Meeting preparation brief
- Post-meeting proposal companion

## 9.3 Generation pipeline

```text
Recipe + lead submission + company evidence
→ structured JSON generation
→ schema validation
→ factual/evidence pass
→ tenant theme render
→ HTML artifact
→ optional PDF
→ preview
→ publish
```

LLM doğrudan serbest HTML üretmez. Structured content JSON üretir; belirlenmiş template render eder. Böylece tasarım, CTA, analytics ve versiyonlama tutarlı kalır.

## 9.4 Approval politikası

- `manual`: Her asset insan onayı ister.
- `sampled`: İlk N ve düşük-confidence asset'ler onay ister.
- `automatic`: Yalnız onaylı recipe/version ve minimum evidence eşiğinde otomatik yayınlar.

## 9.5 Cloudflare dağıtımı

Önerilen ilk mimari:

- R2: HTML, PDF, görsel ve meeting materyali object storage
- Cloudflare Worker: `reports.<domain>/<tenant>/<slug>` delivery endpoint'i
- Custom domain: production URL ve cache/analytics kontrolü
- Worker → R2 binding: server-side object erişimi
- Token veya kısa public slug: tenant'ın delivery policy'sine göre
- Asset event endpoint'i: view ve CTA event'leri CRM'e aktarır

Production report sayfası `r2.dev` üzerinden sunulmamalıdır. R2 custom domain veya Worker custom domain kullanılmalıdır. Private/gated raporlarda Worker authorization katmanı kullanılmalı; presigned URL yalnız sınırlı download/upload işlemleri için tercih edilmelidir.

## 9.6 Siteye gömme

Üç mod:

1. **Hosted report:** Tam sayfa kişisel URL
2. **Inline embed:** Tenant landing page içinde responsive iframe/component
3. **Reveal flow:** Form tamamlandıktan sonra aynı sayfada report preview + email gönderimi + booking CTA

Embed protokolü:

- Parent domain allowlist
- Responsive height mesajlaşması
- Theme token'ları
- CTA callback
- Booking embed handoff
- View/scroll/CTA analytics

---

## 10. Multichannel automation runtime

## 10.1 Event-driven çekirdek

Automation yalnız dakika başı tablo tarayan scheduler olmamalıdır. İki mekanizma birlikte kullanılır:

- **Event trigger:** lead.captured, asset.ready, message.replied, booking.created, meeting.ended
- **Scheduled wake-up:** wait node, reminder veya gecikmiş retry

Önerilen akış:

```text
Business write
→ outbox event
→ automation worker claim
→ matching automation versions
→ run/action ledger
→ provider adapter
→ provider webhook
→ normalized domain event
→ branch/stop evaluation
```

## 10.2 Domain event kataloğu

### Lead

- `lead.captured`
- `lead.identity_resolved`
- `lead.enriched`
- `lead.qualified`
- `lead.disqualified`
- `lead.owner_assigned`
- `lead.lifecycle_changed`

### Asset

- `asset.requested`
- `asset.generated`
- `asset.approved`
- `asset.published`
- `asset.viewed`
- `asset.cta_clicked`

### Messaging

- `message.scheduled`
- `message.sent`
- `message.delivered`
- `message.read`
- `message.clicked`
- `message.replied`
- `message.failed`
- `message.opted_out`

### Booking

- `booking.requested`
- `booking.created`
- `booking.rescheduled`
- `booking.cancelled`
- `booking.no_show`
- `meeting.started`
- `meeting.ended`

### Meeting intelligence

- `meeting.bot_scheduled`
- `meeting.recording_ready`
- `meeting.transcript_ready`
- `meeting.summary_ready`
- `meeting.actions_approved`

### Revenue

- `deal.created`
- `deal.stage_changed`
- `deal.won`
- `deal.lost`

## 10.3 Automation versioning

- Active run başladığı version ile devam eder.
- Draft değişikliği aktif run'ı sessizce değiştirmez.
- Publish yeni immutable version üretir.
- Kullanıcı yeni version'a mevcut run'ları migrate etmeyi açıkça seçebilir.

## 10.4 Retry ve idempotency ürün davranışı

- Aynı action aynı idempotency key ile ikinci kez mesaj göndermez.
- Provider timeout “başarısız” değil önce “durumu bilinmiyor” olur.
- Delivery webhook action kaydını günceller.
- Kullanıcı run timeline'ında retry ve stop nedenini görür.
- Manuel “yeniden dene” yalnız güvenli action'larda sunulur.

## 10.5 Context assembly node'u

Kişiselleştirilmiş mesaj aksiyonlarından önce runtime standart bir context assembly çalıştırır:

1. Lead/company/contact kimliği ve lifecycle
2. Form cevapları ve acquisition source
3. Website enrichment ve qualification evidence
4. Son conversation turn'leri
5. Conversation memory facts
6. Son meeting özeti ve action item'ları
7. Açık task/commitment'lar
8. Görüntülenen report bölümleri ve CTA davranışı
9. Gönderilecek mesajın amacı ve kanal sınırları

Context bütçesi dolduğunda ham geçmiş rastgele kesilmez. Öncelik sırası:

- Son inbound mesaj ve cevaplanmamış sorular
- Açık commitment ve itirazlar
- Son meeting özeti
- Son meaningful conversation turn'leri
- Stable company/lead facts
- Eski kapatılmış konular

Lead'in kendi mesajları ve meeting transcript'i kaynak veridir; automation talimatı olarak yorumlanmaz. Message generator yalnız onaylı recipe ve goal instruction'larını takip eder.

---

## 11. Channel adapter'ları

## 11.1 Email

Mevcut mail router korunur:

- SMTP/Gmail/Nango bağlantıları
- Sender rotation
- Sending window
- Tracking token
- Open/click/bounce/reply
- Unsubscribe
- Template variables

V3 ekleri:

- Lead/asset/booking değişkenleri
- Transactional ve nurture sınıflandırması
- Conversation thread continuity
- Automation action reference
- Reply intent branch'i

### Email route ayrımı

Email gönderimi amaç bazlı route edilir:

| Amaç | Varsayılan kanal/provider |
|---|---|
| Cold outbound sequence | Mevcut mailbox/SMTP/Nango veya PlusVibe akışı |
| Pozitif reply sonrası kişisel cevap | Resend transactional |
| Kişisel report hazır bildirimi | Resend transactional |
| Booking confirmation/reminder | Resend transactional |
| Meeting recap ve materyal | Resend transactional |
| Uzun dönem pazarlama nurture | Tenant policy'ye göre campaign mailbox veya ayrı marketing provider |

Resend mesajlarında:

- Tenant/brand verified sending domain
- Gerçek owner veya conversation mailbox için `reply_to`
- Lead/conversation/message reference headers
- Delivery/open/click/bounce/complaint webhooks
- Automation action idempotency key
- Kişisel context snapshot reference

bulunur.

Pozitif lead mesajları yalnız template değişkenleriyle doldurulmaz. Draft şu bağlamdan üretilir:

- Lead'in son cevabı
- Önceki cevap dizisi
- Önceki toplantı özetleri
- İtiraz ve hedef memory facts
- Report/asset engagement
- Açık commitment ve next action

İlk sürümde bu mesajlar owner approval gerektirebilir. Onaylanan ve düzenlenen mesaj farkı personalization kalitesini ölçmek için saklanır.

### Resend inbound seçeneği

Resend custom receiving subdomain ve `email.received` webhook'u, transactional mesajlara gelen cevapları Tibexa conversation'a geri almak için kullanılabilir. Mevcut ana mailbox MX kayıtları etkilenmeden ayrı bir subdomain önerilir. Webhook yalnız metadata taşıdığında full body/header/attachment Receiving API ile çekilir ve canonical message pipeline'a verilir.

## 11.2 WhatsApp

İlk adapter önerisi: mevcut Twilio operasyon modelini kullanarak Twilio Programmable Messaging/WhatsApp. Provider interface, daha sonra Meta Cloud API direct adapter'a izin vermelidir.

Gerekli ürün kavramları:

- Approved template registry
- Template language/category/version
- Template approval state
- 24 saatlik customer-service window state
- Free-form vs template send kararı
- Inbound webhook ve conversation state
- Delivery/read/reply event'leri
- Media: report preview, PDF veya link
- Opt-in source ve timestamp

## 11.3 SMS

- Twilio Messaging Service adapter
- Tenant/sender pool mapping
- Delivery status callback
- Inbound reply webhook
- STOP/opt-out state
- Locale/timezone send window
- Link shortener/asset URL
- Segment uzunluğu ve maliyet görünürlüğü

## 11.4 Kanal seçimi

Automation node şu sırayı kullanabilir:

1. Lead'in preferred channel'ı
2. Geçerli consent ve ulaşılabilirlik
3. Tenant channel policy
4. Previous delivery/reply performance
5. Fallback channel

Kullanıcı aynı mesajı bütün kanallardan aynı anda gönderen varsayılanlara zorlanmamalıdır. Cross-channel frequency cap bulunmalıdır.

---

## 12. Cal.com booking entegrasyonu

## 12.1 Sabit karar: Railway'de self-host Cal.com/Cal.diy

Scheduling engine sıfırdan yazılmaz. Açık kaynak Cal.com community dağıtımı ayrı bir Railway projesi veya açıkça ayrılmış servis grubu olarak çalıştırılır. Tibexa booking lifecycle, CRM deneyimi, round-robin kararı ve automation'ı sahiplenir.

Önemli ürün sınırı: Cal.diy community edition; Teams, Organizations, Workflows, SSO/SAML ve bazı enterprise yeteneklerini içermez. Bu nedenle:

- Tibexa tenant/team/owner sistem-of-record olmaya devam eder.
- Round-robin veya owner seçimi Tibexa'da yapılır.
- Cal tarafında host başına user/event type mapping tutulur.
- Cal Workflows kullanılmaz; reminder/show-up automation Tibexa'da çalışır.
- Cal database'i TG-Core/Supabase veritabanıyla birleştirilmez.
- Booking state yalnız webhook/API adapter üzerinden CRM'e normalize edilir.

### Railway servisleri

```text
cal-web        → pinned Cal.diy Docker image veya kontrollü fork
cal-postgres   → Railway managed PostgreSQL
cal-redis      → image/version gerektiriyorsa Railway Redis
cal-domain     → calendar.<product-domain>
```

Deployment kuralları:

- Exact image/release pin; `latest` kullanılmaz.
- Cal schema migration deploy adımında kontrollü çalışır.
- `DATABASE_URL`, `NEXT_PUBLIC_WEBAPP_URL`, `NEXTAUTH_URL`, `NEXTAUTH_SECRET` ve encryption key Railway variables/secrets olarak yönetilir.
- Build-time ve runtime public URL değerleri aynı tutulur.
- Upgrade önce staging Cal instance + booking/webhook smoke, sonra production.
- Tibexa ↔ Cal bağlantısı provider adapter'dan geçer; Cal tablolarına doğrudan query yapılmaz.
- Cal servisinin kendi health, booking create, reschedule, cancel ve webhook smoke kontrolleri bulunur.

Community edition'ın production desteği sınırlı olduğundan controlled fork, pinned release ve upgrade runbook v3'ün zorunlu operasyon teslimidir.

Provider abstraction:

- Create/manage booking link
- Resolve event type per owner/team
- Embed config
- Fetch booking
- Cancel/reschedule
- Normalize webhook

## 12.2 Booking deneyimi

- Report CTA doğrudan kişiselleştirilmiş booking sayfasını açar.
- Lead/contact/company metadata booking'e taşınır.
- Formda daha önce cevaplanan sorular tekrar sorulmaz.
- Owner varsa owner event type; yoksa round-robin/team event type kullanılır.
- Booking tamamlanınca report sayfası confirmation state'e geçer.
- CRM'de booking activity, booking kaydı ve meeting task'ları oluşur.

## 12.3 Webhook event'leri

En az:

- BOOKING_CREATED
- BOOKING_RESCHEDULED
- BOOKING_CANCELLED
- BOOKING_REQUESTED/REJECTED gerekiyorsa
- MEETING_STARTED
- MEETING_ENDED
- BOOKING_NO_SHOW_UPDATED
- RECORDING_READY Cal Video kullanılırsa

Reschedule lineage korunur. Eski booking'e bağlı pending reminder action'ları iptal edilir, yeni zamana göre yeniden planlanır.

## 12.4 Booking form answers

- Raw answers booking snapshot'ında kalır.
- Qualification için seçilen cevaplar lead'e promote edilir.
- Meeting preparation brief'e dahil edilir.
- Hassas olmayan gerekli context host'a önceden gösterilir.

---

## 13. Booked → show-up automation

## 13.1 Varsayılan sequence

Tenant tarafından düzenlenebilir örnek:

| Zaman | Kanal | Amaç |
|---|---|---|
| Booking anı | Email + uygun ise WhatsApp | Confirmation, calendar/join bilgisi, hazırlık materyali |
| T-24 saat | Email veya WhatsApp | Değer hatırlatma, kısa agenda, reschedule linki |
| T-2 saat | SMS/WhatsApp | Kısa reminder, join linki |
| T-15 dakika | Opsiyonel SMS | Son reminder |
| T+10 dakika no join | WhatsApp/SMS | Yardım veya reschedule seçeneği |

Cross-channel cap ve kanal tercihi uygulanır; her tenant bütün adımları kullanmak zorunda değildir.

## 13.2 İkna artırma içeriği

- Meeting'de ne elde edeceği
- Kişiye özel report'tan en önemli bulgu
- Social proof/case study
- Hazırlaması gereken veri
- Agenda
- Host tanıtımı
- Kolay reschedule/cancel

## 13.3 Stop ve reschedule

- Booking cancelled: bütün show-up action'ları stop
- Rescheduled: eski action'lar cancel, yeni zamana göre recreate
- Lead reply: conversation owner'a düşer; otomasyon policy'ye göre pause
- Meeting started/attended: reminder stop
- No-show: no-show recovery automation başlar

## 13.4 No-show recovery

- Empatik tek mesaj
- Tek tık reschedule
- Report linki
- Owner task
- Belirli deneme sonrası long-term nurture veya kapatma

---

## 14. Meeting notetaker ve intelligence

## 14.1 Provider stratejisi

İlk aday: Recall.ai Meeting Bot API. Nedenleri:

- Google Meet, Zoom ve Teams gibi farklı platformlarda tek adapter
- Planlı bot oluşturma
- Recording, transcript, participant ve metadata
- Calendar integration seçeneği
- White-label bot davranışı

`MeetingCaptureProvider` arayüzü tanımlanır. Alternatif adapter'lar:

- Cal Video recording/transcript
- Zoom native cloud recording
- Google Meet native artifacts
- Microsoft Teams/Graph
- Gelecekte desktop recorder

## 14.2 Bot scheduling

- `booking.created` meeting URL içeriyorsa bot schedule edilir.
- Bot join zamanı ve provider state meeting kaydına yazılır.
- Booking reschedule bot schedule'ını günceller.
- Booking cancel botu iptal eder.
- Tenant, owner veya event type bazında notetaker aç/kapatılabilir.

## 14.3 Meeting consent deneyimi

- Booking/confirmation içeriğinde recording disclosure
- Bot görünen adı tenant tarafından yapılandırılır.
- Host meeting öncesi bot durumunu görür.
- Gerektiğinde “botu bu meeting'e gönderme” kontrolü vardır.
- Recording/transcript availability CRM'de açıkça görünür.

## 14.4 Transcript processing

```text
Provider transcript webhook
→ raw transcript artifact
→ speaker normalization
→ structured meeting analysis
→ factual quote/evidence references
→ summary preview
→ task/material/message önerileri
→ approval policy
→ CRM timeline + automation event
```

## 14.5 Structured meeting output

- Executive summary
- Lead goals
- Pain points
- Current process
- Decision criteria
- Timeline
- Budget signal
- Stakeholders
- Objections
- Competitors/alternatives
- Commitments: bizim ve lead'in
- Open questions
- Buying signals
- Risk flags
- Suggested deal stage
- Suggested next task
- Recommended materials
- Follow-up message draft

LLM çıktısı transcript evidence segment'lerine referans vermelidir. Stage değişikliği ilk aşamada öneri olarak sunulur; otomatik stage update tenant policy ile daha sonra açılır.

---

## 15. Toplantı sonrası otomasyon

## 15.1 Immediate post-meeting

- Meeting ended event'i
- Transcript/summary processing
- Owner review notification
- Meeting note timeline kaydı
- Action item → task önerileri
- Lead/customer için recap draft
- Uygun materyal seçimi

## 15.2 Materyal seçimi

- Meeting'de geçen ürün/hizmet
- İtirazlar
- Sektör ve company profile
- Funnel aşaması
- Daha önce görüntülenen asset'ler
- Tenant content library

Materyal tipleri:

- Case study
- Product sheet
- Teklif/proposal
- Calculator sonucu
- İlgili report bölümü
- Demo videosu
- FAQ/objection response

## 15.3 Post-meeting sequence örneği

| Zaman | Aksiyon |
|---|---|
| Summary hazır | Owner review veya otomatik approval policy |
| T+15 dakika | Email recap + materyaller + karşılıklı aksiyonlar |
| T+1 gün | WhatsApp kısa recap/tek ana aksiyon |
| T+3 gün | Açık commitment reminder |
| T+7 gün | Yanıt yoksa değer odaklı follow-up |
| Due date | CRM task ve owner alert |

Lead reply veya deal stage değişimi sequence'i yeniden değerlendirir.

## 15.4 Meeting → conversation memory

Yeni meeting summary eski bağlamı körlemesine ezmez:

1. Transcript'ten structured facts çıkarılır.
2. Mevcut memory facts ile aynı/çelişkili/yeni olarak karşılaştırılır.
3. Yeni açık commitments ve objections işaretlenir.
4. Çelişen fact eski kaydı `superseded` yapar; geçmiş silinmez.
5. Human edit/pin varsa otomatik özet onu ezemez.
6. Conversation memory yeniden derlenir.
7. Post-meeting mesaj context snapshot'ı bu version'a bağlanır.

Örnek:

- İlk email: “Bu çeyrekte bütçe yok.”
- Meeting: “Bütçe ağustosta açılacak.”
- Yeni context: Bütçe şu anda kapalı, ağustos için follow-up commitment var.
- Sonraki mesaj: Genel satış mesajı yerine ağustos commitment'ına referans verir.

---

## 16. Ana kullanıcı yüzeyleri

## 16.1 Lead Inbox

Yeni yakalanan ve attention isteyen leadlerin operasyon kuyruğu:

- New/unprocessed
- Identity review
- Qualification review
- Asset approval
- Reply received
- Booking attention
- No-show
- Meeting summary review
- Automation error

Her satırda source, age, company/contact, score, owner, current automation ve next action bulunur.

## 16.2 Lead detail

Firma/contact detail'in üzerinde lead intent bağlamı:

- Source ve attribution
- Form answers
- Qualification evidence
- Generated asset
- Automation state
- Conversation
- Booking/meeting
- Deal handoff
- Timeline

## 16.3 Automation Studio

- Trigger ve goal
- Görsel node akışı
- Entry/stop conditions
- Channel content editor
- Template preview
- Test lead ile dry-run
- Version publish
- Active run listesi
- Failure/paused queue

## 16.4 Asset Studio

- Recipe library
- Tenant branding
- Structured section editor
- Lead preview
- Approval queue
- Published asset analytics
- CTA/booking config

## 16.5 Conversations Inbox

- Email, WhatsApp ve SMS thread'leri
- Waiting us / waiting lead
- Owner assign
- Automation pause/resume
- Quick reply/template
- Lead/company context
- Report/booking/meeting context

## 16.6 Booking Center

- Upcoming
- Rescheduled/cancelled
- No-show risk
- Reminder delivery state
- Notetaker scheduled state
- Host/owner
- Meeting preparation brief

## 16.7 Meeting Workspace

- Recording/transcript
- Structured summary
- Action item approval
- Suggested stage/task
- Follow-up draft
- Recommended materials
- Automation start/stop controls

---

## 17. Harici servis ve entegrasyon planı

| Yetkinlik | İlk tercih | Tibexa'nın sahip olacağı katman | Karar kapısı |
|---|---|---|---|
| Booking | Railway self-host Cal.diy | Controlled fork/release, booking records, webhook normalization, CRM UX, sequences | Upgrade/support ve eksik enterprise özellikleri |
| Asset storage | Cloudflare R2 | Asset schema, rendering, access policy, analytics | Public vs gated report modeli |
| Asset delivery | Cloudflare Worker custom domain | URL, token, embed, tracking | Tek domain vs tenant custom domains |
| Email | Mevcut mail router + Resend transactional | Context-aware draft, template, automation, thread, tracking | Tenant domain/reply routing |
| SMS | Twilio Messaging Service | Consent, sequence, message ledger, inbox | Ülke kapsamı ve sender türleri |
| WhatsApp | Twilio WhatsApp adapter | Template registry, 24h window, conversation, analytics | Twilio vs Meta direct |
| Meeting capture | Recall.ai adapter | Meeting state, artifacts, analysis, CRM experience | Bot maliyeti vs native provider artifacts |
| LLM | Mevcut research LLM router | Recipe/prompt/schema/version/metering | Model per use-case |
| PDF render | Headless render service | Template ve artifact lifecycle | Worker/browser render seçimi |

### 17.1 Provider abstraction kuralları

- Provider ID hiçbir zaman core lifecycle state'in kendisi olmaz.
- Provider payload immutable raw event olarak saklanır.
- Adapter normalized domain event üretir.
- Automation node provider değil capability seçer.
- Tenant provider seçimi configuration ile yapılır.
- Delivery/retry state provider webhook ile reconcile edilir.

---

## 18. Servis ve worker topolojisi

## 18.1 Mevcut servisler

- Core API: CRM ve auth
- Research API/worker: website research ve LLM jobs
- Campaign scheduler: email enrollment tick
- LinkedIn worker jobs

## 18.2 V3 önerilen servis sınırı

### Core API

- Lead/CRM read-write API
- Automation editor API
- Provider connect/config endpoints
- UI-facing queries

### Automation Worker

- Outbox event claim
- Automation run/node execution
- Scheduled wake-ups
- Channel action dispatch
- Retry/reconciliation

### Content Worker

- Website context aggregation
- Report generation
- HTML/PDF render
- Meeting summary/material generation

İlk aşamada Automation Worker ve mevcut Research Worker aynı deployment içinde farklı job type olarak başlayabilir. Mesaj hacmi ve deploy bağımsızlığı ihtiyacı doğrulanınca ayrılır.

### Cloudflare Report Worker

- Report GET delivery
- Token/access policy
- Embed headers/protocol
- View/CTA event forwarding
- R2 binding

### Self-host Cal service group

- Railway isolated project/service group
- Cal.diy web image or controlled fork
- Dedicated Railway PostgreSQL
- Required Redis only when selected release/config requires it
- Public custom domain
- Upgrade/migration job
- Tibexa-facing API/webhook adapter

### Webhook Gateway

İlk aşamada Core API route'ları olabilir; normalized event/outbox sınırı zorunludur:

- Google lead forms
- Meta lead ads
- Cal.com
- Twilio Messaging
- Recall.ai
- Existing PlusVibe

---

## 19. Faz planı

## Phase 0 — V2 operational core

**Amaç:** V3 event'lerinin bağlanacağı güvenilir CRM çekirdeği.

- Task/next action tamamla
- Ownership
- Unified timeline
- Deal karar kapısı
- Stage transition tekleştirme
- Channel preference/consent görünümü başlangıcı

**Çıkış kriteri:** Her lead'in owner, lifecycle, next action ve timeline bağlanabileceği CRM entity'leri hazırdır.

## Phase 1 — Lead entity ve generic inbound intake

**Amaç:** Her kaynaktan gelen intent'i kaybetmeden CRM'e almak.

- Leads, sources, forms, submissions, touchpoints
- Generic form endpoint ve JS embed
- Normalize/match/create pipeline
- Lead Inbox MVP
- Source → default owner/automation mapping
- Test submission flow

**Kabul kriterleri:**

- Form gönderimi saniyeler içinde lead/contact/company oluşturur veya eşler.
- Duplicate provider event ikinci lead üretmez.
- Raw form cevapları ve attribution korunur.
- Belirsiz identity review kuyruğuna düşer.

## Phase 2 — Google/YouTube, Meta ve cold-email intake

**Amaç:** Birincil acquisition kaynaklarını production adapter'larıyla bağlamak.

- Google Lead Form Webhook
- YouTube/video attribution
- Meta Lead Ads adapter
- PlusVibe reply → lead intent
- Source health ve event log UI
- Per-form field mapping

**Kabul kriterleri:**

- Provider test lead'i production lead'den ayrılır.
- Campaign/ad/form attribution CRM'de görünür.
- Her connector son başarılı event ve hata durumunu gösterir.

## Phase 3 — Website enrichment ve qualification

**Amaç:** Form bilgisini şirket gerçekleriyle birleştirmek.

- Async website profile crawl
- Lead enrichment run
- Qualification recipe
- Evidence/reason codes
- Review queue
- Owner/automation/asset recipe suggestion

**Kabul kriterleri:**

- Intake website crawl beklemez.
- Qualification sonucu kanıtlarıyla gösterilir.
- Düşük-confidence sonuç otomatik outbound başlatmaz.

## Phase 4 — Personalized asset engine + Cloudflare

**Amaç:** Lead'e özel değeri ilk temasın merkezine almak.

- Asset recipes
- Structured generation
- HTML theme renderer
- PDF opsiyonu
- Preview/approval
- R2 storage
- Report Worker/custom domain
- View/CTA/booking analytics
- Site embed

**Kabul kriterleri:**

- Approved asset kişisel URL'de yayınlanır.
- Report gönderilmeden önce preview edilebilir.
- View ve CTA event'i lead timeline ve automation'a ulaşır.
- Aynı recipe/version yeniden üretilebilir ve audit edilebilir.

## Phase 5 — Automation runtime + email

**Amaç:** Kanal-bağımsız state machine'i kurup ilk adapter olarak email'i bağlamak.

- Events/outbox
- Automations/nodes/versions/runs/actions
- Wait/condition/stop/goal
- Email adapter
- Resend transactional adapter
- Conversation memory/context snapshot foundation
- Resend delivery webhook normalization
- Pozitif reply → context-aware draft/approval flow
- Dry-run/test lead
- Run inspector
- Legacy campaign bridge

**Kabul kriterleri:**

- Aynı action retry'da duplicate email göndermez.
- Reply/booked/unsubscribe run'ı doğru nedenle durdurur.
- Kullanıcı run'ın hangi node'da neden beklediğini görür.
- Kullanıcı mesajın hangi geçmiş cevap/meeting fact'lerinden üretildiğini görebilir.

## Phase 6 — WhatsApp + SMS

**Amaç:** Consent ve conversation state ile multichannel nurture.

- Twilio Messaging Service provisioning
- SMS adapter/webhooks
- WhatsApp adapter/webhooks
- Template registry/approval state
- 24h window state
- Unified message ledger
- Conversations Inbox MVP
- Cross-channel cap

**Kabul kriterleri:**

- Free-form/template ayrımı otomatik ve görünürdür.
- Delivered/read/reply event'leri normalize edilir.
- Opt-out pending action'ları durdurur.
- Kullanıcı conversation'ı devralıp automation'ı pause edebilir.

## Phase 7 — Cal.com booking

**Amaç:** Railway self-host Cal.diy'ı nurture goal'ü ve booking lifecycle'a bağlamak.

- Cal.diy controlled fork/image ve Railway deployment
- Dedicated Cal PostgreSQL ve custom domain
- Cal adapter connect/config
- Event type/owner mapping
- Report/landing embed
- Booking webhook normalization
- Booking Center MVP
- Reschedule/cancel handling
- Lifecycle/stage/task updates

**Kabul kriterleri:**

- Booking created pre-booking nurture'ı durdurur.
- Reschedule eski reminder'ları iptal eder.
- Booking CRM lead/contact/company ile deterministik eşleşir.
- Cal upgrade staging smoke tamamlanmadan production image değişmez.

## Phase 8 — Show-up ve no-show automation

**Amaç:** Booked → attended oranını artırmak.

- Confirmation sequence
- T-24/T-2/T-15 configurable reminders
- Personalized prep content
- No-show detection/recovery
- Delivery dashboard
- Host preparation brief

**Kabul kriterleri:**

- Cancelled meeting reminder almaz.
- Kullanıcı her booking'in reminder durumunu görür.
- No-show otomatik recovery flow'a geçer.

## Phase 9 — Meeting notetaker ve intelligence

**Amaç:** Meeting bilgisini CRM aksiyonuna dönüştürmek.

- Recall.ai provider adapter
- Bot schedule/cancel/reschedule
- Transcript/recording artifacts
- Structured meeting analysis
- Meeting Workspace
- Task/stage/material suggestions
- Approval policy

**Kabul kriterleri:**

- Bot booking lifecycle ile senkron kalır.
- Transcript speaker'lı ve meeting'e bağlıdır.
- Summary transcript evidence ile doğrulanabilir.
- Action item task'a dönüştürülebilir.

## Phase 10 — Post-meeting automation

**Amaç:** Meeting sonucu ve commitment'ları takip eden kişisel sequence.

- Recap generation
- Content library/material recommendation
- Email/WhatsApp follow-up
- Commitment reminders
- Deal handoff
- Long-term nurture branch

**Kabul kriterleri:**

- Gönderilmeden önce policy'ye göre owner review uygulanır.
- Lead reply olduğunda automated reminders durur.
- Meeting action item'ları task ve timeline'a bağlanır.

## Phase 11 — Attribution, optimization ve learning

**Amaç:** Hangi source, report ve sequence'in revenue ürettiğini ölçmek.

- Source → booked → attended → opportunity → won funnel
- Asset recipe conversion
- Message/channel/step performance
- Show-up sequence performance
- Meeting quality/outcome
- Experiment variants
- Cohort ve attribution views
- Cost/margin metering

**Kabul kriterleri:**

- Kullanıcı bir won deal'i source/touchpoint/asset/automation'a kadar izleyebilir.
- Test ve production traffic ayrıdır.
- Experiment sonucu istatistik bağlamıyla gösterilir.

---

## 20. Release planı

| Release | Fazlar | Kullanıcı sonucu |
|---|---|---|
| V3-R0 Foundation | Phase 0 | CRM automation için güvenilir entity/task/timeline |
| V3-R1 Capture | Phase 1–3 | Inbound lead otomatik CRM'e düşer, eşlenir ve qualify edilir |
| V3-R2 Personalized Conversion | Phase 4–5 | Kişisel report üretilir, yayınlanır ve email nurture çalışır |
| V3-R3 Multichannel Booking | Phase 6–8 | WhatsApp/SMS nurture, booking ve show-up otomasyonu |
| V3-R4 Meeting Intelligence | Phase 9–10 | Notetaker, summary, materyal ve post-meeting follow-up |
| V3-R5 Revenue Learning | Phase 11 | Uçtan uca attribution ve optimization |

### İlk production değer dilimi

En kısa anlamlı kapalı döngü:

```text
Generic/Google form
→ lead/company/contact
→ website enrichment
→ personalized HTML report
→ email delivery
→ report view
→ Cal.com booking
→ CRM lifecycle + owner task
```

WhatsApp/SMS ve notetaker bu çekirdek çalıştıktan sonra eklenmelidir. Böylece automation runtime gerçek funnel üzerinde doğrulanır.

---

## 21. Varsayılan automation şablonları

## 21.1 Inbound personalized report

1. `lead.captured`
2. Identity + enrichment
3. Qualification
4. Asset generate
5. Approval gerekiyorsa wait
6. Email: report hazır
7. 1 gün wait
8. Report viewed değilse kısa reminder
9. Report viewed ve booking yoksa CTA follow-up
10. 3 gün wait
11. Uygun consent varsa WhatsApp veya SMS fallback
12. Booked/replied/negative/opt-out stop

## 21.2 Cold-email positive reply

1. `message.replied` + positive intent
2. Lead intent oluştur/eşle
3. Owner assign
4. Website enrichment
5. Kişisel report veya meeting prep asset
6. Owner approval veya otomatik gönderim
7. Booking CTA
8. Reply/booked stop

## 21.3 Booking show-up

1. `booking.created`
2. Pre-booking nurture stop
3. Confirmation email
4. Uygun ise WhatsApp confirmation
5. T-24 value reminder
6. T-2 short reminder
7. T-15 optional SMS
8. Meeting started/ended stop
9. No-show ise recovery

## 21.4 Post-meeting

1. `meeting.transcript_ready`
2. Structured analysis
3. Task/material/message önerileri
4. Approval policy
5. Recap email
6. WhatsApp short follow-up
7. Commitment due wait
8. Reply/stage/deal event branch

---

## 22. Analytics ve north-star metrikleri

### North-star

**Ay içinde otomasyonla yakalanıp qualified meeting'e dönüşen ve attended olan lead sayısı**

### Acquisition

- Lead capture latency
- Source/form bazlı valid lead oranı
- Duplicate/review oranı
- Cost per captured/qualified lead

### Enrichment ve asset

- Website resolve oranı
- Enrichment success süresi
- Auto qualification oranı
- Asset generation success/süre/maliyet
- Asset view ve unique view
- CTA click rate

### Nurture

- Kanal/step delivery
- Reply rate
- Positive reply rate
- Opt-out/negative rate
- Report viewed → booked conversion
- Time to first meaningful touch

### Booking/show-up

- Booked rate
- Booking lead time
- Reschedule/cancel rate
- Show rate
- Reminder channel katkısı
- No-show recovery rate

### Meeting/revenue

- Transcript/summary success
- Summary approval/edit oranı
- Meeting → opportunity
- Opportunity → won
- Sales cycle
- Source/asset/automation influenced revenue

### Operasyon

- Automation failure/retry rate
- Human approval wait time
- Owner takeover rate
- Task completion
- Provider cost per qualified attended meeting

---

## 23. Karar kapıları

## D1 — Cal.com deployment — KARAR VERİLDİ

Railway'de self-host Cal.diy kullanılacak. Açık kalan alt kararlar:

- Upstream pinned image mi, controlled fork mu
- Cal release upgrade periyodu
- Host başına user provisioning yöntemi
- Tibexa-controlled round-robin algoritması
- Calendar/video integration credential ownership modeli

Cal community edition enterprise Teams/Workflows'a güvenilmeyecek; bu yetenekler Tibexa CRM ve automation katmanında kalacak.

## D2 — Twilio WhatsApp veya Meta direct

Başlangıç önerisi: Twilio adapter; mevcut Twilio tenant operasyonu yeniden kullanılır. Hacim/maliyet veya özellik ihtiyacı doğrulanırsa Meta direct adapter eklenir.

## D3 — Recall.ai veya native meeting artifacts

Başlangıç önerisi: provider-neutral interface üzerinde Recall.ai pilotu. Tek platform yoğunluğu veya maliyet native entegrasyonu haklı çıkarırsa Zoom/Google/Teams adapter'ı eklenir.

## D4 — Report erişim modeli

Seçenekler:

- Public unguessable slug
- Token gated
- Email verification gated
- Expiring link

Varsayılan, lead magnet için public unguessable slug; hassas assessment ve meeting materyali için Worker gated erişimdir.

## D5 — Lead ve deal ayrımı

Lead intent nesnesi v3 başlangıcında zorunludur. Deal nesnesi V2 Phase 5 karar kapısıyla birlikte production handoff öncesi netleştirilir.

## D6 — Autonomous send policy

İlk tenantlarda:

- Yeni recipe/template manual approval
- Düşük confidence manual review
- Meeting recap manual approval
- Stage update suggestion-only

Yeterli kalite ölçümü sonrası tenant bazlı otomatikleştirme açılır.

---

## 24. Riskler ve azaltma planı

| Risk | Etki | Azaltma |
|---|---|---|
| Ürün bir dizi kopuk entegrasyona dönüşür | Çok yüksek | Canonical lead, event ve automation runtime önce |
| Contact ile lead intent karışır | Yüksek | Ayrı `leads` nesnesi ve çoklu intent |
| Duplicate mesaj/booking action | Çok yüksek | Action ledger + idempotency + provider reconcile |
| Yanlış identity yanlış kişiselleştirme üretir | Çok yüksek | Confidence, review queue, raw evidence |
| LLM uydurma rapor üretir | Yüksek | Structured schema, evidence pass, approval policy |
| WhatsApp template/window akışı sonradan eklenir | Yüksek | İlk günden template registry + window state |
| Reminder cancel/reschedule sonrası devam eder | Çok yüksek | Booking lineage ve pending action cancellation |
| Meeting bot güven kaybı yaratır | Yüksek | Açık disclosure, tenant/meeting control, visible bot state |
| Pipeline otomasyon tarafından kontrolsüz ilerler | Yüksek | İlk aşamada suggestion-only, tenant policy |
| Automation builder aşırı karmaşık olur | Yüksek | İlk sürüm recipe/template tabanlı; gelişmiş graph progressive disclosure |
| Cloudflare asset public yanlış yapılandırılır | Yüksek | Delivery Worker ve explicit access mode |
| Provider lock-in | Orta | Capability adapter ve normalized events |
| Kanal maliyeti görünmez | Orta | Message/action bazlı cost ledger |

---

## 25. Definition of Done

Her v3 dilimi için:

- Canonical domain event tanımlı
- Raw provider payload ve normalized event ayrılmış
- Idempotency anahtarı tanımlı
- Retry/unknown/failure davranışı tanımlı
- Stop ve branch koşulları test edilmiş
- CRM timeline event'i görünür
- Owner/attention queue sonucu tanımlı
- Empty/loading/error/paused UI durumları mevcut
- Türkçe ve İngilizce içerik tamamlanmış
- Test lead/dry-run yolu mevcut
- Provider webhook test fixture'ları mevcut
- API ve worker testleri başarılı
- Client/server build başarılı
- Funnel analytics event'leri mevcut
- Plan implementation log güncellenmiş

---

## 26. Önerilen kod organizasyonu

```text
server/src/routes/leads/
server/src/routes/automations/
server/src/routes/assets/
server/src/routes/bookings/
server/src/routes/meetings/
server/src/routes/conversations/
server/src/routes/webhooks/google-leads.ts
server/src/routes/webhooks/meta-leads.ts
server/src/routes/webhooks/calcom.ts
server/src/routes/webhooks/twilio-messaging.ts
server/src/routes/webhooks/recall.ts

server/src/lib/leads/identity.ts
server/src/lib/leads/intake.ts
server/src/lib/leads/qualification.ts
server/src/lib/automation/events.ts
server/src/lib/automation/outbox.ts
server/src/lib/automation/runtime.ts
server/src/lib/automation/nodes/
server/src/lib/channels/email.ts
server/src/lib/channels/resend.ts
server/src/lib/channels/sms.ts
server/src/lib/channels/whatsapp.ts
server/src/lib/assets/generator.ts
server/src/lib/assets/renderer.ts
server/src/lib/bookings/providers/calcom.ts
server/src/lib/meetings/providers/recall.ts
server/src/lib/meetings/analyze.ts
server/src/lib/context/memory.ts
server/src/lib/context/assemble.ts
server/src/lib/context/snapshots.ts

client/src/pages/LeadInboxPage.tsx
client/src/pages/LeadDetailPage.tsx
client/src/pages/AutomationsPage.tsx
client/src/pages/AutomationEditorPage.tsx
client/src/pages/AssetsPage.tsx
client/src/pages/ConversationsPage.tsx
client/src/pages/BookingsPage.tsx
client/src/pages/MeetingWorkspacePage.tsx
```

Cloudflare delivery kodu ayrı deploy sınırında:

```text
report-worker/
├── src/index.ts
├── src/access.ts
├── src/events.ts
├── src/embed.ts
└── wrangler.toml
```

Self-host calendar deploy sınırı:

```text
deploy/cal/
├── Dockerfile veya pinned-image config
├── railway.json
├── env.example
├── migrations-runbook.md
├── upgrade-runbook.md
└── smoke/
```

---

## 27. Uygulama başlangıç sırası

İlk dört bounded work package:

### WP1 — Lead foundation

- Lead/source/form/submission/touchpoint migrations
- Generic form intake
- Identity resolver
- Lead Inbox minimal read model

### WP2 — Enrichment bridge

- CRM lead → website profile crawl job
- Enrichment run/read model
- Qualification recipe MVP
- Review queue

### WP3 — Asset foundation

- Asset recipe/generated asset/event migrations
- Structured report generator
- HTML renderer
- R2 upload adapter
- Preview/publish API

### WP4 — Conversion loop

- Cloudflare Report Worker
- Report view/CTA events
- Email asset delivery
- Railway self-host Cal.diy deployment + booking embed/webhook
- Resend transactional delivery/reply routing
- Conversation memory/context snapshot MVP
- Lead lifecycle ve task updates

WP4 sonunda ilk v3 production funnel uçtan uca ölçülebilir olur. Automation Studio, WhatsApp/SMS ve notetaker bu temel üzerinde ilerler.

---

## 28. Resmi entegrasyon referansları

- Cal.com webhooks: https://cal.com/docs/developing/guides/automation/webhooks
- Cal.com API v2 webhooks: https://cal.com/docs/api-reference/v2/webhooks/get-a-webhook
- Cloudflare R2 presigned URLs: https://developers.cloudflare.com/r2/api/s3/presigned-urls/
- Cloudflare R2 public/custom domains: https://developers.cloudflare.com/r2/buckets/public-buckets/
- Cloudflare Workers custom domains: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- Cloudflare Workers R2 API: https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
- Google Ads Lead Form Webhook: https://developers.google.com/google-ads/webhook/docs/implementation
- Twilio messaging webhooks/status callbacks: https://www.twilio.com/docs/usage/webhooks/messaging-webhooks
- Twilio WhatsApp API: https://www.twilio.com/docs/whatsapp/api
- Twilio WhatsApp template approvals: https://www.twilio.com/docs/whatsapp/tutorial/message-template-approvals-statuses
- Recall.ai bot overview: https://docs.recall.ai/docs/bot-overview
- Recall.ai Create Bot: https://docs.recall.ai/reference/bot_create
- Cal.diy self-host repository: https://github.com/calcom/cal.com
- Railway Docker Compose mapping: https://docs.railway.com/guides/docker-compose
- Railway Dockerfile deployment: https://docs.railway.com/builds/dockerfiles
- Resend send email API: https://resend.com/docs/api-reference/emails/send-email
- Resend inbound email: https://resend.com/docs/dashboard/receiving/introduction
- Resend webhook events: https://resend.com/docs/webhooks/event-types

---

## 29. Planlama kaydı

### 2026-07-10 — V3 kapsamı oluşturuldu

- V2 CRM çekirdeği korunarak v3 ayrı product layer olarak tanımlandı.
- Lead intent, form submission, attribution, asset, automation, conversation, booking ve meeting nesneleri ayrıştırıldı.
- Cal.com, Cloudflare R2/Workers, Twilio Messaging/WhatsApp ve Recall.ai provider adapter sınırları tanımlandı.
- Mevcut email, reply, research, cold-call, task ve timeline parçalarının yeniden kullanım haritası çıkarıldı.
- İlk production değer dilimi generic/Google form → enrichment → report → email → Cal.com booking olarak belirlendi.
- Cal.com managed önerisi kaldırıldı; Railway self-host Cal.diy sabit ürün kararı olarak işlendi.
- Pozitif lead, report, booking ve meeting lifecycle emailleri için Resend transactional route'u eklendi.
- Geçmiş cevaplar ve meeting özetlerinden sürümlenmiş conversation memory/context snapshot modeli eklendi.
- Bu belge planlama teslimidir; v3 kod uygulaması henüz başlatılmamıştır.
