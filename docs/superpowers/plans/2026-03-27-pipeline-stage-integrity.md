# Pipeline Stage Referential Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a composite FK from `companies(tenant_id, stage)` to `pipeline_stages(tenant_id, slug)` and replace the existing hard-delete stage flow with a soft-deactivate flow featuring a company migration modal.

**Architecture:** DB migration adds the FK constraint with ON UPDATE CASCADE / ON DELETE RESTRICT. Server gets two new endpoints (`GET .../companies`, `POST .../deactivate`) in `settings.ts` plus a 409 guard on the existing DELETE handler. Client gets a new `DeactivateStageModal` component wired into `PipelineSettingsEditor`.

**Tech Stack:** PostgreSQL (Supabase), Express.js + Zod, React 19 + Mantine UI + TanStack Query

**Spec:** `docs/superpowers/specs/2026-03-27-pipeline-stage-integrity-design.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `supabase/migrations/015_pipeline_stage_fk.sql` | **Create** | Pre-flight orphan check + composite FK constraint |
| `server/src/routes/admin.ts` | **Modify** | Export `logAuditAction` so settings.ts can import it |
| `server/src/routes/settings.ts` | **Modify** | Add GET companies endpoint, POST deactivate endpoint, 409 guard on DELETE |
| `client/src/components/DeactivateStageModal.tsx` | **Create** | Self-contained modal: company list + target stage selects + bulk action + confirm |
| `client/src/components/PipelineSettingsEditor.tsx` | **Modify** | Add Deactivate button to pipeline/terminal stage rows, wire DeactivateStageModal |

---

## Task 1: Database Migration

**Files:**
- Create: `supabase/migrations/015_pipeline_stage_fk.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/015_pipeline_stage_fk.sql
-- Add composite FK: companies(tenant_id, stage) → pipeline_stages(tenant_id, slug)

-- Pre-flight: fail if orphaned stage values exist
DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM companies c
    WHERE NOT EXISTS (
      SELECT 1 FROM pipeline_stages ps
      WHERE ps.tenant_id = c.tenant_id AND ps.slug = c.stage
    )
  ) = 0, 'Orphaned stage values found — fix before adding FK';
END $$;

ALTER TABLE companies
  ADD CONSTRAINT fk_companies_stage
  FOREIGN KEY (tenant_id, stage)
  REFERENCES pipeline_stages(tenant_id, slug)
  ON UPDATE CASCADE
  ON DELETE RESTRICT;
```

- [ ] **Step 2: Apply the migration to Supabase**

Use the Supabase MCP tool `apply_migration`:
- `project_id`: `ehnbhkxmsdticaodndvy`
- `name`: `015_pipeline_stage_fk`
- `query`: contents of the file above

Expected: `{ success: true }`

If the ASSERT fails (orphaned stage values found), run this query to identify them before retrying:
```sql
SELECT c.tenant_id, c.stage, COUNT(*)
FROM companies c
LEFT JOIN pipeline_stages ps ON ps.tenant_id = c.tenant_id AND ps.slug = c.stage
WHERE ps.id IS NULL
GROUP BY c.tenant_id, c.stage;
```

- [ ] **Step 3: Verify the constraint was created**

```sql
SELECT constraint_name, constraint_type
FROM information_schema.table_constraints
WHERE table_name = 'companies' AND constraint_name = 'fk_companies_stage';
```

Expected: one row with `constraint_type = 'FOREIGN KEY'`

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/015_pipeline_stage_fk.sql
git commit -m "feat(db): add composite FK companies(tenant_id,stage) → pipeline_stages(tenant_id,slug)"
```

---

## Task 2: Export logAuditAction from admin.ts

`logAuditAction` is currently a module-private function in `server/src/routes/admin.ts`. The deactivate endpoint in `settings.ts` needs it.

**Files:**
- Modify: `server/src/routes/admin.ts` — change `async function logAuditAction` to `export async function logAuditAction`

- [ ] **Step 1: Export the function**

In `server/src/routes/admin.ts`, change line 17:
```ts
// Before
async function logAuditAction(
// After
export async function logAuditAction(
```

That's the only change needed. The function signature and body stay exactly the same.

- [ ] **Step 2: Verify the server still compiles**

```bash
cd server && npx tsc --noEmit
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/admin.ts
git commit -m "refactor(server): export logAuditAction from admin router"
```

---

## Task 3: Server — GET /api/settings/stages/:slug/companies

Add endpoint to `server/src/routes/settings.ts`.

**Files:**
- Modify: `server/src/routes/settings.ts`

- [ ] **Step 1: Add the import for logAuditAction at the top of settings.ts**

Find the existing imports block and add:
```ts
import { logAuditAction } from './admin.js';
```

- [ ] **Step 2: Add the GET endpoint**

Add this route after the existing `DELETE /stages/:slug` handler (before the `// ─── Pipeline Groups` comment block):

```ts
// GET /api/settings/stages/:slug/companies — companies in a stage (for deactivation modal)
router.get('/stages/:slug/companies', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        if (!isAdmin(req.user!.role)) {
            res.status(403).json({ error: 'Insufficient permissions' });
            return;
        }

        const { slug } = req.params;

        // Verify stage belongs to this tenant
        const { data: stage, error: stageError } = await supabaseAdmin
            .from('pipeline_stages')
            .select('id, slug, display_name, stage_type')
            .eq('tenant_id', tenantId)
            .eq('slug', slug)
            .single();

        if (stageError || !stage) {
            res.status(404).json({ error: 'Stage not found' });
            return;
        }

        const { data: companies, error: companiesError } = await supabaseAdmin
            .from('companies')
            .select('id, name')
            .eq('tenant_id', tenantId)
            .eq('stage', slug)
            .order('name');

        if (companiesError) {
            log.error({ err: companiesError }, 'Failed to fetch companies for stage');
            throw new AppError('Failed to fetch companies', 500);
        }

        res.json({ stage, companies: companies || [] });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Get stage companies error');
        res.status(500).json({ error: 'Failed to fetch companies' });
    }
});
```

- [ ] **Step 3: Verify the server compiles**

```bash
cd server && npx tsc --noEmit
```

Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/settings.ts
git commit -m "feat(server): GET /api/settings/stages/:slug/companies"
```

---

## Task 4: Server — POST /api/settings/stages/:slug/deactivate

**Files:**
- Modify: `server/src/routes/settings.ts`

- [ ] **Step 1: Add Zod import at the top of settings.ts**

Zod is not currently imported in `settings.ts`. Add this line to the imports block at the top of the file:

```ts
import { z } from 'zod';
```

- [ ] **Step 2: Add the deactivate endpoint**

Add this route immediately after the GET companies endpoint added in Task 3:

```ts
// POST /api/settings/stages/:slug/deactivate — soft-delete a stage, migrate companies
const deactivateSchema = z.object({
    migrations: z.array(z.object({
        companyId: z.string().uuid(),
        targetStage: z.string().min(1),
    })),
});

router.post('/stages/:slug/deactivate', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const tenantId = req.tenantId!;
        if (!isAdmin(req.user!.role)) {
            res.status(403).json({ error: 'Insufficient permissions' });
            return;
        }

        const { slug } = req.params;

        // Parse and validate body
        const parsed = deactivateSchema.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten() });
            return;
        }
        const { migrations } = parsed.data;

        // Verify stage belongs to this tenant
        const { data: stage, error: stageError } = await supabaseAdmin
            .from('pipeline_stages')
            .select('id, slug, stage_type')
            .eq('tenant_id', tenantId)
            .eq('slug', slug)
            .single();

        if (stageError || !stage) {
            res.status(404).json({ error: 'Stage not found' });
            return;
        }

        // Block deactivation of initial stage
        if (stage.stage_type === 'initial') {
            res.status(400).json({ error: 'Cannot deactivate the initial stage' });
            return;
        }

        // Resolve tenant's initial stage slug for fallback
        const tenantStages = await getTenantStages(tenantId);
        const initialStageSlug = tenantStages.find((s) => s.stage_type === 'initial')?.slug;
        if (!initialStageSlug) {
            res.status(500).json({ error: 'Tenant has no initial stage configured' });
            return;
        }

        // Validate all targetStage values
        const activeSlugs = new Set(tenantStages.map((s) => s.slug));
        for (const m of migrations) {
            if (!activeSlugs.has(m.targetStage)) {
                res.status(422).json({ error: `Target stage "${m.targetStage}" is not active or does not exist` });
                return;
            }
            if (m.targetStage === slug) {
                res.status(400).json({ error: `Cannot migrate companies to the stage being deactivated` });
                return;
            }
        }

        // Apply explicit migrations
        let companiesMoved = 0;
        for (const m of migrations) {
            const { error: migrateError } = await supabaseAdmin
                .from('companies')
                .update({ stage: m.targetStage, updated_at: new Date().toISOString() })
                .eq('id', m.companyId)
                .eq('tenant_id', tenantId);

            if (migrateError) {
                log.error({ err: migrateError, companyId: m.companyId }, 'Failed to migrate company');
                throw new AppError('Failed to migrate company', 500);
            }
            companiesMoved++;
        }

        // Move remaining companies in this stage to the initial stage
        const { count: remainingCount, error: remainCountError } = await supabaseAdmin
            .from('companies')
            .select('*', { count: 'exact', head: true })
            .eq('tenant_id', tenantId)
            .eq('stage', slug);

        if (remainCountError) throw new AppError('Failed to count remaining companies', 500);

        if ((remainingCount || 0) > 0) {
            const { error: fallbackError } = await supabaseAdmin
                .from('companies')
                .update({ stage: initialStageSlug, updated_at: new Date().toISOString() })
                .eq('tenant_id', tenantId)
                .eq('stage', slug);

            if (fallbackError) {
                log.error({ err: fallbackError }, 'Failed to move remaining companies to initial stage');
                throw new AppError('Failed to reassign remaining companies', 500);
            }
            companiesMoved += remainingCount || 0;
        }

        // Deactivate the stage
        const { error: deactivateError } = await supabaseAdmin
            .from('pipeline_stages')
            .update({ is_active: false })
            .eq('tenant_id', tenantId)
            .eq('slug', slug);

        if (deactivateError) {
            log.error({ err: deactivateError }, 'Failed to deactivate stage');
            throw new AppError('Failed to deactivate stage', 500);
        }

        invalidateStageCache(tenantId);

        // Audit log
        await logAuditAction(req.user!.id, 'stage.deactivate', 'pipeline_stage', stage.id, {
            slug,
            companiesMoved,
        });

        res.json({ deactivated: slug, companiesMoved });
    } catch (err) {
        if (err instanceof AppError) return next(err);
        log.error({ err }, 'Deactivate stage error');
        res.status(500).json({ error: 'Failed to deactivate stage' });
    }
});
```

- [ ] **Step 3: Verify the server compiles**

```bash
cd server && npx tsc --noEmit
```

Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/settings.ts
git commit -m "feat(server): POST /api/settings/stages/:slug/deactivate with company migration"
```

---

## Task 5: Server — Guard DELETE endpoint against FK violation

After the FK is in place, calling `DELETE /api/settings/stages/:slug` for a stage that still has companies will fail at the DB level with Postgres error code `23503`. Catch it and return a clear 409.

**Files:**
- Modify: `server/src/routes/settings.ts` — the `DELETE /stages/:slug` handler

- [ ] **Step 1: Add FK error handling to the DELETE handler**

Find the `DELETE /stages/:slug` handler. Locate the `deleteError` block (currently around line 315–326):

```ts
// Before
const { error: deleteError } = await supabaseAdmin
    .from('pipeline_stages')
    .delete()
    .eq('tenant_id', tenantId)
    .eq('slug', slug);

if (deleteError) {
    log.error({ err: deleteError }, 'Delete stage error');
    throw new AppError('Failed to delete stage', 500);
}
```

Replace with:

```ts
const { error: deleteError } = await supabaseAdmin
    .from('pipeline_stages')
    .delete()
    .eq('tenant_id', tenantId)
    .eq('slug', slug);

if (deleteError) {
    // FK violation: stage still referenced by companies
    if ((deleteError as any).code === '23503') {
        res.status(409).json({ error: 'Stage has companies — use POST /api/settings/stages/' + slug + '/deactivate' });
        return;
    }
    log.error({ err: deleteError }, 'Delete stage error');
    throw new AppError('Failed to delete stage', 500);
}
```

- [ ] **Step 2: Verify the server compiles**

```bash
cd server && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/settings.ts
git commit -m "fix(server): return 409 instead of 500 when DELETE stage hits FK constraint"
```

---

## Task 6: Client — DeactivateStageModal component

Create a self-contained modal component. It manages its own state (loading, per-company target selections).

**Files:**
- Create: `client/src/components/DeactivateStageModal.tsx`

- [ ] **Step 1: Create the component**

```tsx
// client/src/components/DeactivateStageModal.tsx
import { useState, useEffect } from 'react';
import {
    Modal, Stack, Text, Button, Group, Select,
    ScrollArea, Table, Tooltip, Loader, Center,
} from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import api from '../lib/api';
import { showSuccess, showErrorFromApi } from '../lib/notifications';
import { useStages } from '../contexts/StagesContext';

interface Props {
    stageSlug: string | null;       // null = closed
    stageName: string;
    onClose: () => void;
    onSuccess: () => void;
}

interface CompanyRow {
    id: string;
    name: string;
}

export default function DeactivateStageModal({ stageSlug, stageName, onClose, onSuccess }: Props) {
    const { t } = useTranslation();
    const { allStages, initialStage, getStageLabel } = useStages();

    // Per-company target stage selection: { [companyId]: targetSlug | null }
    const [selections, setSelections] = useState<Record<string, string | null>>({});

    // Fetch companies in this stage when modal opens
    const { data, isLoading } = useQuery({
        queryKey: ['stage-companies', stageSlug],
        queryFn: async () => {
            const res = await api.get(`/settings/stages/${stageSlug}/companies`);
            return res.data as { stage: { id: string; slug: string; display_name: string }; companies: CompanyRow[] };
        },
        enabled: !!stageSlug,
    });

    // Reset selections when a new stage is loaded
    useEffect(() => {
        if (data?.companies) {
            const initial: Record<string, string | null> = {};
            data.companies.forEach((c) => { initial[c.id] = null; });
            setSelections(initial);
        }
    }, [data]);

    const companies = data?.companies || [];
    const pendingCount = Object.values(selections).filter((v) => v === null).length;
    const allAssigned = companies.length > 0 && pendingCount === 0;

    // Target stage options: active stages excluding the stage being deactivated
    const targetOptions = allStages
        .filter((s) => s.is_active && s.slug !== stageSlug)
        .map((s) => ({ value: s.slug, label: getStageLabel(s.slug) }));

    const moveAllToInitial = () => {
        if (!initialStage) return;
        const updated: Record<string, string | null> = {};
        companies.forEach((c) => { updated[c.id] = initialStage.slug; });
        setSelections(updated);
    };

    const deactivateMutation = useMutation({
        mutationFn: async () => {
            const migrations = Object.entries(selections)
                .filter(([, targetStage]) => targetStage !== null)
                .map(([companyId, targetStage]) => ({ companyId, targetStage: targetStage! }));
            await api.post(`/settings/stages/${stageSlug}/deactivate`, { migrations });
        },
        onSuccess: () => {
            showSuccess(t('pipelineSettings.stageDeactivated', 'Aşama devre dışı bırakıldı'));
            onSuccess();
        },
        onError: (err) => {
            showErrorFromApi(err, t('pipelineSettings.saveError'));
        },
    });

    if (!stageSlug) return null;

    return (
        <Modal
            opened={!!stageSlug}
            onClose={onClose}
            title={t('pipelineSettings.deactivateTitle', { name: stageName })}
            size="lg"
            closeOnClickOutside={!deactivateMutation.isPending}
            closeOnEscape={!deactivateMutation.isPending}
        >
            <Stack gap="md">
                {isLoading ? (
                    <Center py="xl"><Loader size="sm" /></Center>
                ) : companies.length === 0 ? (
                    <Text size="sm" c="dimmed">
                        {t('pipelineSettings.noCompaniesInStage', 'Bu aşamada şirket yok. Doğrudan devre dışı bırakılacak.')}
                    </Text>
                ) : (
                    <>
                        <Group justify="space-between" align="center">
                            <Text size="sm" c="dimmed">
                                {t('pipelineSettings.companiesInStage', { count: companies.length })}
                            </Text>
                            <Button
                                variant="light"
                                size="xs"
                                onClick={moveAllToInitial}
                                disabled={!initialStage}
                            >
                                {t('pipelineSettings.moveAllToInitial', { stage: initialStage ? getStageLabel(initialStage.slug) : '' })}
                            </Button>
                        </Group>

                        <ScrollArea.Autosize mah={340}>
                            <Table striped highlightOnHover>
                                <Table.Tbody>
                                    {companies.map((company) => (
                                        <Table.Tr key={company.id}>
                                            <Table.Td style={{ width: '50%' }}>
                                                <Text size="sm" fw={500}>{company.name}</Text>
                                            </Table.Td>
                                            <Table.Td>
                                                <Select
                                                    placeholder={t('pipelineSettings.selectStage', 'Aşama seç')}
                                                    data={targetOptions}
                                                    value={selections[company.id] ?? null}
                                                    onChange={(val) => setSelections((prev) => ({ ...prev, [company.id]: val }))}
                                                    size="xs"
                                                    clearable={false}
                                                />
                                            </Table.Td>
                                        </Table.Tr>
                                    ))}
                                </Table.Tbody>
                            </Table>
                        </ScrollArea.Autosize>
                    </>
                )}

                <Group justify="flex-end" mt="xs">
                    <Button variant="subtle" color="gray" onClick={onClose} disabled={deactivateMutation.isPending}>
                        {t('common.cancel', 'İptal')}
                    </Button>
                    <Tooltip
                        label={t('pipelineSettings.deactivateDisabledTooltip', { count: pendingCount })}
                        disabled={allAssigned || companies.length === 0}
                    >
                        <Button
                            color="orange"
                            onClick={() => deactivateMutation.mutate()}
                            loading={deactivateMutation.isPending}
                            disabled={companies.length > 0 && !allAssigned}
                        >
                            {t('pipelineSettings.deactivateConfirm', 'Devre Dışı Bırak')}
                        </Button>
                    </Tooltip>
                </Group>
            </Stack>
        </Modal>
    );
}
```

- [ ] **Step 2: Verify TypeScript compilation**

```bash
cd client && npx tsc --noEmit
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add client/src/components/DeactivateStageModal.tsx
git commit -m "feat(client): DeactivateStageModal component"
```

---

## Task 7: Client — Wire DeactivateStageModal into PipelineSettingsEditor

**Files:**
- Modify: `client/src/components/PipelineSettingsEditor.tsx`

- [ ] **Step 1: Import the modal**

Add at the top of `PipelineSettingsEditor.tsx`:
```ts
import DeactivateStageModal from './DeactivateStageModal';
```

- [ ] **Step 2: Add deactivate state**

Inside `PipelineSettingsEditor` component, after the existing `deleteSlug` state declarations, add:

```ts
const [deactivateSlug, setDeactivateSlug] = useState<string | null>(null);
const [deactivateStageName, setDeactivateStageName] = useState('');
```

- [ ] **Step 3: Add Deactivate button to SortableStageRow**

The `SortableStageRow` component already has `onDelete` prop. Add `onDeactivate` alongside it.

`SortableStageRow` uses an inline destructured parameter (not a named interface) starting at line 61. In that function signature, add `onDeactivate: () => void;` after `onDelete: () => void;`:

```ts
// Before (line ~76)
    onDelete: () => void;
}) {
// After
    onDelete: () => void;
    onDeactivate: () => void;
}) {
```

In the `SortableStageRow` JSX, after the existing delete ActionIcon, add:
```tsx
<Tooltip label={t('pipelineSettings.deactivate', 'Devre Dışı Bırak')}>
    <ActionIcon variant="subtle" color="orange" size="xs" onClick={onDeactivate}>
        <IconBan size={12} />
    </ActionIcon>
</Tooltip>
```

Add `IconBan` to the existing `@tabler/icons-react` import line.

- [ ] **Step 4: Add a deactivate handler**

Inside `PipelineSettingsEditor`, add:
```ts
const handleDeactivate = (stage: StageDefinition) => {
    setDeactivateSlug(stage.slug);
    setDeactivateStageName(getStageLabel(stage.slug));
};
```

- [ ] **Step 5: Pass onDeactivate to each SortableStageRow**

Find all `<SortableStageRow ... />` usages and add:
```tsx
onDeactivate={() => handleDeactivate(stg)}
```

- [ ] **Step 6: Render DeactivateStageModal at the bottom of the component**

After the existing `{/* ═══ Delete Modal ═══ */}` block, add:

```tsx
{/* ═══ Deactivate Modal ═══ */}
<DeactivateStageModal
    stageSlug={deactivateSlug}
    stageName={deactivateStageName}
    onClose={() => setDeactivateSlug(null)}
    onSuccess={() => {
        setDeactivateSlug(null);
        invalidateAll();
    }}
/>
```

- [ ] **Step 7: Verify TypeScript compilation**

```bash
cd client && npx tsc --noEmit
```

Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add client/src/components/PipelineSettingsEditor.tsx
git commit -m "feat(client): wire DeactivateStageModal into PipelineSettingsEditor"
```

---

## Task 8: i18n Keys

**Files:**
- Modify: `client/src/i18n/locales/tr.json`
- Modify: `client/src/i18n/locales/en.json`

- [ ] **Step 1: Add new keys to Turkish locale**

In `client/src/i18n/locales/tr.json`, find the `pipelineSettings` object and add:

```json
"deactivate": "Devre Dışı Bırak",
"deactivateTitle": "{{name}} aşamasını devre dışı bırak",
"noCompaniesInStage": "Bu aşamada şirket yok. Doğrudan devre dışı bırakılacak.",
"companiesInStage": "{{count}} şirket bu aşamada",
"moveAllToInitial": "Tümünü {{stage}}'e Taşı",
"selectStage": "Aşama seç",
"stageDeactivated": "Aşama devre dışı bırakıldı",
"deactivateDisabledTooltip": "{{count}} şirket hâlâ bu aşamada",
"deactivateConfirm": "Devre Dışı Bırak"
```

- [ ] **Step 2: Add new keys to English locale**

In `client/src/i18n/locales/en.json`, find the `pipelineSettings` object and add:

```json
"deactivate": "Deactivate",
"deactivateTitle": "Deactivate stage: {{name}}",
"noCompaniesInStage": "No companies in this stage. It will be deactivated immediately.",
"companiesInStage": "{{count}} companies in this stage",
"moveAllToInitial": "Move all to {{stage}}",
"selectStage": "Select stage",
"stageDeactivated": "Stage deactivated",
"deactivateDisabledTooltip": "{{count}} companies still in this stage",
"deactivateConfirm": "Deactivate"
```

- [ ] **Step 3: Commit**

```bash
git add client/src/i18n/locales/tr.json client/src/i18n/locales/en.json
git commit -m "feat(i18n): add pipeline stage deactivation translation keys"
```

---

## Task 9: Manual Smoke Test

Start the dev server and verify the flow end-to-end.

```bash
npm run dev
```

- [ ] Open Pipeline Settings (Admin Panel → Pipeline Settings)
- [ ] Verify initial stage (`Cold`) has **no** Deactivate button (it renders via `renderSimpleStageRow`, not `SortableStageRow`)
- [ ] Verify terminal stages (`Won`, `Lost`, `On Hold`) also have **no** Deactivate button (same reason)
- [ ] Click Deactivate on a pipeline stage that has **0 companies** → deactivates immediately, no modal, success toast
- [ ] Click Deactivate on a pipeline stage that has **>0 companies** → modal opens with company list
- [ ] Click "Tümünü Cold'a Taşı" → all dropdowns fill with the initial stage
- [ ] "Deactivate Et" button becomes enabled → click → success toast
- [ ] Deactivated stage disappears from the pipeline board
- [ ] Deactivated stage does not appear in company stage dropdowns

- [ ] **Final commit if any fixes were needed during smoke test**

```bash
git add -p
git commit -m "fix(pipeline-stage-integrity): smoke test fixes"
```
