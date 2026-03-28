# Company Detail Field Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-user, localStorage-backed field visibility toggle to the company detail page info grid.

**Architecture:** All logic lives in `CompanyDetailPage.tsx` — a `DETAIL_FIELDS` constant, two small localStorage helpers, two state variables, a toggle handler, a Mantine Popover trigger button, and conditional rendering on each grid field. No new files, no backend changes.

**Tech Stack:** React 19, Mantine UI (Popover, Checkbox, ActionIcon, Tooltip, Group, Text), @tabler/icons-react (IconEyeOff), i18next, localStorage.

> **Note:** No test runner is configured in this project (`CLAUDE.md` confirms this). TDD steps are omitted. Manual verification instructions are included instead.

---

## File Map

| File | Action |
|---|---|
| `client/src/pages/CompanyDetailPage.tsx` | Modify — add constant, helpers, state, handler, button+popover, conditional renders |
| `client/src/locales/tr.json` | Modify — add 3 translation keys |
| `client/src/locales/en.json` | Modify — add 3 translation keys |

---

### Task 1: Add translation keys

**Files:**
- Modify: `client/src/locales/tr.json`
- Modify: `client/src/locales/en.json`

- [ ] **Step 1: Add keys to tr.json**

Open `client/src/locales/tr.json`. Inside the `"company"` object, add three keys after `"customFields"`:

```json
"fieldVisibility": "Görünen Alanlar",
"resetFields": "Varsayılana sıfırla",
"editFields": "Alanları düzenle",
```

- [ ] **Step 2: Add keys to en.json**

Open `client/src/locales/en.json`. Inside the `"company"` object, add three keys in the same position:

```json
"fieldVisibility": "Visible Fields",
"resetFields": "Reset to default",
"editFields": "Edit fields",
```

- [ ] **Step 3: Verify**

Run the dev server (`npm run dev:client`) and open any company detail page. No visible change expected yet — just confirming no JSON parse errors.

- [ ] **Step 4: Commit**

```bash
git add client/src/locales/tr.json client/src/locales/en.json
git commit -m "i18n: add field visibility translation keys"
```

---

### Task 2: Add DETAIL_FIELDS constant and localStorage helpers

**Files:**
- Modify: `client/src/pages/CompanyDetailPage.tsx` (above the `CompanyDetailPage` component function, near the top of the file after imports)

- [ ] **Step 1: Add the constant and helpers**

After the existing `interface Company { ... }` block (around line 101), add:

```ts
const DETAIL_FIELDS = [
    { key: 'company_summary',   labelKey: 'company.companySummary' },
    { key: 'product_services',  labelKey: 'company.productServices' },
    { key: 'product_portfolio', labelKey: 'company.productPortfolio' },
    { key: 'next_step',         labelKey: 'company.nextStep' },
    { key: 'fit_score',         labelKey: 'company.fitScore' },
    { key: 'custom_field_1',    labelKey: null },
    { key: 'custom_field_2',    labelKey: null },
    { key: 'custom_field_3',    labelKey: null },
] as const;

type DetailFieldKey = typeof DETAIL_FIELDS[number]['key'];

const FIELD_VISIBILITY_KEY = 'company_detail_field_visibility';

function loadFieldVisibility(): Set<string> {
    try {
        const stored = localStorage.getItem(FIELD_VISIBILITY_KEY);
        return stored ? new Set(JSON.parse(stored) as string[]) : new Set();
    } catch {
        return new Set();
    }
}

function saveFieldVisibility(hidden: Set<string>): void {
    localStorage.setItem(FIELD_VISIBILITY_KEY, JSON.stringify([...hidden]));
}
```

- [ ] **Step 2: Verify the file compiles**

```bash
cd client && npm run lint
```

Expected: no errors related to the new code.

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/CompanyDetailPage.tsx
git commit -m "feat: add DETAIL_FIELDS constant and localStorage helpers"
```

---

### Task 3: Add state and toggle handler inside the component

**Files:**
- Modify: `client/src/pages/CompanyDetailPage.tsx` (inside `CompanyDetailPage` function, after existing state declarations)

- [ ] **Step 1: Add state variables**

Inside `CompanyDetailPage`, after the existing `const [showTranslation, setShowTranslation] = useState(false);` line (around line 201), add:

```ts
const [hiddenFields, setHiddenFields] = useState<Set<string>>(() => loadFieldVisibility());
const [fieldPopoverOpen, setFieldPopoverOpen] = useState(false);
```

- [ ] **Step 2: Add toggle and reset handlers**

After the `translateMutation` block (around line 219), add:

```ts
const toggleField = (key: DetailFieldKey) => {
    const next = new Set(hiddenFields);
    if (next.has(key)) next.delete(key); else next.add(key);
    setHiddenFields(next);
    saveFieldVisibility(next);
};

const resetFields = () => {
    setHiddenFields(new Set());
    saveFieldVisibility(new Set());
};
```

- [ ] **Step 3: Verify lint**

```bash
cd client && npm run lint
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/CompanyDetailPage.tsx
git commit -m "feat: add field visibility state and handlers"
```

---

### Task 4: Add the trigger button and popover

**Files:**
- Modify: `client/src/pages/CompanyDetailPage.tsx`

- [ ] **Step 1: Add IconEyeOff to imports**

Find the existing `@tabler/icons-react` import block (around line 34). Add `IconEyeOff` to the list:

```ts
import {
    ...
    IconEyeOff,
    ...
} from '@tabler/icons-react';
```

- [ ] **Step 2: Add Popover to Mantine imports**

`Popover` is not yet imported. Find the existing Mantine import block (around line 5) and add `Popover` to the list:

```ts
import {
    ...
    Popover,
    ...
} from '@mantine/core';
```

- [ ] **Step 3: Insert the button + popover above the SimpleGrid**

Find the `{/* Details Grid */}` comment (around line 467). Immediately before the `<SimpleGrid cols={2} mt="lg">` opening tag, insert:

```tsx
{/* Field visibility control */}
<Group justify="flex-end" mb="xs">
    <Popover
        opened={fieldPopoverOpen}
        onChange={setFieldPopoverOpen}
        position="bottom-end"
        shadow="md"
        withArrow
    >
        <Popover.Target>
            <Tooltip label={t('company.editFields')} withArrow position="left">
                {hiddenFields.size > 0 ? (
                    <Group
                        gap={4}
                        style={{
                            padding: '4px 9px',
                            borderRadius: 6,
                            background: '#f3f0ff',
                            border: '1px solid #cc5de8',
                            cursor: 'pointer',
                        }}
                        onClick={() => setFieldPopoverOpen((o) => !o)}
                    >
                        <IconEyeOff size={13} color="var(--mantine-color-violet-6)" />
                        <Text size="xs" fw={600} c="violet">{hiddenFields.size}</Text>
                    </Group>
                ) : (
                    <ActionIcon
                        variant="subtle"
                        color="gray"
                        size="sm"
                        onClick={() => setFieldPopoverOpen((o) => !o)}
                    >
                        <IconEyeOff size={14} />
                    </ActionIcon>
                )}
            </Tooltip>
        </Popover.Target>
        <Popover.Dropdown p="sm" style={{ minWidth: 220 }}>
            <Text size="xs" fw={700} tt="uppercase" c="dimmed" mb="xs" style={{ letterSpacing: '0.5px' }}>
                {t('company.fieldVisibility')}
            </Text>
            <Stack gap={8}>
                {DETAIL_FIELDS.map((field) => {
                    const label = field.labelKey
                        ? t(field.labelKey)
                        : user?.tenantSettings?.[`${field.key}_label` as keyof typeof user.tenantSettings] as string
                          || t(`company.customField${field.key.slice(-1)}`, `Özel Alan ${field.key.slice(-1)}`);
                    return (
                        <Checkbox
                            key={field.key}
                            label={label}
                            checked={!hiddenFields.has(field.key)}
                            onChange={() => toggleField(field.key as DetailFieldKey)}
                            color="violet"
                            size="sm"
                        />
                    );
                })}
            </Stack>
            <Divider my="xs" />
            <Button
                variant="subtle"
                color="violet"
                size="xs"
                fullWidth
                onClick={resetFields}
            >
                {t('company.resetFields')}
            </Button>
        </Popover.Dropdown>
    </Popover>
</Group>
```

- [ ] **Step 4: Lint check**

```bash
cd client && npm run lint
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/CompanyDetailPage.tsx
git commit -m "feat: add field visibility button and popover"
```

---

### Task 5: Apply conditional rendering to each grid field

**Files:**
- Modify: `client/src/pages/CompanyDetailPage.tsx` (the `SimpleGrid` section, around lines 468–523)

Each field already has a null-check condition (e.g. `{company.product_services && ...}`). Wrap each with the additional `!hiddenFields.has(...)` check.

- [ ] **Step 1: Update each field's render condition**

Replace each field's condition as follows. The existing structure is:

```tsx
{company.product_services && (
    <Box>...</Box>
)}
```

Change to:

```tsx
{!hiddenFields.has('product_services') && company.product_services && (
    <Box>...</Box>
)}
```

Apply to all 8 fields:

| Field | Key string |
|---|---|
| product_services | `'product_services'` |
| product_portfolio | `'product_portfolio'` |
| company_summary | `'company_summary'` |
| next_step | `'next_step'` |
| fit_score | `'fit_score'` |
| custom_field_1 | `'custom_field_1'` |
| custom_field_2 | `'custom_field_2'` |
| custom_field_3 | `'custom_field_3'` |

- [ ] **Step 2: Lint check**

```bash
cd client && npm run lint
```

Expected: no errors.

- [ ] **Step 3: Manual verification**

Start the dev server:

```bash
npm run dev
```

1. Open a company detail page that has data in most fields.
2. Confirm the `IconEyeOff` button is visible at the top-right of the info section.
3. Click the button — popover should open with 8 checkboxes.
4. Uncheck a field — it should disappear from the grid immediately.
5. The button should turn violet with the hidden count (e.g. "1").
6. Refresh the page — the hidden field should stay hidden (localStorage persistence).
7. Open the popover, click "Varsayılana sıfırla" — all fields reappear, button returns to gray.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/CompanyDetailPage.tsx
git commit -m "feat: conditionally render detail fields based on visibility preference"
```

---

### Task 6: Final commit — feature complete

- [ ] **Step 1: Verify lint one last time**

```bash
cd client && npm run lint
```

- [ ] **Step 2: Final commit**

```bash
git add client/src/pages/CompanyDetailPage.tsx client/src/locales/tr.json client/src/locales/en.json
git commit -m "feat: company detail field visibility — per-user localStorage toggle"
```
