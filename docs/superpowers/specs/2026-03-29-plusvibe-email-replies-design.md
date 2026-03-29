# PlusVibe Email Yanıtları Entegrasyonu — Tasarım Dokümanı

**Tarih:** 2026-03-29
**Durum:** Onaylandı

## Amaç

PlusVibe üzerinden gönderilen email kampanyalarına gelen yanıtları (replied event) webhook ile alıp LeadHub içinde görüntülemek, company/contact ile eşleştirmek ve pipeline stage güncellemesi yapabilmek.

## Scope

### Dahil
- PlusVibe webhook entegrasyonu (sadece `replied` event)
- `email_replies` tablosu (AI-ready: category + confidence kolonları)
- Webhook endpoint (secret key doğrulamalı, public)
- Email Yanıtları sayfası (istatistikler, filtreler, tablo)
- Yanıt detay modal (içerik, okundu işaretleme)
- Manuel stage güncelleme (detaydan dropdown ile)
- Eşleşmemiş yanıtları manuel company/contact'a atama

### Scope Dışı (Gelecek Planlar bölümünde detaylandırılmıştır)
- AI segmentasyon (otomatik kategori + stage eşleme)
- AI email taslağı oluşturma ve gönderme
- Diğer PlusVibe event'leri (opened, clicked, bounce)

## Veri Modeli

### `email_replies` tablosu

| Kolon | Tip | Açıklama |
|---|---|---|
| `id` | uuid PK | Default: `gen_random_uuid()` |
| `tenant_id` | uuid FK NOT NULL | `tenants.id` — çok kiracılık |
| `campaign_name` | text | PlusVibe kampanya adı |
| `campaign_id` | text | PlusVibe kampanya ID |
| `sender_email` | text NOT NULL | Yanıtlayan email adresi |
| `reply_body` | text | Yanıt içeriği |
| `replied_at` | timestamptz | Yanıtın geldiği zaman |
| `company_id` | uuid FK nullable | `companies.id` — eşleşen şirket |
| `contact_id` | uuid FK nullable | `contacts.id` — eşleşen kişi |
| `match_status` | text NOT NULL DEFAULT 'unmatched' | `'matched'` / `'unmatched'` |
| `read_status` | text NOT NULL DEFAULT 'unread' | `'unread'` / `'read'` |
| `category` | text nullable | AI segmentasyon için: `'positive'` / `'negative'` / `'meeting_request'` / `'waiting_response'` / `'not_interested'` / `'other'` |
| `category_confidence` | float nullable | AI güven skoru (0-1) |
| `raw_payload` | jsonb | Webhook'un tam payload'u |
| `created_at` | timestamptz DEFAULT now() | |
| `updated_at` | timestamptz DEFAULT now() | Trigger: `update_updated_at()` |

**Foreign Key Davranışları:**
- `tenant_id` → `ON DELETE CASCADE`
- `company_id` → `ON DELETE SET NULL` (şirket silinirse yanıt kalır, eşleşme kaybolur)
- `contact_id` → `ON DELETE SET NULL` (kişi silinirse yanıt kalır, eşleşme kaybolur)

**CHECK Constraints:**
- `match_status IN ('matched', 'unmatched')`
- `read_status IN ('unread', 'read')`
- `category IN ('positive', 'negative', 'meeting_request', 'waiting_response', 'not_interested', 'other')` (nullable, sadece doluysa kontrol)

**Unique Constraint (Webhook Deduplication):**
- `UNIQUE (campaign_id, sender_email, replied_at)` — aynı reply event'in tekrar kaydedilmesini önler

**İndeksler (Composite, tenant-scoped):**
- `(tenant_id, replied_at)` — tarih bazlı sorgular
- `(tenant_id, match_status)` — eşleşme durumu filtresi
- `(tenant_id, read_status)` — okunma durumu filtresi
- `(tenant_id, company_id)` — company bazlı filtreleme
- `sender_email` — webhook eşleşme lookup

**RLS Politikası:**
- SELECT: `tenant_id = get_user_tenant_id() OR is_superadmin()`
- UPDATE: `tenant_id = get_user_tenant_id() OR is_superadmin()`
- DELETE: `tenant_id = get_user_tenant_id() OR is_superadmin()`
- INSERT: `tenant_id = get_user_tenant_id() OR is_superadmin()`
- **Not:** Webhook INSERT'leri `supabaseAdmin` (service role) ile yapılır — RLS'yi bypass eder. Bu bilinçli bir tasarım kararıdır çünkü webhook'ta authenticated user context yoktur.

## Webhook Akışı

### Endpoint
`POST /api/webhooks/plusvibe` — Auth middleware dışında, kendi doğrulaması var. `server/src/index.ts`'de auth middleware'den **önce** register edilmelidir (mevcut `/api/auth` route'ları ile aynı pattern).

### Güvenlik
- `X-Webhook-Secret` header'ı ile doğrulama
- Secret, env variable olarak saklanır: `PLUSVIBE_WEBHOOK_SECRET`
- Özel rate limit: 100 istek/dakika
- Secret eşleşmezse → 401 Unauthorized

### Eşleşme Mantığı
1. `sender_email` → `contacts.email`'de ara (tüm tenant'larda, `supabaseAdmin` ile) → birden fazla sonuç varsa `is_primary = true` olan tercih edilir, yoksa `updated_at DESC` ile en güncel kayıt alınır → contact + contact'ın company'si ile eşle
2. Bulamazsa → `companies.company_email`'de ara → birden fazla sonuç varsa `updated_at DESC` ile en güncel kayıt alınır → sadece company ile eşle
3. Hiçbiri eşleşmezse → `match_status = 'unmatched'`, company_id ve contact_id null, tenant_id olarak `PLUSVIBE_DEFAULT_TENANT_ID` kullanılır

### Tenant Belirleme
Webhook payload'unda tenant bilgisi olmayacağı için, eşleşme sırasında email adresi tüm tenant'larda aranır (`supabaseAdmin` ile, RLS bypass).

**Çoklu tenant eşleşmesi durumu:** Aynı email birden fazla tenant'ta varsa, en son güncellenen kayıt (`updated_at DESC`) tercih edilir.

**Eşleşme yoksa:** Webhook ayarlarında tanımlanan default tenant_id kullanılır (env variable: `PLUSVIBE_DEFAULT_TENANT_ID`).

**Not:** Tüm tenant'larda arama yapılması güvenlik açısından dikkat gerektirir. Webhook handler sadece eşleşme için okuma yapar, sonucu ilgili tenant'a yazar. Cross-tenant veri sızıntısı olmaz çünkü dönen yanıt kaydı yalnızca eşleşen tenant'ın scope'unda oluşturulur.

### Payload İşleme
```
Beklenen PlusVibe webhook payload:
{
  "event": "replied",
  "campaign_id": "camp_123",
  "campaign_name": "Q1 Outreach",
  "recipient_email": "ahmet@acme.com",
  "reply_body": "Merhaba, ilgileniyoruz...",
  "replied_at": "2026-03-29T14:32:00Z",
  ...diğer alanlar
}
```

Tam payload `raw_payload` JSONB kolonuna kaydedilir. PlusVibe'ın gerçek payload yapısına göre mapping ayarlanır.

## API Endpoint'leri

### Webhook (Public)
| Method | Path | Açıklama |
|---|---|---|
| POST | `/api/webhooks/plusvibe` | PlusVibe reply webhook alıcı |

### Email Replies (Protected)
| Method | Path | Açıklama |
|---|---|---|
| GET | `/api/email-replies` | Sayfalı liste + filtreler |
| GET | `/api/email-replies/stats` | İstatistikler |
| GET | `/api/email-replies/campaigns` | Kampanya listesi (filtre dropdown) |
| PATCH | `/api/email-replies/:id/read` | Okundu/okunmadı toggle |
| PATCH | `/api/email-replies/:id/assign` | Manuel company/contact atama |

### Request/Response Formatları

**`PATCH /api/email-replies/:id/read`** — Toggle (body gerekmez)
- Response: `{ id, read_status }` (yeni durum)

**`PATCH /api/email-replies/:id/assign`** — Body:
```json
{
  "company_id": "uuid (zorunlu)",
  "contact_id": "uuid (opsiyonel)"
}
```
- Response: `{ id, company_id, contact_id, match_status: 'matched' }`

**`GET /api/email-replies`** — Response:
```json
{
  "data": [
    {
      "id": "uuid",
      "campaign_name": "Q1 Outreach",
      "campaign_id": "camp_123",
      "sender_email": "ahmet@acme.com",
      "reply_body": "Merhaba...",
      "replied_at": "2026-03-29T14:32:00Z",
      "company_id": "uuid",
      "company_name": "Acme Corp",
      "contact_id": "uuid",
      "contact_name": "Ahmet Yılmaz",
      "match_status": "matched",
      "read_status": "unread",
      "category": null,
      "created_at": "2026-03-29T14:32:01Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 47,
    "totalPages": 3,
    "hasNext": true,
    "hasPrev": false
  }
}
```

**Not:** `company_name` ve `contact_name` alanları JOIN ile çözümlenir (companies.name, contacts.first_name + last_name). `search` parametresi `reply_body`, `sender_email` ve JOIN üzerinden `companies.name`'de arar.

### Zod Validation Şemaları
Tüm mutating endpoint'ler için Zod şemaları tanımlanır (mevcut `server/src/lib/validation.ts` pattern'i ile tutarlı):
- `webhookPayloadSchema` — PlusVibe webhook payload doğrulama
- `assignReplySchema` — `{ company_id: z.string().uuid(), contact_id: z.string().uuid().optional() }`
- `emailRepliesQuerySchema` — GET query parametreleri doğrulama

### Query Parametreleri — `GET /api/email-replies`
- `campaign_id` — kampanyaya göre filtre
- `match_status` — `matched` / `unmatched`
- `read_status` — `read` / `unread`
- `date_from`, `date_to` — tarih aralığı
- `search` — serbest metin (reply_body, sender_email, company name — JOIN ile)
- `page`, `limit` — sayfalama

### Response — `GET /api/email-replies/stats`
```json
{
  "total": 47,
  "unread": 12,
  "matched": 38,
  "unmatched": 9
}
```

### Yetki
| Aksiyon | Roller |
|---|---|
| Görüntüleme | superadmin, ops_agent, client_admin, client_viewer |
| Okundu işaretleme | superadmin, ops_agent, client_admin |
| Manuel atama | superadmin, ops_agent, client_admin |
| Stage güncelleme | superadmin, ops_agent, client_admin |

Stage güncelleme mevcut `PUT /api/companies/:id` endpoint'i üzerinden yapılır (stage alanı güncellenir). Stage değişikliği aynı zamanda `activities` tablosuna `status_change` tipi olarak loglanır (mevcut pattern).

## UI Tasarımı

### Yeni Sayfa: Email Yanıtları (`/email-replies`)
Sol menüye yeni item olarak eklenir.

#### Layout
1. **İstatistik kartları** (üst kısım): Toplam Yanıt, Okunmamış, Eşleşmiş, Eşleşmemiş
2. **Filtre barı**: Arama input, kampanya dropdown, eşleşme durumu, okunma durumu, tarih aralığı
3. **Tablo**: Satır başına: okunmamış göstergesi, kampanya badge, gönderen email, şirket (link), kişi, yanıt önizleme (truncated), tarih

#### Tablo Davranışları
- Okunmamış satırlar: mavi arka plan + mavi nokta göstergesi
- Eşleşmemiş satırlar: şirket kolonunda kırmızı "Eşleşmemiş" badge
- Şirket adı tıklanınca → CompanyDetailPage'e yönlendirir
- Satıra tıklayınca → Yanıt detay modal açılır
- Sayfalama: load more pattern (mevcut ActivitiesPage ile tutarlı)

### Yanıt Detay Modal
Satıra tıklanınca açılan modal/drawer:

#### Eşleşmiş Yanıt
- Kampanya adı + tarih
- Gönderen email, eşleşen şirket (link), eşleşen kişi (varsa)
- Yanıt içeriği (tam metin, mavi sol border)
- **Aksiyonlar:**
  - Stage Güncelle: pipeline stage dropdown + güncelle butonu
  - Okundu/Okunmadı toggle butonu
  - AI Kategori alanı (disabled, "Yakında" placeholder)

#### Eşleşmemiş Yanıt
- Sarı uyarı banner: "Bu yanıt henüz bir şirketle eşleşmedi"
- Gönderen email
- **Manuel Atama:** Şirket arama (autocomplete) + Ata butonu, opsiyonel kişi arama
- Yanıt içeriği (turuncu sol border)

### Yeni Bileşenler
- `EmailRepliesPage` — sayfa bileşeni
- `ReplyDetailModal` — yanıt detay modal
- `AssignCompanyForm` — eşleşmemiş yanıt atama formu

### i18n
Türkçe ve İngilizce çeviri anahtarları:
```
emailReplies:
  pageTitle, stats (total, unread, matched, unmatched)
  filters (search, campaign, allCampaigns, matchStatus, readStatus, dateRange)
  table (campaign, sender, company, contact, preview, date)
  status (matched, unmatched, read, unread)
  detail (title, campaign, date, sender, company, contact, replyBody, actions)
  actions (updateStage, markRead, markUnread, assign, assignCompany, assignContact)
  assign (title, warning, searchCompany, searchContact, assignButton)
  aiCategory (title, comingSoon)
```

## Dosya Yapısı

### Server
- `server/src/routes/webhooks.ts` — Webhook endpoint
- `server/src/routes/email-replies.ts` — Email replies CRUD
- `server/src/lib/emailMatcher.ts` — Email eşleşme mantığı

### Client
- `client/src/pages/EmailRepliesPage.tsx` — Ana sayfa
- `client/src/components/email/ReplyDetailModal.tsx` — Detay modal
- `client/src/components/email/AssignCompanyForm.tsx` — Atama formu
- `client/src/types/emailReply.ts` — TypeScript tipleri

### Database
- `supabase/migrations/018_email_replies.sql` — Tablo + RLS + indeksler

### Config
- `.env`: `PLUSVIBE_WEBHOOK_SECRET`, `PLUSVIBE_DEFAULT_TENANT_ID`

---

## Gelecek Planlar

### Plan 1: AI Segmentasyon

**Amaç:** Gelen email yanıtlarını otomatik olarak kategorize etme ve pipeline stage'ini otomatik güncelleme.

**Kategoriler:**
- `positive` — Olumlu yanıt, ilgileniyor
- `negative` — Olumsuz, ilgilenmiyor
- `meeting_request` — Toplantı talep ediyor
- `waiting_response` — Geri dönüş bekliyor, henüz karar vermemiş
- `not_interested` — Açıkça reddetmiş
- `other` — Diğer (otomatik yanıt, out-of-office vb.)

**Mimari:**
1. Webhook yanıt aldığında → `reply_body`'yi Claude API'ye gönder
2. Prompt: Yanıtı kategorize et + güven skoru ver
3. `category` ve `category_confidence` kolonlarını güncelle
4. Güven skoru eşik değerin üstündeyse (ör. 0.8) → otomatik stage güncelleme

**Kategori-Stage Mapping (Admin Panelinden Yapılandırılabilir):**
| Kategori | Varsayılan Stage Aksiyonu |
|---|---|
| `positive` | → İlgileniyor |
| `meeting_request` | → Toplantı Aşaması |
| `negative` / `not_interested` | → Kaybedildi |
| `waiting_response` | → Değişiklik yok, takip gerekli işareti |
| `other` | → Değişiklik yok |

**Gerekli Yeni Bileşenler:**
- `server/src/lib/aiCategorizer.ts` — Claude API entegrasyonu, prompt yönetimi
- `server/src/routes/admin.ts`'ye ekleme — kategori-stage mapping ayarları
- `category_stage_mappings` tablosu (tenant bazlı yapılandırma)
- UI: Email sayfasında kategori filtresi, istatistik kartlarına kategori breakdown
- UI: Admin panelinde mapping konfigürasyon ekranı

**Env Variables:**
- `ANTHROPIC_API_KEY` — Claude API anahtarı
- `AI_CATEGORIZATION_ENABLED` — Feature flag (true/false)
- `AI_CONFIDENCE_THRESHOLD` — Otomatik stage güncelleme eşik değeri (default: 0.8)

### Plan 2: AI Email Taslağı Oluşturma ve Gönderme

**Amaç:** Gelen yanıtlara AI destekli cevap taslağı oluşturma, kullanıcı onayıyla gönderme.

**Akış:**
1. Kullanıcı yanıt detay modalında "Cevap Oluştur" butonuna tıklar
2. Sistem context toplar:
   - Gelen yanıt içeriği
   - Company bilgileri (ad, sektör, stage, önceki notlar)
   - Contact bilgileri (ad, pozisyon)
   - Önceki aktivite geçmişi
   - Kampanya bilgisi (ne hakkında gönderilmişti)
3. Claude API'ye context + prompt gönderilir
4. AI taslak cevap üretir
5. Kullanıcı taslağı düzenleyebilir (rich text editor)
6. "Gönder" → PlusVibe API üzerinden email gönderilir
7. Gönderim activity olarak loglanır

**Ton ve Stil Yapılandırması:**
- Admin panelinde tenant bazlı email tonu ayarı (formal/casual/friendly)
- Şablon prompt'lar tanımlanabilir (ilk temas cevabı, toplantı daveti, fiyat teklifi vb.)
- Kullanıcı taslağı her zaman düzenleyebilir — AI önerir, kullanıcı onaylar

**Gerekli Yeni Bileşenler:**
- `server/src/lib/aiEmailDrafter.ts` — Claude API ile taslak oluşturma
- `server/src/routes/emailReplies.ts`'ye ekleme — `POST /api/email-replies/:id/draft` (taslak oluştur), `POST /api/email-replies/:id/send` (gönder)
- `server/src/lib/plusvibeClient.ts` — PlusVibe API client (email gönderme)
- `client/src/components/email/DraftEditor.tsx` — Rich text taslak editörü
- `client/src/components/email/DraftPreview.tsx` — Önizleme bileşeni
- `email_drafts` tablosu — taslak geçmişi (versiyon takibi)
- `email_tone_settings` tablosu veya tenant settings'e ekleme

**PlusVibe API Entegrasyonu:**
- PlusVibe'ın email gönderme API'si kullanılır (reply-to thread)
- API key env variable: `PLUSVIBE_API_KEY`
- Rate limit: PlusVibe API limitlerini respect etme

**Güvenlik:**
- Email gönderme sadece `superadmin` ve `ops_agent` rollerine açık
- Her gönderim kullanıcı onayı gerektirir (otomatik gönderim yok)
- Gönderim audit log'a kaydedilir
