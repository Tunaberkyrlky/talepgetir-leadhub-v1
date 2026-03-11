# LeadHub CRM Expansion Plan

## Context

LeadHub şu an companies, contacts, import işlemlerini yöneten multi-tenant bir SaaS. Mevcut yapıda sadece LeadsPage (şirket listesi), ImportPage ve CompanyDetailPage var. CRM'i tam kapsamlı hale getirmek için People sayfası, Dashboard/İstatistikler, Trello-tarzı Pipeline yönetimi ve 2 katmanlı (Basic/Pro) yetki sistemi eklenmesi gerekiyor.

**Stack:** React 19 + Vite + Mantine UI v8 (frontend), Express + TypeScript + Supabase/PostgreSQL (backend)
**Mevcut stage'ler:** new → researching → contacted → meeting_scheduled → proposal_sent → negotiation → won/lost/on_hold
**Not:** Activities tablosu DB'de mevcut ama UI'da kullanılmıyor.

### Rol ve Yetki Yapısı

**İki bağımsız eksen:** Rol (kullanıcı seviyesi) + Tier (tenant/şirket seviyesi)

#### Roller (Kullanıcı Bazlı)

**Dahili Ekip:**
| Rol | Açıklama | Yetkiler |
|-----|----------|----------|
| `superadmin` | Sistem sahibi (biz) | Her şeyi görür, müşterileri yönetir, silme yapabilir, cross-tenant erişim |
| `ops_agent` | Operasyon uzmanı (bizim ekip) | Müşteriler adına veri yükler (import), düzeltir, iç notları okur/yazar. **Silme yetkisi yoktur** |

**Müşteri Tarafı:**
| Rol | Açıklama | Yetkiler |
|-----|----------|----------|
| `client_admin` | Müşteri yöneticisi | Kendi tenant verilerini görür, takım arkadaşı davet eder, **iç notları göremez** |
| `client_viewer` | Müşteri izleyicisi | Sadece okuma yetkisi, hiçbir şeyi değiştiremez, hassas bilgiler maskelenmiş |

#### Tier (Tenant/Şirket Bazlı Paket)

Tier, tenant'ın satın aldığı paketi belirler. Aynı tenant altındaki **tüm kullanıcılar** (client_admin + client_viewer) aynı tier'dan etkilenir.

| Özellik | Basic Tier | Pro Tier |
|---------|-----------|----------|
| Şirket/Kişi listesi | ✅ (basit tablo) | ✅ (gelişmiş filtreler, kolon yönetimi) |
| Pipeline görünümü | ❌ | ✅ (kanban board, read-only for viewer) |
| Dashboard | Basit (toplam rakamlar) | Gelişmiş (grafikler, trendler, funnel) |
| Activity timeline | ❌ | ✅ (client visibility olanlar) |
| Export | Maskelenmiş (viewer) / Tam (admin) | Maskelenmiş (viewer) / Tam (admin) |
| Kişi detay sayfası | Basit bilgiler | Tam detay + activity |
| Takım davet (admin) | ✅ | ✅ |

**DB'de tier saklanması:** `tenants` tablosuna dedicated `tier` kolonu eklenir (JSONB settings DEĞİL).
- `CHECK` constraint ile DB seviyesinde geçerli değer zorlaması (`'basic'` veya `'pro'`)
- RLS policy'lerde doğrudan referans edilebilir (JSONB'den çıkarmaya gerek yok)
- JSONB settings alanı başka amaçlarla kullanıldığından, tier gibi kritik bir değerin orada tutulması güvenlik riski oluşturur (settings alanına yazma yetkisi olan biri tier'ı değiştirebilir)
- Audit ve sorgu performansı açısından daha temiz

#### Erişim Kontrolü Formülü

Bir kullanıcının bir özelliğe erişimi = **Rol yetkisi** AND **Tenant tier'ı**

Örnek:
- `client_admin` + Pro tier tenant → Pipeline board görür (read-only), gelişmiş dashboard
- `client_admin` + Basic tier tenant → Pipeline board göremez, basit dashboard
- `client_viewer` + Pro tier tenant → Pipeline board görür (read-only), gelişmiş dashboard (okuma)
- `client_viewer` + Basic tier tenant → Sadece basit tablo + basit dashboard
- `superadmin` / `ops_agent` → Tier'dan bağımsız, her şeye erişir

**Kritik Kurallar:**
- `internal_notes` ve `visibility: 'internal'` activity'ler sadece dahili ekibe (superadmin + ops_agent) görünür
- `client_viewer` için hassas iletişim bilgileri (telefon, email) maskelenir: `john@ex...`, `+90 5** *** **34`
- `client_admin` kendi tenant'ına yeni üye davet edebilir (sadece client_viewer/client_admin rollerinde)
- Import özelliği sadece dahili ekibe açık (superadmin + ops_agent)
- Dahili ekip tier kısıtlamalarından muaftır

---

## Phase 0: Temel Altyapı (Tüm fazların ön koşulu)

### 0A. Permission Sistemi (Rol + Tier)

Erişim kontrolü iki boyutlu: **rol** (kullanıcı ne yapabilir?) + **tier** (tenant hangi özellikleri görebilir?)

**Yeni dosya:** `client/src/lib/permissions.ts`
```ts
type Tier = 'basic' | 'pro'

function isInternal(role): boolean        // superadmin | ops_agent — tier'dan muaf
function canDelete(role): boolean         // sadece superadmin
function canWrite(role): boolean          // superadmin | ops_agent | client_admin
function isReadOnly(role): boolean        // client_viewer
function canAccessFeature(role, tier, feature): boolean  // Rol + Tier birlikte kontrol

// Rol bazlı (tier'dan bağımsız):
// 'import', 'internal_notes', 'crud_companies', 'crud_contacts',
// 'activity_write', 'delete_records', 'pipeline_dragdrop'

// Tier bazlı (müşteri rollerini etkiler):
// 'pipeline_view', 'advanced_stats', 'activity_timeline', 'person_detail_full'
```

**Rol Bazlı Permission (Tier'dan bağımsız):**

| Feature | superadmin | ops_agent | client_admin | client_viewer |
|---------|-----------|-----------|-------------|---------------|
| import | ✅ | ✅ | ❌ | ❌ |
| delete_records | ✅ | ❌ | ❌ | ❌ |
| crud (create/edit) | ✅ | ✅ | ❌ | ❌ |
| internal_notes | ✅ | ✅ | ❌ | ❌ |
| activity_write | ✅ | ✅ | ❌ | ❌ |
| pipeline_dragdrop | ✅ | ✅ | ❌ | ❌ |
| invite_members | ✅ | ❌ | ✅ | ❌ |
| export_full (maskelenmemiş) | ✅ | ✅ | ✅ | ❌ |
| export_masked | ✅ | ✅ | ✅ | ✅ |

**Tier Bazlı Feature (Sadece müşteri rollerini etkiler, internal muaf):**

| Feature | Basic Tier | Pro Tier |
|---------|-----------|----------|
| Pipeline board görünümü | ❌ | ✅ (admin: view, viewer: view) |
| Gelişmiş dashboard (grafikler, funnel) | ❌ | ✅ |
| Activity timeline | ❌ | ✅ (sadece client visibility) |
| Kişi detay tam bilgi | Basit | Tam detay |
| Gelişmiş filtreler + kolon yönetimi | ❌ | ✅ |

**Yeni dosya:** `client/src/components/FeatureGate.tsx`
```tsx
// Rol bazlı kontrol:
<FeatureGate role="pipeline_dragdrop" fallback={<ReadOnlyBoard />}>
  <DraggableBoard />
</FeatureGate>

// Tier bazlı kontrol:
<TierGate feature="pipeline_view" fallback={<UpgradePrompt />}>
  <PipelineBoard />
</TierGate>
```
`useAuth()` ile role + tenant tier bilgisini alır.

### 0A-2. DB: Tenant Tier Kolonu

**Yeni migration:** `supabase/migrations/010_tenant_tier.sql`
```sql
ALTER TABLE tenants ADD COLUMN tier TEXT NOT NULL DEFAULT 'basic' CHECK (tier IN ('basic', 'pro'));
```

Tier bilgisi login response'unda ve tenant switch'te frontend'e iletilecek.

**Değişecek dosya:** `server/src/routes/auth.ts` — login ve me response'una `tier` eklenmesi
**Değişecek dosya:** `client/src/contexts/AuthContext.tsx` — `activeTenantTier` state eklenmesi

### 0A-3. Backend: Veri Filtreleme Middleware

**Yeni dosya:** `server/src/middleware/dataFilter.ts`

Müşteri rollerinde hassas verilerin otomatik filtrelenmesi:
- `internal_notes` alanı client rollerde response'dan çıkarılır
- `visibility: 'internal'` activity'ler client rollerde gizlenir
- `client_viewer` için export endpoint'lerinde email/telefon maskeleme:
  - Email: `john@ex...` (ilk 4 karakter + domain ilk 2 harf + ...)
  - Telefon: `+90 5** *** **34` (son 2 hane görünür)

### 0B. Sidebar Navigasyon

**Değişecek dosya:** `client/src/components/Layout.tsx`

Mevcut header-only AppShell'e collapsible sidebar eklenmesi:
- Dashboard (`/dashboard`) — IconChartBar
- Companies (`/companies`) — IconBuilding (mevcut LeadsPage)
- People (`/people`) — IconUsers
- Pipeline (`/pipeline`) — IconColumns
- Import (`/import`) — IconFileImport (sadece internal: superadmin + ops_agent)

Mantine `AppShell.Navbar` + `NavLink` kullanılacak. Küçük ekranlarda icon-only moda geçecek.

### 0C. Ortak Stage Utilities

**Yeni dosya:** `client/src/lib/stages.ts`

LeadsPage ve CompanyDetailPage'deki stage renk haritaları buraya çıkarılacak:
```ts
export const STAGES = ['new', 'researching', ...] as const;
export const stageColors: Record<Stage, string> = { ... };
export const PIPELINE_STAGES = STAGES.filter(s => !['won','lost','on_hold'].includes(s));
```

### 0D. Route Güncellemeleri

**Değişecek dosya:** `client/src/App.tsx`
- `/dashboard` → DashboardPage
- `/companies` → LeadsPage (mevcut `/` yerine)
- `/people` → PeoplePage
- `/people/:id` → PersonDetailPage
- `/pipeline` → PipelinePage
- `/` → redirect to `/dashboard`

---

## Phase 1: People (Kişiler) Sayfası

Mevcut contacts API ve LeadsPage pattern'i üzerine inşa edilecek.

### 1A. Backend: Contacts Route Genişletme

**Değişecek dosya:** `server/src/routes/contacts.ts`

Mevcut GET endpoint'e pagination, search, sort, filter eklenmesi:
- Search: first_name, last_name, email, title üzerinde ILIKE
- Filter: company_id, seniority, department, country (multi-select)
- Sort: first_name, last_name, email, company_name, updated_at
- Pagination: page, limit, total, totalPages

**Yeni endpoint:** `GET /api/contacts/:id` — tekil contact + company bilgisi
**Yeni endpoint:** `GET /api/contact-filter-options` — distinct seniority, department, country, company listesi

### 1B. Frontend: PeoplePage

**Yeni dosya:** `client/src/pages/PeoplePage.tsx`

LeadsPage pattern'i klonlanacak:
- Tablo kolonları: Ad Soyad, Şirket, Ünvan/Departman, Email, Kıdem, Ülke, Güncelleme
- MultiSelect filtreler: şirket, kıdem, departman, ülke
- Arama, sıralama, pagination, kolon görünürlük yönetimi
- Satıra tıklama → `/people/:id`
- Internal roller (superadmin/ops_agent): Edit aksiyonu, superadmin: Delete aksiyonu
- client_viewer: email/telefon maskelenmiş görünür

### 1C. Frontend: PersonDetailPage

**Yeni dosya:** `client/src/pages/PersonDetailPage.tsx`
- Kişi bilgileri header'ı (isim, ünvan, kıdem badge'i)
- İletişim bilgileri (email, telefon, LinkedIn)
- Bağlı şirket kartı (tıklanabilir → company detail)
- Notlar bölümü
- Activity timeline (Phase 3'te doldurulacak)

### 1D. Frontend: ContactForm (Bağımsız)

**Yeni dosya:** `client/src/components/ContactForm.tsx`
- CompanyDetailPage'deki contact formundan çıkarılıp genelleştirilecek
- Company selector (searchable) + tüm contact alanları
- Create/Edit modları, Modal + @mantine/form pattern'i

### 1E. DB Migration

**Yeni dosya:** `supabase/migrations/011_contacts_indexes.sql`
```sql
CREATE INDEX idx_contacts_tenant_first_name ON contacts(tenant_id, first_name);
CREATE INDEX idx_contacts_tenant_email ON contacts(tenant_id, email);
CREATE INDEX idx_contacts_seniority ON contacts(tenant_id, seniority);
CREATE INDEX idx_contacts_department ON contacts(tenant_id, department);
```

### 1F. i18n

`client/src/locales/en.json` ve `tr.json`'a `people` bölümü eklenmesi.

---

## Phase 2: Dashboard / İstatistikler

### 2A. Backend: Statistics Endpoints

**Yeni dosya:** `server/src/routes/statistics.ts`
- `GET /api/statistics/overview` — totalCompanies, totalContacts, companiesByStage, conversionRate
- `GET /api/statistics/pipeline` — funnel verileri
- `GET /api/statistics/trends` — period bazlı trend (7d/30d/90d)
- `GET /api/statistics/breakdown` — industry/location bazlı dağılım

Tüm endpoint'ler tenant-scoped + opsiyonel tarih aralığı filtresi.

**Değişecek dosya:** `server/src/index.ts` — route kaydı

### 2B. Frontend: DashboardPage

**Yeni dosya:** `client/src/pages/DashboardPage.tsx`

**Basic Tier tenant (client_viewer + client_admin):**
- 4 stat kartı: Toplam Şirket, Toplam Kişi, Aktif Deal, Kazanılan Deal
- Stage dağılımı (basit bar)
- Internal notlar ve internal activity'ler gizli

**Pro Tier tenant (client_viewer + client_admin):**
- Yukarıdakilere ek: conversion rate, pipeline funnel chart
- Industry dağılımı (pie/donut chart)
- Location dağılımı (bar chart)
- Tarih aralığı filtresi (7d/30d/90d/custom)

**Internal ekip (superadmin + ops_agent) — tier'dan muaf:**
- Tüm Pro özellikler + internal istatistikler
- Internal notes ile ilgili istatistikler

### 2C. Chart Bileşenleri

**Yeni dependency:** `recharts`

**Yeni dosyalar:**
- `client/src/components/charts/PipelineFunnel.tsx`
- `client/src/components/charts/IndustryBreakdown.tsx`
- `client/src/components/charts/StageTimeline.tsx`
- `client/src/components/StatCard.tsx` — tekrar kullanılabilir metrik kartı

---

## Phase 3: Activities API + UI

DB'de mevcut activities tablosu için API ve arayüz.

### 3A. Backend: Activities Route

**Yeni dosya:** `server/src/routes/activities.ts`
- `GET /api/activities` — company_id/contact_id/type ile filtreleme, pagination
- `POST /api/activities` — yeni activity oluşturma (sadece internal: superadmin + ops_agent)
- `GET /api/activities/recent` — son 20 activity (dashboard için)
- `GET /api/activities/stats` — toplam, type'a göre dağılım, 7/30 gün sayıları

**Değişecek dosya:** `server/src/index.ts` — route kaydı

### 3B. Frontend: ActivityTimeline

**Yeni dosya:** `client/src/components/ActivityTimeline.tsx`
- Kronolojik activity listesi (company veya contact bazlı)
- Type bazlı ikonlar: IconPhone, IconMail, IconBrandWhatsapp, IconCalendar, IconNote
- Expandable detail
- Pro tier tenant'larda müşteri rollerine de görünür (sadece `visibility: 'client'` olanlar)
- Basic tier tenant'larda müşteri rollerine gizli

### 3C. Frontend: ActivityForm

**Yeni dosya:** `client/src/components/ActivityForm.tsx`
- Modal form: type, summary, detail, outcome, occurred_at
- `@mantine/dates` DateTimePicker gerekli (yeni dependency)

### 3D. Entegrasyon

- **CompanyDetailPage:** ActivityTimeline + "Log Activity" butonu eklenmesi
- **PersonDetailPage:** contact_id bazlı ActivityTimeline eklenmesi
- **DashboardPage:** Son activity'ler listesi eklenmesi (Phase 2'ye retroaktif)

### 3E. Otomatik Stage Change Log

**Değişecek dosya:** `server/src/routes/companies.ts` (PUT endpoint)
- Stage değişikliğinde otomatik `status_change` activity kaydı

---

## Phase 4: Trello-Tarzı Pipeline Yönetimi

### 4A. Backend: Pipeline Endpoint'leri

**Değişecek dosya:** `server/src/routes/companies.ts`
- `GET /api/companies/pipeline` — stage'e göre gruplandırılmış şirketler (sadece aktif stage'ler)
- `PATCH /api/companies/:id/stage` — hafif stage güncelleme (drag-drop için) + otomatik activity log

### 4B. Frontend: PipelinePage

**Yeni dosya:** `client/src/pages/PipelinePage.tsx`
- Board View / Table View tab toggle

### 4C. Kanban Board

**Yeni dependency:** `@hello-pangea/dnd` (react-beautiful-dnd fork)

**Yeni dosyalar:**
- `client/src/components/pipeline/KanbanBoard.tsx` — yatay scroll, stage kolonları, drag-drop
- `client/src/components/pipeline/PipelineCard.tsx` — şirket kartı (isim, primary contact, next_step, stage'deki gün sayısı)

### 4D. Rol Bazlı Kanban Erişimi

- **client_viewer:** Read-only board, drag handle yok, quick action yok
- **client_admin:** Board görüntüleme + kart detaylarına erişim, drag-drop yok
- **ops_agent:** Full drag-drop, quick actions (edit, add activity, assign). Silme yok
- **superadmin:** Full drag-drop + silme dahil tüm aksiyonlar

### 4E. Optimistic Updates

Drag-drop'ta:
1. Local state'de kartı hemen taşı
2. PATCH `/api/companies/:id/stage` çağır
3. Hata durumunda geri al + notification

### 4F. DB Migration

**Yeni dosya:** `supabase/migrations/013_stage_changed_at.sql`
```sql
ALTER TABLE companies ADD COLUMN stage_changed_at TIMESTAMPTZ;
-- Trigger: stage değiştiğinde otomatik güncelle
-- Backfill: mevcut verileri updated_at ile doldur
```

---

## Phase 5: UX Polish

### 5A. Loading Skeleton'ları
- `client/src/components/skeletons/TableSkeleton.tsx`
- `client/src/components/skeletons/KanbanSkeleton.tsx`
- `client/src/components/skeletons/StatCardSkeleton.tsx`

### 5B. Keyboard Shortcuts
- `Ctrl/Cmd+K`: Global search focus
- `N`: Yeni şirket/kişi (context'e göre)
- `?`: Shortcuts help modal

### 5C. Responsive Tasarım
- Sidebar: md altında icon-only
- Pipeline board: yatay scroll
- Tablolar: küçük ekranda kolon gizleme
- Stat kartları: dikey stack

### 5D. Boş Durumlar (Empty States)
- Her sayfa için uygun CTA'lı empty state bileşeni

---

## Yeni Dosyalar Özeti

| Dosya | Faz | Amaç |
|-------|-----|------|
| `client/src/lib/permissions.ts` | 0 | Rol + Tier bazlı erişim kontrolü |
| `server/src/middleware/dataFilter.ts` | 0 | Hassas veri filtreleme (internal notes gizleme, email/tel maskeleme) |
| `supabase/migrations/010_tenant_tier.sql` | 0 | Tenant'a tier kolonu ekleme |
| `client/src/lib/stages.ts` | 0 | Ortak stage sabitleri ve renkleri |
| `client/src/components/FeatureGate.tsx` | 0 | Deklaratif feature erişim kontrolü |
| `client/src/pages/PeoplePage.tsx` | 1 | Kişi listesi sayfası |
| `client/src/pages/PersonDetailPage.tsx` | 1 | Kişi detay sayfası |
| `client/src/components/ContactForm.tsx` | 1 | Bağımsız kişi form modal'ı |
| `server/src/routes/statistics.ts` | 2 | İstatistik/aggregate API |
| `client/src/pages/DashboardPage.tsx` | 2 | Dashboard sayfası |
| `client/src/components/StatCard.tsx` | 2 | Tekrar kullanılabilir metrik kartı |
| `client/src/components/charts/*.tsx` | 2 | Grafik bileşenleri |
| `server/src/routes/activities.ts` | 3 | Activities CRUD API |
| `client/src/components/ActivityTimeline.tsx` | 3 | Activity listesi bileşeni |
| `client/src/components/ActivityForm.tsx` | 3 | Activity kayıt modal'ı |
| `client/src/pages/PipelinePage.tsx` | 4 | Pipeline sayfası |
| `client/src/components/pipeline/KanbanBoard.tsx` | 4 | Kanban board |
| `client/src/components/pipeline/PipelineCard.tsx` | 4 | Pipeline kartı |
| `supabase/migrations/011_contacts_indexes.sql` | 1 | Contact sorgu index'leri |
| `supabase/migrations/012_activities_indexes.sql` | 3 | Activity sorgu index'leri |
| `supabase/migrations/013_stage_changed_at.sql` | 4 | Stage süre takibi kolonu |

## Değişecek Mevcut Dosyalar

| Dosya | Değişiklik |
|-------|-----------|
| `client/src/App.tsx` | Yeni route'lar |
| `client/src/components/Layout.tsx` | Sidebar navigasyon |
| `client/src/lib/types.ts` | Yeni type tanımları |
| `client/src/locales/en.json`, `tr.json` | Yeni çeviri anahtarları |
| `client/src/pages/LeadsPage.tsx` | stageColors import'u stages.ts'den |
| `client/src/pages/CompanyDetailPage.tsx` | stageColors import + ActivityTimeline |
| `server/src/index.ts` | Yeni route kayıtları |
| `server/src/routes/contacts.ts` | Pagination, search, sort, filter |
| `server/src/routes/companies.ts` | PATCH stage endpoint + auto activity log |
| `client/package.json` | @mantine/dates, recharts, @hello-pangea/dnd |

## Yeni Dependencies

| Paket | Faz | Amaç |
|-------|-----|------|
| `@mantine/dates` | 3 | DateTimePicker (ActivityForm) |
| `recharts` | 3 | Dashboard grafikleri |
| `@hello-pangea/dnd` | 4 | Kanban drag-drop |

---

## İlerleme Takibi

| Faz | Durum | Notlar |
|-----|-------|--------|
| Phase 0: Temel Altyapı | ✅ Tamamlandı | permissions.ts, FeatureGate.tsx, stages.ts, dataFilter.ts, 010_tenant_tier.sql, auth tier, sidebar nav, routes |
| Phase 1: People Sayfası | ✅ Tamamlandı | PeoplePage, PersonDetailPage, ContactForm, contacts backend (pagination/search/filter), 011_contacts_indexes.sql, i18n |
| Phase 2: Dashboard | ⬜ Bekliyor | |
| Phase 3: Activities | ⬜ Bekliyor | |
| Phase 4: Pipeline | ⬜ Bekliyor | |
| Phase 5: UX Polish | ⬜ Bekliyor | |

---

## Doğrulama / Test Planı

1. **Phase 0:** Sidebar render, route navigasyonu, FeatureGate + TierGate davranışı, tier bilgisi auth flow'da
2. **Phase 1:** `/people` sayfası arama/filtre/sayfalama, kişi detay, CRUD, tenant izolasyonu, client_viewer maskeleme
3. **Phase 2:** Dashboard metriklerin doğruluğu, grafiklerin render'ı, Basic vs Pro tier görünüm farkı
4. **Phase 3:** Activity oluşturma, CompanyDetail'de timeline, stage değişikliğinde otomatik log, Pro tier'da client'a görünürlük
5. **Phase 4:** Kanban board'da drag-drop ile stage değişikliği, optimistic update, Basic tier'da pipeline gizli, Pro tier'da read-only (client)
6. **Phase 5:** Skeleton'lar, responsive davranış, keyboard shortcuts
7. **Tüm fazlar:** i18n (TR/EN), rol + tier bazlı erişim kontrolü, tenant izolasyonu
