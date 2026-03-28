# Pipeline Activity Panel & Contact Notes Removal

**Date:** 2026-03-28
**Status:** Approved

## Summary

Replace the contact notes system with activity-based tracking throughout the app. Add a compact activity view to the pipeline spotlight panel, enable contact selection in ActivityForm, include contact names in activity API responses, and remove all contact notes functionality.

## Changes

### 1. Activity API: Contact Name in Response

**File:** `server/src/routes/activities.ts`

- Change the GET `/activities` query from `select('*')` to join with `contacts` table to include `contact_name` (first_name + last_name or equivalent)
- The response should include `contact_name: string | null` alongside `contact_id`
- No schema change needed — the join is at query time

### 2. ActivityForm: Contact Selector

**File:** `client/src/components/ActivityForm.tsx`

- Add a `companyId` prop (required) and `contacts` prop (array of company's contacts)
- Render an optional Select/Autocomplete field to pick a contact from the company's contact list
- Selected contact's ID is sent as `contact_id` in the POST/PUT payload
- The field is optional — activities can still be company-level only

### 3. ActivityTimeline: Compact Mode

**File:** `client/src/components/ActivityTimeline.tsx`

- Add `compact?: boolean` prop
- When `compact=true`:
  - Font sizes: `sm` → `xs`
  - Reduced padding/spacing (Paper padding, Stack gaps)
  - Contact badge: if `contact_name` exists, show a small Badge next to the activity type badge
  - Type filter: small SegmentedControl or chip group (optional, only if fits)
  - "Load more" button stays compact
  - Edit/delete actions remain (role-based, shown on hover or as small icons)

### 4. Pipeline Spotlight Panel

**File:** `client/src/components/pipeline/KanbanBoard.tsx` — `CompanyDetailCell`

Replace the current contact notes display with:
- **Top:** Compact "Aktivite Ekle" button → opens `ActivityForm` modal with `company_id` pre-filled
- **Below:** `ActivityTimeline` in `compact` mode, filtered by the spotlight company's ID
- Contacts list for ActivityForm fetched via existing company detail or contacts API
- Remove all contact notes rendering logic from the panel

### 5. Remove Contact Notes System

#### Server (`server/src/routes/contacts.ts`)
- Delete `POST /:id/notes` endpoint (lines ~351-395)
- Delete `DELETE /:id/notes/:noteId` endpoint (lines ~397-433)
- Remove related validation schemas and imports

#### Client
- **`client/src/types/contact.ts`** — Remove `ContactNote` interface
- **`client/src/pages/CompanyDetailPage.tsx`** — Remove notes display from ContactCard, remove contacted/notContacted grouping logic based on notes
- **`client/src/components/pipeline/KanbanBoard.tsx`** — Remove notes-based contact filtering and display in `CompanyDetailCell`

#### Database
- Migration to drop `contact_notes` related functions (`append_contact_note`, `remove_contact_note`) — or leave as dead code if low risk. Decision deferred to implementation.

## Out of Scope

- Contact notes data migration to activities (existing notes data will be orphaned)
- New activity types beyond existing ones (not, meeting, follow_up, sonlandirma_raporu, status_change)
