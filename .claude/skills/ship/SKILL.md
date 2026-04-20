---
name: ship
description: >-
  Use when the user says "commit", "commitle", "pushla", "deploy", "ship", "versiyonla",
  "yayinla", or asks to commit and push changes. Also trigger when user says "/ship".
  Handles version bumping, changelog, commit, push, and Railway deploy as a single flow.
---

# Ship — Commit, Version, Changelog, Push & Deploy

## Overview

Single command to ship changes: analyze diff, bump version, write structured commit message, update changelog, type-check, commit, push, and deploy to Railway.

## Flow

### Step 1: Analyze Changes

Run `git diff --stat` and `git status` to see what changed. Categorize files into groups:

| Prefix | Files matching |
|--------|---------------|
| **Activities** | `activities.*`, `ActivityForm`, `ActivityTimeline`, `AgendaDayGroup` |
| **Dashboard** | `DashboardPage`, `StatCard`, charts/ |
| **Email** | `email-replies.*`, `ReplyDetailModal`, `emailSender`, `emailHtml` |
| **Pipeline** | `PipelinePage`, `KanbanBoard`, `pipeline_stages` |
| **Campaigns** | `campaigns.*`, `CampaignEditor`, `campaignEngine` |
| **Import** | `import.*`, `MappingEditor`, `DataMatchFlow` |
| **Admin** | `AdminPage`, `admin.*` |
| **Server** | `server/src/routes/*`, `middleware/*`, `lib/*` (not covered above) |
| **UI/UX** | `Layout`, `index.css`, components not in other groups |
| **i18n** | `locales/*.json` |
| **Config** | `package.json`, `vite.config`, `railway.*`, migrations |

### Step 2: Version Decision

Check current version from `package.json` (root). Propose:
- **patch** (x.y.Z) — bug fixes, small tweaks, style changes
- **minor** (x.Y.0) — new features, new pages, new components

Ask user with `AskUserQuestion`:
- "Version bump: {current} -> {proposed}? (patch/minor)"

### Step 3: Write Commit Message

Format:
```
{type}: v{version} — {short summary}

{Group 1}:
- change description
- change description

{Group 2}:
- change description

```

Types: `feat` (minor), `fix` (patch), `chore` (non-functional)

Show the commit message to the user for approval before proceeding.

### Step 4: Update Versions

All three `package.json` files must be in sync:
```
package.json          -> "version": "{new}"
client/package.json   -> "version": "{new}"
server/package.json   -> "version": "{new}"
```

### Step 5: Update Changelog

Add entry to top of array in `client/src/lib/changelog.ts`:

```typescript
{
    version: '{new}',
    date: '{YYYY-MM-DD}',
    title: {
        tr: '{Turkish title}',
        en: '{English title}',
    },
    features: [
        {
            tr: '{Turkish description}',
            en: '{English description}',
        },
        // ... one per significant user-facing change
    ],
},
```

Rules:
- Only user-facing changes (no internal refactors)
- Write in plain language, no technical jargon
- 1-4 features per release
- Turkish first, then English

### Step 6: Type Check

```bash
cd client && npx tsc --noEmit --pretty
```

If errors: fix them before proceeding. Do NOT skip.

### Step 7: Commit

```bash
git add {specific files}
git commit -m "$(cat <<'EOF'
{commit message from step 3}
EOF
)"
```

Stage specific files — never `git add -A` or `git add .`

### Step 8: Push (ask permission first)

Ask user: "Push to {branch} and deploy to {environment}?"

Branch → environment mapping:
- `development` → Staging
- `main` → Production

```bash
git push origin {branch}
```

### Step 9: Deploy

After push, trigger Railway deploy:

```bash
railway up \
  --project ideal-amazement \
  --environment {Staging|production} \
  --service talepgetir-leadhub-v1 \
  --detach
```

Report deploy status to user.

## Quick Reference

| Step | Command/Action | Blocking? |
|------|---------------|-----------|
| Diff analysis | `git diff --stat` | No |
| Version bump | Edit 3x package.json | No |
| Changelog | Edit changelog.ts | No |
| Type check | `npx tsc --noEmit` | Yes — must pass |
| Commit | `git commit` | No |
| Push | `git push` | Yes — ask permission |
| Deploy | `railway up --detach` | No |

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Forgetting server/package.json | Always update all 3 package.json files |
| Changelog with technical jargon | Write for end users, not developers |
| `git add .` catching .env or temp files | Always `git add` specific files |
| Deploying to wrong environment | Check branch: development=Staging, main=production |
| Skipping type check | Never skip — broken builds waste deploy time |
| Version mismatch between packages | Grep all 3 package.json after update to verify |