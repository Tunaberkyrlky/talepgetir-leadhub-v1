# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LeadHub is a B2B multi-tenant CRM/lead management SaaS. It replaces Excel/CSV-based lead tracking with a web app featuring import, pipeline (Kanban), dashboard with globe visualization, and admin panels. The UI is bilingual (Turkish/English).

## Commands

```bash
# Install all dependencies (root + workspaces)
npm install

# Development (runs both client and server concurrently)
npm run dev

# Run individually
npm run dev:server    # Express API on port 3001 (tsx watch)
npm run dev:client    # Vite dev server on port 5173

# Build (server tsc, then client vite build)
npm run build

# Lint (client only)
cd client && npm run lint
```

No test runner is configured.

## Architecture

**Monorepo** with npm workspaces: `client/` and `server/`. Deployed to Railway as a long-lived Node process (`server/src/index.ts`, `app.listen`) that also serves the built client. Staging and production are separate Railway environments. (Because it's a persistent process, fire-and-forget background work after a response is safe — this would NOT hold under a serverless model.)

### Tech Stack
- **Client:** React 19, Mantine UI, TanStack React Query, React Router, i18next, Recharts, Axios
- **Server:** Express.js, Zod validation, Pino logger, Multer (file uploads)
- **Database:** Supabase (PostgreSQL + Auth + RLS). No ORM — uses Supabase JS client directly.
- **Auth:** Supabase Auth with httpOnly cookie JWTs. Server caches auth results (60s TTL).

### Client Structure (`client/src/`)
- `pages/` — Lazy-loaded route components (LeadsPage, ImportPage, DashboardPage, PipelinePage, AdminPage, PeoplePage, CompanyDetailPage)
- `components/` — Reusable UI (forms, admin panels, pipeline, charts, import mapping)
- `contexts/` — AuthContext (user/tenant state), StagesContext (pipeline config), ImportProgressContext
- `lib/api.ts` — Axios instance with cookie auth, token refresh interceptor, X-Tenant-Id header injection
- `types/` — Shared TypeScript interfaces

### Server Structure (`server/src/`)
- `routes/` — Express routers: auth, companies, contacts, import, admin, settings, statistics, tenants, filter-options
- `middleware/auth.ts` — JWT validation, role resolution from `memberships` table, tenant context
- `middleware/dataFilter.ts` — Hides `internal_notes` from non-internal roles
- `middleware/errorHandler.ts` — Global error handler with AppError class
- `lib/supabase.ts` — Supabase client setup (anon + service role)
- `lib/importProcessor.ts` — CSV/XLSX parsing (PapaParse + ExcelJS), validation, batch insert
- `lib/importMapper.ts` — Column mapping and field transformation

### Multi-Tenancy
Every data table is scoped by `tenant_id`. RLS policies enforce isolation at the database level. Users have memberships with roles: `superadmin`, `ops_agent`, `client_admin`, `client_viewer`. Internal roles (superadmin, ops_agent) can switch tenants via X-Tenant-Id header.

### Database Migrations
SQL migration files live in `supabase/migrations/`, numbered with a sequential 3-digit prefix (currently up to 048+). Applied to Supabase via the CLI/MCP, which tracks them by **timestamp version** in `supabase_migrations.schema_migrations` — NOT by the file-number prefix. So a duplicate number prefix is cosmetic (won't shadow an apply), but keep numbers unique to avoid confusion. Key tables: `tenants`, `memberships`, `companies`, `contacts`, `activities`, `import_jobs`, `pipeline_stages`. Helper functions: `get_user_tenant_id()`, `get_user_role()`, `is_superadmin()`.

### Middleware Stack Order
Compression → Helmet → Pino-HTTP → CORS → Cookie Parser → JSON (10MB limit) → Rate Limiters → Health Check → Auth Routes (public) → Auth Middleware → Protected Routes → Admin Routes (superadmin only) → Error Handler

## Temporary Files

Geçici dosyalar (test scriptleri, deneme CSV'leri, tek seferlik araçlar vb.) için `temp/` klasörünü kullan. Bu klasör `.gitignore`'da tanımlıdır — içindekiler git'e girmez. Kaynak kodun içine (`server/scripts/`, `client/src/` vb.) geçici dosya koyma.

## Key Patterns

- **Rate limiting:** Auth (10/15min), Import (30/15min), General (100/min)
- **Import flow:** Upload file → parse headers → user maps columns (MappingEditor) → execute with batch insert (500 rows/batch) → poll job status
- **Pipeline stages:** Per-tenant configuration stored in `pipeline_stages` table, Turkish stage name aliases supported
- **Translations:** i18next with `client/src/i18n/locales/{tr,en}.json`. Companies have a `translations` JSONB column for multi-language content (DeepL API).
- **Environment:** Copy `.env.example` to `.env` in both root and client directories. Supabase credentials required.

## Versioning

Kullanıcı "versiyonla" veya "commit at versiyonla" dediğinde şu adımları uygula:

1. **3 package.json güncelle**: `package.json`, `client/package.json`, `server/package.json` içindeki `"version"` alanını yeni versiyona çek (hepsi aynı olmalı).
2. **Changelog güncelle**: `client/src/lib/changelog.ts` dosyasının `changelog` dizisinin **başına** yeni entry ekle.
3. **DURAKLA, commit ETME**. Kullanıcıya "değişiklikler hazır, kontrol et" de ve "tamam" / "devam" onayını bekle. Bu noktada kullanıcı kelime seçimi, tip ayarı, satır ekleme veya silme gibi küçük düzenlemeler yapabilir.
4. **Onay sonrası commit at**.

### Changelog yazım kuralları

Yeni format: her entry **3 kısa soruya** cevap verir (eski `features: [...]` dizisini yeni entry'lerde KULLANMA; yalnızca geçmiş entry'lerde kalır):

- `about` — **Bu güncelleme ne hakkında?** (zorunlu)
- `usage` — **Yeni kullanım nasıl?** (kullanıcıya görünür yeni ekran/buton/davranış varsa; saf düzeltmede bu alanı koyma)
- `notes` — **Neleri bilmeliyim?** (gerçek bir uyarı/sınır varsa; yoksa bu alanı koyma)

Kurallar:
- **Type alanı zorunlu**: `'feature' | 'fix' | 'improvement' | 'security'`. Başlıkta renkli rozet. Karma içerikse en baskın olanı seç (öncelik: feature > improvement > fix > security).
- **Her alan tek cümle, kısa ve öz.** Sadece kullanıcının bilmesi gerekeni yaz; arka plandaki teknik değişiklikleri (refactor, RPC, migration, type fix) yazma.
- **Saygılı 2. çoğul (siz) + öneri kipi.** "Filtreliyorsun" değil, "filtreleyebilirsiniz". İkinci tekil ve emir kipinden kaçın; imkân sun.
- **Dash (—, –, -) yok**, madde listesi yok. Cümleyi nokta/virgülle bağla.
- **TR ve EN ikisi de zorunlu**, anlam aynı kalmalı.

### Örnek

İyi (feature):
```
title: { tr: 'Aktivite Filtreleri', en: 'Activity Filters' },
about: { tr: 'Aktiviteleri tipe göre filtreleyebilir ve şirket adına göre arayabilirsiniz.', en: 'You can filter activities by type and search by company name.' },
usage: { tr: 'Aktiviteler sayfasındaki stat kartına tıklayın ya da arama kutusuna şirket adını yazın.', en: 'Click a stat card on the Activities page or type a company name in the search box.' },
```

İyi (saf fix, `usage` yok):
```
title: { tr: 'Sayaç Görünüm Düzeltmesi', en: 'Counter Display Fix' },
about: { tr: 'Sayaç rozetlerinin büyük sayıları kırpması düzeltildi.', en: 'Fixed counter badges clipping large numbers.' },
notes: { tr: 'Artık yüzler ve binler de tam görünüyor.', en: 'Hundreds and thousands now show in full.' },
```

Kötü (dash + emir kipi + teknik detay + uzun + features dizisi):
```
features: [{ tr: 'Stat kartları artık tıklanabilir — SegmentedControl kaldırıldı, search_companies RPC eklendi.' }]
```