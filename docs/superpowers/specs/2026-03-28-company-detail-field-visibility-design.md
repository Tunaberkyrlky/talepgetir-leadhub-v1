# Company Detail Page — Field Visibility Design

**Date:** 2026-03-28
**Status:** Approved

## Overview

Add per-user field visibility control to the company detail page. Users can hide/show individual fields in the detail info grid. Preferences are stored in localStorage — no backend changes required.

## Scope

**In scope:** The 8 fields in the detail info grid (`SimpleGrid`) inside the company Paper card:
- `company_summary`
- `product_services`
- `product_portfolio`
- `next_step`
- `fit_score`
- `custom_field_1`
- `custom_field_2`
- `custom_field_3`

**Out of scope:** Header fields (name, stage, location, website, linkedin, phone, email), contacts section, activity timeline.

## UX Design

### Trigger Button

A small icon button positioned at the top-right of the detail grid section (above the `SimpleGrid`), aligned to the right.

- **Icon:** `IconEyeOff` from `@tabler/icons-react`
- **No label text**
- **When all fields visible:** subtle gray style (`variant="subtle"`, `color="gray"`) — icon only, no count
- **When 1+ fields hidden:** render a `Group` (inline-flex) containing the `ActionIcon` (violet inline style: `background: #f3f0ff`, `border: 1px solid #cc5de8`) and a `Text` element (`size="xs"`, `fw={600}`, `c="violet"`) showing the hidden count — same DOM structure used for the badge in `LeadsPage.tsx` lines 1030–1044.
- **Tooltip:** `t('company.editFields')` (translated, see Files Changed)

### Popover

Mantine `Popover` (`position="bottom-end"`, `shadow="md"`, `withArrow`) — same pattern as the column visibility popover in `LeadsPage.tsx`.

Contents:
- Title: rendered via `t('company.fieldVisibility')` as `<Text size="xs" fw={700} tt="uppercase" c="dimmed">` — **must not be hardcoded**
- One `Checkbox` per field (violet `accent-color`); **all 8 checkboxes are always shown regardless of whether the field has data** — the popover reflects the user's visibility preference, not data presence
- Custom field labels read from `user?.tenantSettings?.custom_field_X_label` (fallback: `t('company.customField1')` etc.)
- Divider + `t('company.resetFields')` text button at the bottom

**Edge case — hidden but empty fields:** A field can be marked hidden in localStorage even if its value is `null` (no data). This is intentional: the hidden count includes such fields. This is acceptable because the popover shows all 8 fields unconditionally, and the user explicitly toggled it.

## Data Model

**localStorage key:** `company_detail_field_visibility`

**Value:** JSON array of hidden field keys, e.g. `["custom_field_2", "custom_field_3"]`

**Default:** Empty array — all fields visible.

```ts
// Load
function loadFieldVisibility(): Set<string> {
    try {
        const stored = localStorage.getItem('company_detail_field_visibility');
        return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch {
        return new Set();
    }
}

// Save
function saveFieldVisibility(hidden: Set<string>) {
    localStorage.setItem('company_detail_field_visibility', JSON.stringify([...hidden]));
}
```

## Implementation

### State (inside `CompanyDetailPage`)

```ts
const [hiddenFields, setHiddenFields] = useState<Set<string>>(() => loadFieldVisibility());
const [fieldPopoverOpen, setFieldPopoverOpen] = useState(false);
```

### Toggle handler

```ts
const toggleField = (key: string) => {
    const next = new Set(hiddenFields);
    if (next.has(key)) next.delete(key); else next.add(key);
    setHiddenFields(next);
    saveFieldVisibility(next);
};
```

### Field definitions (constant, above component)

```ts
const DETAIL_FIELDS = [
    { key: 'company_summary',   labelKey: 'company.companySummary' },
    { key: 'product_services',  labelKey: 'company.productServices' },
    { key: 'product_portfolio', labelKey: 'company.productPortfolio' },
    { key: 'next_step',         labelKey: 'company.nextStep' },
    { key: 'fit_score',         labelKey: 'company.fitScore' },
    { key: 'custom_field_1',    labelKey: null }, // uses tenantSettings
    { key: 'custom_field_2',    labelKey: null },
    { key: 'custom_field_3',    labelKey: null },
] as const;
```

### Rendering

Each field in the `SimpleGrid` is conditionally rendered:

```tsx
{!hiddenFields.has('company_summary') && company.company_summary && (
    <Box>...</Box>
)}
```

The button and popover are rendered above the `SimpleGrid` (inside the same `Paper`, after the header group).

### Files Changed

| File | Change |
|---|---|
| `client/src/pages/CompanyDetailPage.tsx` | Add state, handlers, button, popover, conditional rendering |
| `client/src/locales/tr.json` | Add `company.fieldVisibility: "Görünen Alanlar"`, `company.resetFields: "Varsayılana sıfırla"`, `company.editFields: "Alanları düzenle"` |
| `client/src/locales/en.json` | Add `company.fieldVisibility: "Visible Fields"`, `company.resetFields: "Reset to default"`, `company.editFields: "Edit fields"` |

## Consistency Notes

- Follows the exact same localStorage + Mantine Popover + Checkbox pattern used in `LeadsPage.tsx` (`colPopoverOpen`, `saveColumns`, `toggleColumn`)
- No new components or hooks — all logic lives in `CompanyDetailPage.tsx`
- Violet as accent color matches the rest of the company detail page (edit button, loader, etc.)
