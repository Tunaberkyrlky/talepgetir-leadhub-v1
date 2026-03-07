# LeadHub – B2B Lead/CRM Multi-Tenant Web App MVP Planı

> **Amaç:** Excel/CSV üzerinden yürüyen B2B lead durum raporlamasını çok-tenantlı, güvenli bir web app'e taşımak.
> **Hedef Stack:** Node.js + React + Supabase (Auth + Postgres + RLS)

---

## 1. Open Questions (Maks 10)

Aşağıdaki sorular cevaplanmadan kritik tasarım kararları alınmamalıdır.

| # | Soru | Durum | Cevap / Karar |
|---|------|:-----:|---------------|
| 1 | Müşteri portalında hangi alanlar görünmeli? | ✅ Cevaplandı | **Başlangıçta belirlenmeyecek.** Auth + roller eklenirken (V5) hangi alanların hangi rolle görüneceği belirlenecek. MVP'de tüm alanlar ops'a açık. |
| 2 | Internal notes / Client-visible notes ayrımı? | ✅ Cevaplandı | **Evet, rol tabanlı.** Notların görünürlüğü rollere göre belirlenecek. `visibility` flag kullanılacak. |
| 3 | Lead tek tenant'a mı ait, çoklu tenant mümkün mü? | ✅ Cevaplandı | **Her müşteri sadece kendi lead'lerini görür (katı kural).** Ancak aynı şirket farklı müşteriler için bağımsız olarak yüklenmiş olabilir → tenant başına ayrı row. |
| 4 | Export PDF formatı? | ⏳ Bekliyor | Daha fazla detay gerekli, ileride netleştirilecek. |
| 5 | Import kolon mapping gerekli mi? | ✅ Cevaplandı | **Adaptif sistem gerekli ama MVP'de strict template yeterli.** _Alt soru: Yüklenecek verilerin kolon adları DB entity'leri ile uyuşmazsa baştan mapping gerekir mi?_ → Aşağıda cevaplandı. |
| 6 | Rol örnekleri net mi? `superadmin`, `ops_agent`, `client_admin`, `client_viewer` | ✅ Cevaplandı | **Roller uygun.** İleride yeni roller eklenebilir. |
| 7 | Activity/Interaction log MVP'de şart mı? | ✅ Cevaplandı | **MVP'de şart değil.** Ancak ileride entegrasyona uygun olacak şekilde DB tasarla (activities tablosu hazır, UI sonra). |
| 8 | Data retention: müşteri ayrılırsa ne olur? | ✅ Cevaplandı | **Arşivliyoruz, silme yok.** Soft-delete + kalıcı arşiv. |
| 9 | Performans hedefi: tenant başına kaç lead? | ✅ Cevaplandı | **Maksimum ~1K.** Veri önceden temizlenip elenerek import ediliyor. Basit pagination ve ILIKE yeterli. |
| 10 | Çoklu dil / timezone? | ✅ Cevaplandı | **Baştan i18n ekle.** Birden fazla dil desteği olacak. |

### Soru 5 — Import Mapping Alt Sorusu

> Kullanıcının yükleyeceği veriler ile DB entity'leri uyuşmadığında ne olacak?

Bu kritik bir soru. İki senaryo var:

| Senaryo | Açıklama | Çözüm |
|---------|---------|-------|
| **A) Kolon adları farklı, veri aynı yapıda** | Kullanıcının dosyasında `Şirket Adı` yazıyor, DB'de `company_name` | MVP'de **header mapping UI'ı** (basit dropdown: "Bu kolon hangi alana karşılık geliyor?") |
| **B) Dosyada DB'de olmayan alanlar var** | Kullanıcının dosyasında `Sektör Kodu`, `Referans No` gibi ekstra kolonlar var | ✅ **DECISION:** `custom_fields JSONB` kolonuna kaydedilir |

> **Karar:** MVP'de basit bir **header mapping adımı** + **custom_fields JSONB** desteği:
> 1. Sistem dosyanın header'larını okur
> 2. Bilinen DB alanlarıyla otomatik eşleştirmeye çalışır (fuzzy match)
> 3. Eşleşmeyen kolonlar için kullanıcıya dropdown gösterir
> 4. Haritalanmayan kolonlar → `companies.custom_fields` JSONB'ye kaydedilir (veri kaybı olmaz)
>
> Bu "strict template" ile "full dynamic mapper" arasında iyi bir denge sağlar.

---

## 2. Assumptions (Etiketli)

Aşağıdaki varsayımlar, yukarıdaki sorulara cevap gelene kadar geçerlidir. Cevaplara göre revize edilecektir.

| # | Varsayım / Karar | Durum | Alternatif |
|---|-----------------|:-----:|-----------|
| **ASSUMPTION-1** | Supabase Auth + Postgres + RLS kullanılacak | Varsayım | Alternatif: kendi auth katmanı + raw Postgres |
| **DECISION-2** | Bir lead (company) **tek bir tenant'a** ait; farklı tenant'larda aynı şirket bağımsız row olarak tutulur | ✅ Onaylandı | — |
| **DECISION-3** | MVP'de sadece **current status + next step** yeterli; activity timeline MVP'de yok ama **DB tasarımında activities tablosu hazır**, UI ileride | ✅ Onaylandı | — |
| **DECISION-4** | **Baştan i18n altyapısı** kurulacak, birden fazla dil desteği olacak | ✅ Onaylandı | — |
| **DECISION-5** | Tenant başına lead sayısı **≤1K** (veri önceden temizlenip import ediliyor). Basit ILIKE + offset pagination yeterli | ✅ Onaylandı | — |
| **DECISION-6** | Internal notes/client-visible notes ayrımı **var**; `visibility` flag ile, rol tabanlı erişim | ✅ Onaylandı | — |
| **ASSUMPTION-7** | PDF export formatı henüz belirlenmedi, MVP'de ertelenebilir | Varsayım (bekliyor) | Daha fazla detay gerekli |
| **DECISION-8** | Import: MVP'de **basit header mapping** (auto-match + dropdown) + **custom_fields JSONB** (eşleşmeyen kolonlar) | ✅ Onaylandı | — |
| **DECISION-9** | Müşteri ayrılınca veriler **arşivlenir, silme yok**. Soft-delete + kalıcı arşiv | ✅ Onaylandı | — |
| **ASSUMPTION-10** | Node.js API katmanı **olacak** (direct Supabase client bağlantısı yerine) | Varsayım | Alternatif: Supabase client-only |
| **DECISION-11** | Field-level visibility **MVP'de belirlenmeyecek**, V5'te roller tanımlanırken netleşecek | ✅ Onaylandı | — |
| **DECISION-12** | Roller: `superadmin`, `ops_agent`, `client_admin`, `client_viewer` onaylandı. İleride yeni roller eklenebilir | ✅ Onaylandı | — |

---

## 3. Architecture Options

### Seçenek A: React → Node API → Supabase (Önerilen)

```
┌──────────┐     ┌──────────────┐     ┌──────────────────┐
│  React   │────▶│  Node.js API │────▶│  Supabase        │
│  Client  │◀────│  (Express /  │◀────│  (Auth+Postgres  │
│          │     │   Fastify)   │     │   + RLS + Storage)│
└──────────┘     └──────────────┘     └──────────────────┘
```

| Avantaj | Dezavantaj |
|---------|-----------|
| Import/Export işlemleri server-side (güvenli, büyük dosya) | Ekstra layer, geliştirme süresi artar |
| Rate limiting, audit log, PDF generation server'da | Deployment karmaşıklığı (2 servis) |
| `service_role` key asla client'ta olmaz | |
| Business logic merkezi, test edilebilir | |
| Supabase'e bağımlılık azalır (ileride migration kolay) | |

### Seçenek B: React → Supabase Direct (Alternatif)

```
┌──────────┐     ┌──────────────────┐
│  React   │────▶│  Supabase        │
│  Client  │◀────│  (Auth+Postgres  │
│          │     │   + RLS + Edge Fn)│
└──────────┘     └──────────────────┘
```

| Avantaj | Dezavantaj |
|---------|-----------|
| Daha az kod, hızlı MVP | Import/Export client-side → güvenlik riski |
| Supabase Edge Functions ile server logic | Edge Functions limitli (cold start, timeout) |
| Tek deployment | `anon` key client'ta → RLS hata riski yüksek |
| | PDF generation zor |
| | Business logic dağınık |

> **Öneri:** Seçenek A ile başla. Supabase'i **sadece DB + Auth** olarak kullan, tüm business logic Node API'de yaşasın. Bu sayede ileride Supabase'den bağımsızlaşabiliriz.

### Hibrit Seçenek (Trade-off)

MVP'de **az sayıda endpoint** için Node API, geri kalanı Supabase direct. Ancak güvenlik sınırı belirsizleşir — **önerilmez**.

---

## 4. Data Model

### Seçenek A: Basit MVP Şeması

> Her tabloda `tenant_id` zorunlu. RLS politikaları bu kolon üzerinden çalışır.

```sql
-- ==========================================
-- TENANT & AUTH
-- ==========================================

CREATE TABLE tenants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,                  -- "Acme Corp"
  slug        TEXT UNIQUE NOT NULL,           -- "acme-corp" (URL-friendly)
  settings    JSONB DEFAULT '{}',             -- tenant-level config
  is_active   BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE memberships (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('superadmin','ops_agent','client_admin','client_viewer')),
  is_active   BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, tenant_id)
);

-- ==========================================
-- CORE DATA
-- ==========================================

CREATE TABLE companies (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  website     TEXT,
  location    TEXT,
  industry    TEXT,
  custom_fields JSONB DEFAULT '{}',            -- import'ta eşleşmeyen kolonlar (DECISION-8)
  employee_count TEXT,                        -- "50-200" gibi range
  stage       TEXT NOT NULL DEFAULT 'new'
              CHECK (stage IN ('new','researching','contacted','meeting_scheduled',
                               'proposal_sent','negotiation','won','lost','on_hold')),
  deal_summary    TEXT,                       -- client-visible
  internal_notes  TEXT,                       -- ops only
  next_step       TEXT,                       -- "Follow up on Monday"
  assigned_to     UUID REFERENCES auth.users(id),
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE contacts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  full_name   TEXT NOT NULL,
  title       TEXT,                           -- "CTO", "VP Sales"
  email       TEXT,                           -- PII
  phone_e164  TEXT,                           -- PII, E.164 format
  whatsapp_e164 TEXT,                         -- PII
  is_primary  BOOLEAN DEFAULT false,
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- ==========================================
-- ACTIVITY & TASKS (MVP'de UI yok, DB hazır — DECISION-3)
-- ==========================================

CREATE TABLE activities (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  contact_id  UUID REFERENCES contacts(id),
  type        TEXT NOT NULL CHECK (type IN ('call','email','whatsapp','meeting','note','status_change')),
  outcome     TEXT,                           -- "positive", "no_answer", etc.
  summary     TEXT NOT NULL,
  detail      TEXT,
  visibility  TEXT DEFAULT 'internal' CHECK (visibility IN ('internal','client')),
  occurred_at TIMESTAMPTZ DEFAULT now(),
  created_by  UUID REFERENCES auth.users(id),
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE tasks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  task_type   TEXT NOT NULL CHECK (task_type IN ('follow_up','meeting','call','email','other')),
  title       TEXT NOT NULL,
  note        TEXT,
  due_at      TIMESTAMPTZ,
  status      TEXT DEFAULT 'pending' CHECK (status IN ('pending','completed','cancelled')),
  assigned_to UUID REFERENCES auth.users(id),
  created_by  UUID REFERENCES auth.users(id),
  created_at  TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- ==========================================
-- IMPORT / EXPORT AUDIT
-- ==========================================

CREATE TABLE import_jobs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  file_name   TEXT NOT NULL,
  file_type   TEXT NOT NULL CHECK (file_type IN ('csv','xlsx')),
  status      TEXT DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed')),
  total_rows  INT,
  success_count INT DEFAULT 0,
  error_count   INT DEFAULT 0,
  error_details JSONB DEFAULT '[]',
  created_by  UUID REFERENCES auth.users(id),
  created_at  TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE export_jobs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  format      TEXT NOT NULL CHECK (format IN ('csv','xlsx','pdf')),
  filters     JSONB DEFAULT '{}',             -- hangi filtreleme ile export edildi
  row_count   INT,
  file_url    TEXT,                            -- Supabase Storage URL
  created_by  UUID REFERENCES auth.users(id),
  created_at  TIMESTAMPTZ DEFAULT now(),
  expires_at  TIMESTAMPTZ                     -- signed URL expiry
);
```

#### İndeks Önerileri (Seçenek A)

```sql
-- Tenant isolation + sıralama
CREATE INDEX idx_companies_tenant      ON companies(tenant_id);
CREATE INDEX idx_companies_tenant_stage ON companies(tenant_id, stage);
CREATE INDEX idx_companies_tenant_name  ON companies(tenant_id, name);
CREATE INDEX idx_contacts_tenant       ON contacts(tenant_id);
CREATE INDEX idx_contacts_company      ON contacts(company_id);
CREATE INDEX idx_activities_tenant     ON activities(tenant_id);
CREATE INDEX idx_activities_company    ON activities(company_id);
CREATE INDEX idx_memberships_user      ON memberships(user_id);
CREATE INDEX idx_memberships_tenant    ON memberships(tenant_id);

-- Full-text search (ihtiyaç olursa)
-- CREATE INDEX idx_companies_fts ON companies
--   USING gin(to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(website,'') || ' ' || coalesce(location,'')));
```

#### Status/Stage Tasarımı

| Yaklaşım | Avantaj | Dezavantaj |
|-----------|---------|-----------|
| **CHECK constraint (enum-like)** | Basit, migration ile yönetilebilir, MVP'ye uygun | Yeni stage eklemek migration gerektirir |
| **Lookup table (`stages`)** | Dinamik, tenant-specific stage'ler mümkün | Ekstra join, karmaşıklık |

> **Öneri:** MVP'de CHECK constraint, ileride tenant-specific stage ihtiyacı olursa lookup table'a geçiş.

---

### Seçenek B: Apollo'ya Uygun, PII Ayrıştırmalı Şema

> İleride data marketplace / veri ürünü çıkarmak istenirse bu model daha uygun.

```sql
-- ==========================================
-- FIRMOGRAPHIC (PII-free, aggregatable)
-- ==========================================

CREATE TABLE companies (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name  TEXT NOT NULL,               -- normalized company name
  website         TEXT,
  industry        TEXT,
  employee_range  TEXT,
  hq_location     TEXT,
  linkedin_url    TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
  -- NOT: tenant_id yok, global registry
);

CREATE TABLE tenant_companies (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  company_id  UUID NOT NULL REFERENCES companies(id),
  stage       TEXT NOT NULL DEFAULT 'new',
  deal_summary TEXT,
  internal_notes TEXT,
  next_step   TEXT,
  assigned_to UUID,
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, company_id)
);

-- ==========================================
-- PII LAYER (encrypted / maskable)
-- ==========================================

CREATE TABLE people (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID REFERENCES companies(id),
  full_name   TEXT NOT NULL,                   -- PII
  title       TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE contact_points (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id   UUID NOT NULL REFERENCES people(id),
  channel     TEXT NOT NULL CHECK (channel IN ('email','phone','whatsapp','linkedin')),
  value       TEXT NOT NULL,                   -- PII — encrypted at rest
  is_verified BOOLEAN DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- ==========================================
-- ENGAGEMENT (tenant-scoped)
-- ==========================================

CREATE TABLE engagements (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id),
  company_id  UUID NOT NULL REFERENCES companies(id),
  person_id   UUID REFERENCES people(id),
  type        TEXT NOT NULL,
  outcome     TEXT,
  summary     TEXT,
  visibility  TEXT DEFAULT 'internal',
  occurred_at TIMESTAMPTZ DEFAULT now(),
  created_by  UUID,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- ==========================================
-- DATA EXPORT (anonymized aggregation)
-- ==========================================

CREATE TABLE dataset_exports (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  description TEXT,
  query_definition JSONB,                     -- hangi filtreler kullanıldı
  row_count   INT,
  pii_removed BOOLEAN DEFAULT true,
  created_by  UUID,
  created_at  TIMESTAMPTZ DEFAULT now()
);
```

### Seçenek Karşılaştırması

| Kriter | Seçenek A (Basit MVP) | Seçenek B (Apollo-uyumlu) |
|--------|----------------------|--------------------------|
| **MVP hızı** | ✅ Hızlı, az tablo | ⚠️ Daha fazla tablo ve ilişki |
| **Tenant izolasyonu** | ✅ Her tabloda `tenant_id` — basit RLS | ⚠️ `companies` global — RLS karmaşık |
| **PII yönetimi** | ⚠️ PII dağınık | ✅ PII ayrı katmanda, şifrelenebilir |
| **Veri ürünü / Apollo yolu** | ⚠️ Refactoring gerekir | ✅ Hazır |
| **Dedup** | ⚠️ Tenant içi dedup | ✅ Global dedup, tek company kaydı |
| **Karmaşıklık** | Düşük | Orta-Yüksek |

> **Öneri:** MVP'de **Seçenek A** ile başla. V5+ sonrasında Apollo yoluna geçerken Seçenek B'ye migration planla. Seçenek A'daki `companies.website` alanı ileride canonical matching için seed olabilir.

---

## 5. Supabase RLS + RBAC Planı

### 5.1 RLS Policy Stratejisi

> **ASSUMPTION-1:** Supabase kullanılacak. `tenant_id` her data tablosunda zorunlu.

#### Yardımcı Fonksiyon

```sql
-- Kullanıcının aktif tenant_id'sini döndürür
-- JWT custom claim veya session context üzerinden

CREATE OR REPLACE FUNCTION get_user_tenant_id()
RETURNS UUID AS $$
  SELECT (auth.jwt() -> 'app_metadata' ->> 'tenant_id')::UUID;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Kullanıcının rolünü döndürür
CREATE OR REPLACE FUNCTION get_user_role()
RETURNS TEXT AS $$
  SELECT role FROM memberships
  WHERE user_id = auth.uid()
    AND tenant_id = get_user_tenant_id()
    AND is_active = true
  LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER;
```

#### Örnek RLS Politikaları

```sql
-- ============================
-- companies tablosu
-- ============================

ALTER TABLE companies ENABLE ROW LEVEL SECURITY;

-- SELECT: tenant kendi verisini görür
CREATE POLICY "companies_select" ON companies
  FOR SELECT USING (tenant_id = get_user_tenant_id());

-- INSERT: ops_agent ve üstü
CREATE POLICY "companies_insert" ON companies
  FOR INSERT WITH CHECK (
    tenant_id = get_user_tenant_id()
    AND get_user_role() IN ('superadmin', 'ops_agent')
  );

-- UPDATE: ops_agent ve üstü
CREATE POLICY "companies_update" ON companies
  FOR UPDATE USING (
    tenant_id = get_user_tenant_id()
    AND get_user_role() IN ('superadmin', 'ops_agent')
  );

-- DELETE: sadece superadmin
CREATE POLICY "companies_delete" ON companies
  FOR DELETE USING (
    tenant_id = get_user_tenant_id()
    AND get_user_role() = 'superadmin'
  );
```

#### Önemli Notlar

- `client_viewer` → sadece SELECT, field-level redaction API katmanında
- `client_admin` → SELECT + kendi tenant'ındaki kullanıcıları yönetme (memberships tablosu)
- `ops_agent` → CRUD (companies, contacts, activities, tasks)
- `superadmin` → her şey + tenant yönetimi

### 5.2 RBAC Permission Matrix

| İşlem | `superadmin` | `ops_agent` | `client_admin` | `client_viewer` |
|-------|:---:|:---:|:---:|:---:|
| Companies — View | ✅ | ✅ | ✅ | ✅ |
| Companies — Create/Edit | ✅ | ✅ | ❌ | ❌ |
| Companies — Delete | ✅ | ❌ | ❌ | ❌ |
| Contacts — View | ✅ | ✅ | ✅ | ⚠️ Masked |
| Contacts — Create/Edit | ✅ | ✅ | ❌ | ❌ |
| Internal Notes — View | ✅ | ✅ | ❌ | ❌ |
| Client Notes — View | ✅ | ✅ | ✅ | ✅ |
| Import | ✅ | ✅ | ❌ | ❌ |
| Export CSV/XLSX | ✅ | ✅ | ✅ | ✅ |
| Export PDF | ✅ | ✅ | ✅ | ✅ |
| User Management | ✅ | ❌ | ✅ (kendi tenant'ı) | ❌ |
| Tenant Management | ✅ | ❌ | ❌ | ❌ |

### 5.3 Server/Client Güvenlik Sınırı

#### React Client Doğrudan Supabase'e Bağlanırsa Riskler

| Risk | Açıklama | Şiddet |
|------|---------|--------|
| `anon` key client-side | JavaScript ile herkes görebilir, RLS hata varsa veri sızar | 🔴 Yüksek |
| RLS bypass | Tek bir policy hatası tüm tenant verilerini açar | 🔴 Kritik |
| Import | Client-side parsing → büyük dosyalarda timeout + validation bypass | 🟡 Orta |
| Export | PDF generation client-side mümkün değil / zor | 🟡 Orta |
| Rate limit | Supabase'in built-in rate limit'i sınırlı | 🟡 Orta |
| Audit log | Client'tan gelen audit log güvenilir değil | 🟡 Orta |

#### Node API Katmanı Ne Kazandırır?

- ✅ `service_role` key sadece server'da → RLS bypass riski sıfır
- ✅ Import: server-side parsing, validation, dedup
- ✅ Export: PDF generation (puppeteer/pdfkit), signed URL
- ✅ Rate limiting (express-rate-limit)
- ✅ Audit logging (merkezi, güvenilir)
- ✅ Field-level redaction (PII maskeleme API'de)
- ✅ İleride Supabase'den bağımsızlaşma kolaylığı

### 5.4 Kritik Güvenlik Kontrol Listesi

| # | Kontrol | Açıklama | Sürüm |
|---|---------|---------|-------|
| 1 | **Tenant isolation test** | Her API endpoint'inde "tenant A, tenant B verisine erişemez" testi | V0 |
| 2 | **RLS enable check** | Tüm tablolarda RLS enabled olduğunu CI'da kontrol et | V0 |
| 3 | **`service_role` key isolation** | Bu key asla client bundle'ında olmamalı | V0 |
| 4 | **XSS protection** | Tüm text alanları escape edilmeli (React default yapar, `dangerouslySetInnerHTML` kullanma) | V0 |
| 5 | **Export audit log** | Her export'un kim/ne zaman/hangi filtre ile yaptığı loglanmalı | V3 |
| 6 | **Export rate limit** | Tenant başına X export/saat | V3 |
| 7 | **PDF watermark** | Export edilen PDF'lerde "Confidential – [Tenant Name]" | V4 |
| 8 | **Input validation** | Import sırasında SQL injection / formula injection engellenmeli | V1 |
| 9 | **CORS** | API sadece bilinen origin'lere izin vermeli | V0 |
| 10 | **Least privilege** | Supabase anon key → minimum yetkili, service_role → sadece API | V0 |

---

## 6. Import Planı

### 6.1 Akış

```
Kullanıcı dosya yükler (CSV/XLSX)
        │
        ▼
  ┌─────────────┐
  │ Node API    │
  │ File Upload │
  │ (multer)    │
  └──────┬──────┘
         │
         ▼
  ┌──────────────┐
  │ Parse        │     CSV: papaparse / csv-parse
  │ & Validate   │     XLSX: xlsx / exceljs
  └──────┬───────┘
         │
         ▼
  ┌──────────────┐
  │ Column Map   │     MVP: strict template (kolon adları sabit)
  │ (V1+ dynamic)│     V1+: kolon eşleştirme UI'ı
  └──────┬───────┘
         │
         ▼
  ┌──────────────┐
  │ Dedup Check  │     company name + website match → update or skip?
  └──────┬───────┘
         │
    ┌────┴────┐
    ▼         ▼
 INSERT    UPDATE        → import_jobs tablosuna sonuç yazılır
    │         │
    └────┬────┘
         ▼
  ┌──────────────┐
  │ Validation   │     Hatalı satırlar → error_details JSONB
  │ Report       │     UI'da hata özeti gösterilir
  └──────────────┘
```

### 6.2 Import Mapping Stratejisi (Güncellendi)

> **DECISION-8:** Adaptif mapping sistemi. MVP'de basit header mapping UI'ı.

#### Akış:

```
Dosya yüklenir → Header'lar okunur → Auto-match (fuzzy) → Kullanıcıya eşleştirme UI'ı → Onay → Import
```

#### Bilinen DB Alanları (auto-match hedefi):

| DB Alanı | Beklenen Kolon Adları (fuzzy match) | Zorunlu | Tür |
|----------|--------------------------------------|:---:|------|
| `companies.name` | company_name, şirket adı, firma, company | ✅ | text |
| `companies.website` | website, web, url, site | ❌ | text |
| `companies.location` | location, konum, şehir, city, ülke | ❌ | text |
| `companies.industry` | industry, sektör, sector | ❌ | text |
| `companies.employee_count` | employee_count, çalışan sayısı, employees | ❌ | text |
| `companies.stage` | stage, durum, status, aşama | ❌ | text |
| `companies.deal_summary` | deal_summary, özet, summary | ❌ | text |
| `companies.next_step` | next_step, sonraki adım, follow_up | ❌ | text |
| `contacts.full_name` | contact_name, kişi adı, isim, name | ❌ | text |
| `contacts.title` | contact_title, pozisyon, title, ünvan | ❌ | text |
| `contacts.email` | contact_email, email, e-posta | ❌ | text |
| `contacts.phone_e164` | contact_phone, telefon, phone | ❌ | text |

#### Stage Değeri Eşleştirmesi (Türkçe → İngilizce)

> **DECISION-9:** Import sırasında Türkçe stage değerleri otomatik olarak İngilizce DB değerlerine çevrilir.
> Tanınmayan serbest metin değerler `custom_fields.original_stage`'e kaydedilir, stage `new` olarak atanır.

| CSV'deki Değer (Türkçe) | DB stage Değeri |
|--------------------------|-----------------|
| yeni | `new` |
| araştırılıyor, araştırma | `researching` |
| iletişime geçildi, görüşüldü | `contacted` |
| toplantı planlandı | `meeting_scheduled` |
| teklif gönderildi | `proposal_sent` |
| müzakere | `negotiation` |
| kazanıldı | `won` |
| kaybedildi, ilgilenmiyorlar, ilgilenmiyor, reddedildi, iptal | `lost` |
| beklemede, bekleniyor | `on_hold` |
| *(tanınmayan serbest metin)* | `new` + original → `custom_fields` |

#### Eşleşmeyen Kolonlar (DECISION — Senaryo B)

Dosyada DB'de karşılığı olmayan kolonlar varsa → `companies.custom_fields` JSONB alanına kaydedilir. Veri kaybı olmaz.

```json
// Örnek: custom_fields içeriği
{
  "sektor_kodu": "IT-500",
  "referans_no": "REF-2024-001",
  "ozel_not": "CEO ile tanışıklık var"
}
```

> Bu alanlar UI'da "Ek Bilgiler" bölümünde gösterilebilir. Export'ta da dahil edilir.

### 6.3 Dedup Stratejisi

| Seçenek | Açıklama | Trade-off |
|---------|---------|-----------|
| **Skip** | Aynı isim+website varsa satırı atla | Veri güncellenmez |
| **Update** | Aynı isim+website varsa mevcut kaydı güncelle | Eski veri üzerine yazılır |
| **Ask user** | Çakışmaları listele, kullanıcı seçsin | UX karmaşıklığı |

> **Öneri:** MVP'de **Update** varsayılan, skip opsiyonu checkbox ile.

### 6.4 Validation Hata Raporlama

```json
{
  "import_id": "uuid",
  "total_rows": 150,
  "success": 142,
  "errors": [
    { "row": 5, "field": "stage", "error": "Invalid stage value: 'aktif'. Valid: new, contacted, ..." },
    { "row": 23, "field": "contact_email", "error": "Invalid email format" },
    { "row": 89, "field": "company_name", "error": "Required field is empty" }
  ]
}
```

### 6.5 Güvenlik — Formula Injection

> ⚠️ Excel formula injection riski: `=CMD(...)` gibi değerler import sırasında sanitize edilmeli.

```javascript
// Pseudocode: her hücre değerinden leading =, +, -, @ kaldır
function sanitizeCell(value) {
  if (typeof value === 'string' && /^[=+\-@]/.test(value)) {
    return "'" + value; // prefix with single quote
  }
  return value;
}
```

---

## 7. Export Planı

### 7.1 CSV / XLSX Export

```
Kullanıcı filtre uygular → "Export" butonuna tıklar
        │
        ▼
  ┌─────────────┐
  │ Node API    │     Filtreleri alır, DB sorgular
  │ Export      │     Role-based field filtering (PII maskeleme)
  └──────┬──────┘
         │
         ▼
  ┌──────────────┐
  │ Generate     │     CSV: csv-stringify
  │ File         │     XLSX: exceljs
  └──────┬───────┘
         │
         ▼
  ┌──────────────┐
  │ Upload to    │     Supabase Storage → signed URL (expires in X min)
  │ Storage      │
  └──────┬───────┘
         │
         ▼
  ┌──────────────┐
  │ Audit Log    │     export_jobs tablosuna kayıt
  │ + Response   │     Client'a download URL döner
  └──────────────┘
```

### 7.2 PDF Export

| Seçenek | Açıklama | Karmaşıklık | Kalite |
|---------|---------|:-----------:|:------:|
| **A) Tablo PDF** | Filtrelenmiş leads tablosu → tek tablo PDF | Düşük | Orta |
| **B) Company Cards** | Her şirket için detaylı kart: contacts, status, timeline | Yüksek | Yüksek |
| **C) Hibrit** | Özet tablo + seçilen şirketler detay | Orta-Yüksek | Yüksek |

#### Teknoloji Seçenekleri

| Araç | Avantaj | Dezavantaj |
|------|---------|-----------|
| **Puppeteer / Playwright** | HTML→PDF, esnek tasarım | Server'da chromium gerekli, memory yüksek |
| **PDFKit** | Native Node.js, hafif | Manuel layout, karmaşık tasarım zor |
| **@react-pdf/renderer** | React component → PDF | İyi output, ama server-side rendering gerekli |
| **jsPDF + autoTable** | Client-side mümkün | Büyük data'da yavaş, client'ta güvenlik riski |

> **Öneri:** MVP'de **PDFKit + Seçenek A (tablo PDF)**. V4'te **Puppeteer + Seçenek B** değerlendirilsin.

### 7.3 Export Güvenlik

| Kontrol | Açıklama |
|---------|---------|
| Yetki kontrolü | Export API'si kullanıcının rolünü ve tenant_id'sini doğrular |
| Field redaction | `client_viewer` → email/phone masked, internal notes hariç |
| Audit log | Her export `export_jobs` tablosuna kaydedilir |
| Rate limit | Tenant başına: maks 10 export / saat |
| Signed URL | Download link'i X dakika sonra expire olur |
| Watermark (V4) | PDF footer'ında: "Confidential – [Tenant Name] – Exported by [User] – [Date]" |

---

## 8. UI Pages (Text Wireframe)

### Page 1: Leads Table (Ana Sayfa)

```
┌────────────────────────────────────────────────────────────┐
│  [Logo] LeadHub          [Tenant: Acme Corp]  [User ▼]    │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  [🔍 Search...]  [Stage ▼] [Industry ▼] [📥 Import] [📤 Export ▼] │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Company       │ Stage      │ Industry │ Next Step   │  │
│  │───────────────┼────────────┼──────────┼─────────────│  │
│  │ TechCo Ltd    │ 🟡 Meeting │ SaaS     │ Call Mon    │  │
│  │ DataFlow Inc  │ 🟢 Won     │ Fintech  │ Onboard     │  │
│  │ CloudBase     │ 🔴 Lost    │ Cloud    │ —           │  │
│  │ ...           │            │          │             │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
│  [← Prev]  Page 1 of 12  [Next →]     Showing 1–25 of 293 │
└────────────────────────────────────────────────────────────┘
```

**Kolonlar (minimum ama yeterli):**

| Kolon | Açıklama | Sortable | Filterable |
|-------|---------|:--------:|:----------:|
| Company Name | Şirket adı, clickable → detay | ✅ | ✅ (search) |
| Stage | Pipeline stage, renkli badge | ✅ | ✅ (multi-select) |
| Industry | Sektör | ✅ | ✅ (multi-select) |
| Location | Konum | ✅ | ✅ |
| Next Step | Sonraki aksiyon | ❌ | ❌ |
| Updated | Son güncelleme tarihi | ✅ | ❌ |

### Page 2: Company Detail

```
┌────────────────────────────────────────────────────────────┐
│  [← Leads]  TechCo Ltd                    [✏️ Edit] [🗑️]  │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  ┌─ Overview ────────────────────────────────────────────┐ │
│  │  Stage:    🟡 Meeting Scheduled    Industry: SaaS     │ │
│  │  Website:  techco.com              Location: Istanbul │ │
│  │  Employees: 50-200                                    │ │
│  │  Deal Summary: Looking for 500 leads in EU market     │ │
│  │  Next Step: Follow up call on Monday 10:00            │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                            │
│  ┌─ Contacts ────────────────────────────────────────────┐ │
│  │  👤 Ahmet Yılmaz (CTO)                               │ │
│  │     📧 ahmet@techco.com  📱 +90 555 XXX XX XX        │ │
│  │  👤 Elif Kaya (VP Sales)                              │ │
│  │     📧 elif@techco.com   📱 +90 532 XXX XX XX        │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                            │
│  ┌─ Activity Timeline (V1+) ─────────────────────────────┐ │
│  │  📞 Mar 3 – Call with Ahmet – Positive, wants proposal│ │
│  │  📧 Mar 1 – Email sent – Pricing document             │ │
│  │  📝 Feb 28 – Note – Internal: Budget confirmed        │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                            │
│  ┌─ Tasks ───────────────────────────────────────────────┐ │
│  │  ☐ Follow up call – Mar 10  – Assigned: Ops Agent    │ │
│  │  ☑ Send proposal – Mar 5    – Completed              │ │
│  └───────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────┘
```

### Page 3: Admin Panel (MVP Minimum)

```
┌────────────────────────────────────────────────────────────┐
│  Admin > User Management                                   │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  [+ Invite User]                                           │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ User           │ Email              │ Role        │ ⚙ │  │
│  │────────────────┼────────────────────┼─────────────┼───│  │
│  │ Ahmet Admin    │ ahmet@client.com   │ client_admin│ ✏️│  │
│  │ Elif Viewer    │ elif@client.com    │ client_viewer│ ✏️│  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

### Search/Filter/Sort Stratejisi

| Yaklaşım | Açıklama | Performans | Kalite |
|-----------|---------|:----------:|:------:|
| **ILIKE** | `WHERE name ILIKE '%query%'` | ⚠️ Yavaş (>10K row) | Düşük (partial match) |
| **Trigram (pg_trgm)** | `CREATE INDEX ... USING gin(name gin_trgm_ops)` | ✅ İyi | Orta (fuzzy) |
| **Full-text search** | `to_tsvector + tsquery` | ✅ İyi | Yüksek (relevance) |
| **External (Algolia/Typesense)** | Harici search engine | ✅ Çok iyi | Çok yüksek |

> **Karar (DECISION-5):** Tenant başına maks ~1K lead → MVP'de **basit `ILIKE`** yeterli, trigram index bile gerekmez. İleride veri büyürse FTS eklenebilir.

---

## 9. Versions / Stages Planı (V0–V5)

---

### V0 – Foundation

**Hedef:** Auth, tenant izolasyonu, temel CRUD

**Kapsam (In):**
- Supabase projesi kurulumu
- Auth: email/password login
- DB: `tenants`, `memberships`, `companies` tabloları + RLS
- Node API: auth middleware, companies CRUD endpoints
- React: login page, leads table (basit), company create/edit form
- Basit pagination (offset-based)
- **i18n altyapısı** (react-i18next veya next-intl) — DECISION-4
- `activities` tablosu DB'de oluşturulur (UI yok, ileride hazır) — DECISION-3

**Kapsam (Out):**
- Import/Export
- Contacts tablosu
- Activities / Tasks **UI**
- Search/Filter (sadece basit text search)

**DB Değişiklikleri:**
- `tenants`, `memberships`, `companies` (custom_fields JSONB dahil), `activities` tabloları oluştur
- RLS policies enable et
- Temel indexler

**UI Değişiklikleri:**
- Login sayfası
- Leads table (company name, stage, location, next step)
- Company create/edit modal

**Güvenlik Kontrolleri:**
- [ ] RLS enabled tüm tablolarda
- [ ] `service_role` key sadece Node API'de
- [ ] Tenant A, Tenant B verisine erişemez (test)
- [ ] CORS yapılandırması
- [ ] JWT validation middleware

**Kabul Kriterleri:**
1. Kullanıcı login olabilir
2. Kullanıcı sadece kendi tenant'ının company'lerini görebilir
3. Farklı tenant'ın verisine API üzerinden erişilemez
4. CRUD (create, read, update, delete) çalışır
5. Pagination çalışır (25 item/page)

**Riskler:**
- Supabase Auth custom claims (tenant_id) doğru set edilmeli
- RLS policy hataları → tenant leakage

**Sonraki sürüme taşıdıklarımız:** contacts, import, filter/sort

---

### V1 – Import + Contacts

**Hedef:** CSV/XLSX import, contacts tablosu

**Kapsam (In):**
- `contacts` tablosu + RLS
- CSV import endpoint (header mapping UI + fuzzy auto-match)
- XLSX import endpoint (header mapping UI + fuzzy auto-match)
- Eşleşmeyen kolonlar → `custom_fields JSONB` (DECISION-8)
- Import validation + error report UI
- Dedup: company name + website match → update
- Import job tracking (import_jobs tablosu)

**Kapsam (Out):**
- Full dynamic kolon mapping (advanced)
- Export
- Activity timeline

**DB Değişiklikleri:**
- `contacts` tablosu oluştur + RLS
- `import_jobs` tablosu oluştur

**UI Değişiklikleri:**
- File upload bileşeni
- Import progress/result sayfası
- Company detail sayfasına contacts bölümü

**Güvenlik Kontrolleri:**
- [ ] Import sadece `ops_agent` ve `superadmin` yetkili
- [ ] Formula injection sanitization
- [ ] Yüklenen dosya boyutu limiti (5MB)
- [ ] Import tenant_id doğrulama

**Kabul Kriterleri:**
1. CSV upload edince header mapping UI'ı gösterilir ve companies + contacts oluşur
2. Eşleşmeyen kolonlar `custom_fields`'e kaydedilir
3. Validation hataları kullanıcıya gösterilir
3. Duplicate company güncellenir (skip değil)
4. import_jobs kaydı oluşur

**Riskler:**
- Büyük dosya parsing performansı
- Encoding sorunları (UTF-8 / Windows-1254)

**Sonraki sürüme taşıdıklarımız:** search/filter/sort, dynamic mapping

---

### V2 – Search, Filter, Sort

**Hedef:** Server-side filtreleme, sıralama, gelişmiş arama

**Kapsam (In):**
- Server-side sorting (company name, stage, updated_at, location)
- Multi-select filter: stage, industry, location
- Text search (basit ILIKE — DECISION-5: maks ~1K row, yeterli)
- Updated_at sıralama

**Kapsam (Out):**
- Full-text search / trigram (1K row'da gereksiz)
- Saved filters
- Export

**DB Değişiklikleri:**
- Basit composite indexler (tenant_id + sort kolonu)
- Composite indexes for sort

**UI Değişiklikleri:**
- Search bar (debounced, 300ms)
- Filter dropdowns (multi-select)
- Sort headers on table columns
- Active filter chips

**Güvenlik Kontrolleri:**
- [ ] Search/filter query SQL injection koruması (parameterized queries)
- [ ] Tenant isolation filter'lardan bağımsız çalışır

**Kabul Kriterleri:**
1. "Tech" arandığında sadece tenant'ın kendi verileri gelir
2. Stage filtresinde birden fazla stage seçilebilir
3. Kolon başlığına tıklayınca ASC/DESC sıralama çalışır
4. ~1K row'da arama <200ms

**Riskler:**
- Minimal (1K row'da ILIKE performans sorunu beklenmez)

**Sonraki sürüme taşıdıklarımız:** export, saved filters

---

### V3 – Export CSV/XLSX

**Hedef:** Filtrelenmiş veriyi CSV ve XLSX olarak export

**Kapsam (In):**
- Export API endpoint (CSV + XLSX)
- Mevcut filtrelere göre export
- Role-based field redaction (client_viewer → PII maskeleme)
- `export_jobs` tablosu + audit log
- Supabase Storage'a yükleme + signed URL
- Rate limiting (tenant başına 10/saat)

**Kapsam (Out):**
- PDF export
- Watermark
- Scheduled exports

**DB Değişiklikleri:**
- `export_jobs` tablosu oluştur

**UI Değişiklikleri:**
- Export dropdown (CSV / XLSX)
- Export progress indicator
- Export history sayfası (opsiyonel)

**Güvenlik Kontrolleri:**
- [ ] Export yetki kontrolü (tüm roller export edebilir, field redaction farklı)
- [ ] Export audit log her export'u kaydediyor
- [ ] Rate limit çalışıyor
- [ ] Signed URL expire oluyor (30 dk)
- [ ] PII maskeleme doğru çalışıyor

**Kabul Kriterleri:**
1. Filtrelenmiş leads CSV olarak indirilebilir
2. XLSX formatında indirilebilir
3. `client_viewer` export'unda email/phone maskelenmis
4. Audit log'da export kaydı var
5. Rate limit aşılınca hata mesajı gösterilir

**Riskler:**
- Büyük export'larda memory/timeout
- Signed URL güvenliği

**Sonraki sürüme taşıdıklarımız:** PDF export, watermark

---

### V4 – PDF Export + Polish

**Hedef:** PDF export, watermark, UI polish

**Kapsam (In):**
- PDF export (Seçenek A: tablo PDF)
- PDF watermark: "Confidential – [Tenant] – [User] – [Date]"
- Company detail PDF (Seçenek B, opsiyonel)
- UI/UX iyileştirmeleri (loading states, empty states, error handling)
- Activity timeline basit versiyon (DB V0'da hazır, UI burada eklenir — DECISION-3)

**Kapsam (Out):**
- Role hardening
- Field-level redaction detay

**DB Değişiklikleri:**
- `activities` tablosu V0'da oluşturuldu, V4'te UI aktif
- `tasks` tablosu (opsiyonel)

**UI Değişiklikleri:**
- PDF export butonu + preview/options
- Timeline component (opsiyonel)
- Loading skeletons, error boundaries, empty states

**Güvenlik Kontrolleri:**
- [ ] PDF watermark doğru oluşuyor
- [ ] PDF export audit log + rate limit
- [ ] Activity visibility (internal vs client) doğru

**Kabul Kriterleri:**
1. Filtrelenmiş leads tablo şeklinde PDF olarak indirilebilir
2. PDF'de watermark var
3. PDF export audit log'a kaydedilir
4. Timeline (varsa) sadece uygun visibility'deki kayıtları gösterir

**Riskler:**
- Puppeteer server memory kullanımı
- PDF layout tutarlılığı

**Sonraki sürüme taşıdıklarımız:** role hardening, field-level redaction

---

### V5 – Roles & Permissions Hardening

**Hedef:** RBAC sertleştirme, field-level redaction, güvenlik audit

**Kapsam (In):**
- `client_viewer` vs `client_admin` vs `ops_agent` permission ayrımı sertleştirme
- Field-level redaction: `client_viewer` phone/email göremez
- `client_admin`: kendi tenant'ında kullanıcı invite/remove
- Admin panel: user management CRUD
- Comprehensive tenant isolation test suite
- Security audit checklist execution

**Kapsam (Out):**
- Apollo migration (Seçenek B data model)
- Scheduled reports
- Notifications

**DB Değişiklikleri:**
- RLS policy refinement
- Membership tablosuna invitation flow desteği (invite_token, invite_status)

**UI Değişiklikleri:**
- Admin panel: invite user flow (email invite)
- Role assignment UI
- field-level UI maskeleme

**Güvenlik Kontrolleri:**
- [ ] Her rol için tüm endpoint'ler test edildi
- [ ] Field redaction API + UI'da tutarlı
- [ ] Invite token güvenli, expire olan
- [ ] Tüm tenant isolation testleri geçiyor
- [ ] Penetration testing checklist

**Kabul Kriterleri:**
1. `client_viewer` internal notes göremez
2. `client_viewer` phone/email masked görür
3. `client_admin` kullanıcı invite edebilir
4. `ops_agent` CRUD yapabilir ama user management yapamaz
5. Tenant A kullanıcısı, Tenant B verisine hiçbir şekilde erişemez

**Riskler:**
- Role migration sırasında mevcut kullanıcılar etkilenebilir
- Invite flow email delivery

---

## 10. Security Pitfalls & How to Test

### 10.1 Tenant Leakage Testleri

Bu MVP'nin **#1 güvenlik tehdidi**. Test stratejisi:

```javascript
// Pseudocode: Her API endpoint için
describe('Tenant Isolation', () => {
  const tenantA = createTestTenant('A');
  const tenantB = createTestTenant('B');
  const userA = createUser(tenantA, 'ops_agent');
  const userB = createUser(tenantB, 'ops_agent');

  test('User A cannot list Tenant B companies', async () => {
    const companyB = await createCompany(tenantB, { name: 'Secret Corp' });
    const response = await api.get('/companies', { auth: userA.token });
    expect(response.data).not.toContainEqual(
      expect.objectContaining({ id: companyB.id })
    );
  });

  test('User A cannot access Tenant B company by ID', async () => {
    const companyB = await createCompany(tenantB, { name: 'Secret Corp' });
    const response = await api.get(`/companies/${companyB.id}`, { auth: userA.token });
    expect(response.status).toBe(404); // 403 değil, 404 (bilgi sızdırmaz)
  });

  test('User A cannot update Tenant B company', async () => {
    const companyB = await createCompany(tenantB, { name: 'Secret Corp' });
    const response = await api.put(`/companies/${companyB.id}`, 
      { name: 'Hacked' }, { auth: userA.token });
    expect(response.status).toBe(404);
  });

  test('User A export does not contain Tenant B data', async () => {
    // ... export ve içerik doğrulama
  });
});
```

### 10.2 RLS Verification

```sql
-- CI/CD'de çalıştırılacak kontrol sorgusu
-- Tüm data tablolarında RLS'nin aktif olduğunu doğrular
SELECT tablename, rowsecurity 
FROM pg_tables 
WHERE schemaname = 'public'
  AND tablename IN ('companies','contacts','activities','tasks',
                     'import_jobs','export_jobs','memberships')
  AND rowsecurity = false;
-- Sonuç 0 satır olmalı
```

### 10.3 Güvenlik Test Matrisi

| Test Kategorisi | Ne Test Edilir | Nasıl | Sürüm |
|----------------|---------------|-------|-------|
| Tenant isolation | Cross-tenant data access | API integration tests | V0+ |
| RLS coverage | Tüm tablolarda RLS enabled | SQL check in CI | V0+ |
| Auth bypass | Token olmadan API erişimi | Unauthenticated request tests | V0 |
| Role enforcement | client_viewer CRUD yapamaz | Role-based API tests | V0, V5 |
| XSS | Script injection in notes | Input sanitization tests | V0 |
| Formula injection | CSV import `=CMD()` | Import sanitization tests | V1 |
| Export leakage | Export field redaction | Export content verification | V3 |
| Rate limiting | Aşırı export engellenir | Burst test | V3 |
| service_role key | Client bundle'da yokluğu | Build output grep | V0 |
| CORS | Unauthorized origin reject | Cross-origin request test | V0 |
| SQL injection | Parameterized query kontrol | Malicious input tests | V0+ |

### 10.4 "service_role" Key Sızma Kontrolü

```bash
# CI'da çalıştır: client build output'unda service_role key var mı?
grep -r "service_role" ./client/build/ && echo "FAIL: service_role key found in client bundle!" && exit 1
echo "PASS: no service_role key in client bundle"
```

---

## Appendix: Teknoloji Stack Özeti

| Katman | Teknoloji | Neden |
|--------|----------|-------|
| **Frontend** | React (Vite) | Hızlı dev, popüler ekosistem |
| **UI Kit** | Mantine / Ant Design / shadcn/ui | Tablo, form, drawer component'leri hazır |
| **State Management** | TanStack Query (React Query) | Server state caching, pagination, refetch |
| **i18n** | react-i18next / next-intl | Baştan çoklu dil desteği (DECISION-4) |
| **Backend** | Node.js (Express veya Fastify) | Ekip deneyimi, Supabase JS SDK uyumu |
| **DB** | Supabase Postgres + RLS | Auth, realtime, storage hep bir arada |
| **Auth** | Supabase Auth | JWT, email/password, SSO (ileride) |
| **File Storage** | Supabase Storage | Import dosyaları, export output'ları |
| **PDF** | PDFKit (MVP) → Puppeteer (V4) | Hafif başla, ileride esnek |
| **CSV/XLSX Parse** | papaparse + exceljs | Kanıtlanmış kütüphaneler |
| **Deployment** | Vercel (React) + Railway/Fly.io (API) | Kolay, ucuz, scalable |

---

> **Bu döküman canlıdır.** ~~Open Questions cevaplanınca güncellenecektir.~~ **Tüm sorular cevaplandı** (PDF formatı hariç — bekliyor).
> Son güncelleme: 2026-03-05T05:44
