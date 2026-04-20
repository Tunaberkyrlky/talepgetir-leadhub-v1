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

**Monorepo** with npm workspaces: `client/` and `server/`. Deployed to Vercel (static client + serverless API via `/api/index.ts`).

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
SQL migration files live in `supabase/migrations/` (numbered 001–011). Key tables: `tenants`, `memberships`, `companies`, `contacts`, `activities`, `import_jobs`, `pipeline_stages`. Helper functions: `get_user_tenant_id()`, `get_user_role()`, `is_superadmin()`.

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

1. **3 package.json güncelle** — `package.json`, `client/package.json`, `server/package.json` içindeki `"version"` alanını yeni versiyona çek (hepsi aynı olmalı)
2. **Changelog güncelle** — `client/src/lib/changelog.ts` dosyasının `changelog` dizisinin **başına** yeni entry ekle:
   - Kullanıcıyı etkileyen özellikleri ön plana çıkart (yeni ekran, yeni buton, davranış değişikliği)
   - Teknik/arka plan değişikliklerini (güvenlik, performans, refactor) tek satırda özetle
   - Her feature açıklaması kullanıcının "bununla ne yapabilirim" sorusuna cevap vermeli
   - TR ve EN dil desteği zorunlu
3. **Commit at** — değişiklikleri commit et