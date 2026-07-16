/**
 * ResearchFlowPage — the wizard-first entry point (WP6 shell + WP7 FAZ 1 + WP8a/WP8b FAZ 2).
 * Typeform ilkesi: one screen, one task. Ships FAZ 1 (steps 1-6: kickoff form → profile:crawl
 * wait screen → summary/country confirm → products/services → differentiators → hints) and
 * FAZ 2 (step 7: ICP generation wait screen, step 8: one sub-ICP card + its target-country
 * chips at a time, step 9: batch geo:analyze wait screen, step 10: one geo cell card at a
 * time, steps 11-14: the calibration loop — sample → rate one company at a time → revision
 * diff review → re-approve/finish-or-loop) plus a step-15 placeholder for whatever comes
 * after (message angles / deep research). Reuses IcpCard and GeoCellDetail (extracted from
 * GeographiesPanel, WP8a) and useCalibration (extracted from CalibrationDrawer, WP8b)
 * VERBATIM — no ICP/geo/calibration endpoint logic is reimplemented here, only the wizard-
 * side cursor/polling/persistence around them. The existing tabbed ResearchPage keeps living,
 * unchanged, at /research/full ("advanced view").
 *
 * PATCH /research/projects/:id replaces `profile` and `flow_state` wholesale (no JSONB
 * merge server-side) — every save here goes through saveStepMut, which spreads the FULL
 * current profile object and overrides only the keys the step in question owns, then sends
 * the FULL flow_state object (now also carrying icp_card_index/geo_card_index/
 * calibration_company_index — additive keys in the SAME JSONB column, no migration). Never a
 * partial diff, so we never clobber keys written by the advanced view (e.g. products/
 * target_markets/exclusions — SAME keys this wizard also writes, by design) or lose the
 * resume pointer.
 */
import { useEffect, useRef, useState } from 'react';
import { ActionIcon, Center, Loader, Stack, TextInput, Textarea, TagsInput, Text, Alert, Button, Badge, Group, Tooltip, Divider, List, NumberInput } from '@mantine/core';
import { IconInfoCircle, IconThumbUp, IconThumbDown, IconWorld, IconSparkles, IconChecks, IconRefresh, IconPlayerPlay } from '@tabler/icons-react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showError, showErrorFromApi } from '../../lib/notifications';
import { useAuth } from '../../contexts/AuthContext';
import WizardShell from '../../components/research/WizardShell';
import AiWaitScreen from '../../components/research/AiWaitScreen';
import IcpCard, { type ResearchIcp } from '../../components/research/IcpCard';
import IcpCountryChips from '../../components/research/IcpCountryChips';
import { GeoCellDetail, type GeoCell } from '../../components/research/GeoCellDetail';
import { OfferCard, type OfferRow } from '../../components/research/OfferCard';
import HsCodeCandidates from '../../components/research/HsCodeCandidates';
import CompaniesPanel from '../../components/research/CompaniesPanel';
import EnrichmentPanel from '../../components/research/EnrichmentPanel';
import { useCalibration, diffArrays, RULESET_KEYS, RULESET_LABEL } from '../../lib/useCalibration';
import {
    latestResearchProjectQueryKey,
    useLatestResearchProject,
    type ResearchProjectSummary,
    type ResearchProjectsListResponse,
} from '../../lib/researchProjects';

// WP10 ships steps 1-21 (FAZ 1 + FAZ 2 + FAZ 4 offer cards + FAZ 5 scale/deep-research + FAZ 6
// contacts + FAZ 7 results/closing). Any stored flow_state.step beyond what this build knows
// about is clamped down to the last known step so an older/newer client never gets stuck on an
// unrecognized screen. WP11 added two more raw step numbers (22, 23 — see STEP_ORDER below), so
// the clamp bound is now 23.
const KNOWN_STEPS = 23;

// WP11: HS-match (raw step 22) + market:analyze (raw step 23) sit BETWEEN existing steps 6 and 7
// in FLOW ORDER (tg-research-ana-akis.md adım 7-8, before adım 9's sub-ICP cards = step 8) but
// keep their OWN raw step numbers appended after the existing 1-21 range instead of renumbering
// steps 7-21 in place — a shift would touch every one of this file's ~130 step-number literals
// (each already hardened by several adversarial-review rounds) for zero functional gain.
// displayStep() remaps a raw step number to its FLOW-ORDER position purely for the
// "Step X / N" label + progress bar, so the numbers a customer sees stay contiguous 1..23 even
// though the underlying flow_state.step values are not. Existing projects resuming mid-flow at
// a pre-WP11 step (1-21) are entirely unaffected — they simply never visit 22/23 unless they
// navigate back past step 6.
const STEP_ORDER = [1, 2, 3, 4, 5, 6, 22, 23, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];
function displayStep(raw: number): number {
    const i = STEP_ORDER.indexOf(raw);
    return i >= 0 ? i + 1 : raw;
}

interface CrawlJob {
    id: string;
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
    progress: Record<string, unknown>;
    error: string | null;
}

/** POST /:id/crawl returns either a fresh job, or `{ already_crawled: true }` when the
 *  server finds an existing profile.ai_draft (never re-runs automatically — WP7 review P2). */
interface CrawlEnqueueResponse {
    id?: string;
    already_crawled?: boolean;
}

/** WP11 — GET /research/hs row shape (mirrors ResearchIcp's own minimal client-side mirror). */
interface HsCodeRow {
    id: string;
    code: string;
    description: string;
    status: 'candidate' | 'approved' | 'rejected';
}

const JOB_RUNNING = (s?: string) => s === 'queued' || s === 'running';
const CRAWL_STAGES = ['loading', 'crawling_website', 'crawling_social', 'summarizing', 'persisting'] as const;
// Mirrors icp:generate's worker heartbeat stages (icpGenerate.ts) — narrated live in step 7,
// same pattern as CRAWL_STAGES for step 2. No server-side heartbeats invented beyond these.
const ICP_GEN_STAGES = ['loading', 'generating', 'persisting'] as const;
// Mirrors offer:generate's worker heartbeat stages (offerGenerate.ts) — narrated live in step 15.
const OFFER_GEN_STAGES = ['loading', 'generating'] as const;
// Mirrors research:orchestrate's own heartbeat stages (orchestrate.ts) — narrated live in step 18.
const ORCHESTRATE_STAGES = ['deciding', 'discovering_channels', 'harvesting_channel', 'harvesting_web'] as const;
// Mirrors hs:match's worker heartbeat stages (hsMatch.ts) — narrated live in step 22 (WP11).
const HS_MATCH_STAGES = ['loading', 'generating', 'persisting'] as const;
// Mirrors market:analyze's worker heartbeat stages (marketAnalyze.ts) — narrated live in step 23 (WP11).
const MARKET_ANALYZE_STAGES = ['loading', 'world_import', 'bilateral'] as const;
// Same map lives in CalibrationDrawer.tsx (not exported — react-refresh wants component-only
// exports from a file, same convention as IcpCard.tsx/GeographiesPanel.tsx's own duplicates).
const VERDICT_COLOR: Record<'match' | 'partial' | 'eliminated' | 'review', string> = {
    match: 'green', partial: 'yellow', eliminated: 'red', review: 'gray',
};

function asStringArray(v: unknown): string[] {
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function asRecord(v: unknown): Record<string, unknown> {
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asStringField(v: unknown): string {
    return typeof v === 'string' ? v : '';
}

// WP8b: which ICP gets calibrated in steps 11-14 — the approved ICP with the highest
// human_score (ties: first by array/creation order). Zero approved ICPs falls through to the
// step-15 placeholder without attempting calibration (defensive — step 8 requires review, so
// this shouldn't normally happen). A customer with multiple approved ICPs can calibrate the
// others manually from /research/full — this WP scopes to ONE calibration run per project.
function pickBestApprovedIcp(icps: ResearchIcp[]): ResearchIcp | null {
    let best: ResearchIcp | null = null;
    for (const icp of icps) {
        if (icp.status !== 'approved') continue;
        if (!best || (icp.human_score ?? -1) > (best.human_score ?? -1)) best = icp;
    }
    return best;
}

// WP8b: geography prefill for step 11's sample — the highest-scored APPROVED geo cell
// belonging to the ICP being calibrated, if one exists (WP8a's geo cards already produced
// this). No cell (or none approved yet) just means the customer types a geography manually,
// same as CalibrationDrawer's own always-available text input.
function pickBestApprovedGeoCell(cells: GeoCell[], icpId: string | undefined): GeoCell | null {
    if (!icpId) return null;
    let best: GeoCell | null = null;
    for (const cell of cells) {
        if (cell.icp_id !== icpId || cell.status !== 'approved') continue;
        if (!best || (cell.human_score ?? -1) > (best.human_score ?? -1)) best = cell;
    }
    return best;
}

interface SaveStepVars {
    /** Profile keys this step owns — spread onto the full current profile, never a partial diff. */
    patch: Record<string, unknown>;
    nextStep: number;
    /** Appended to flow_state.completed_gates (deduped) — marks this step as passed. */
    gate: string;
    /** True when step 1 just changed website/social_links, invalidating the old ai_draft — also
     *  resets steps 3-5's local seed flags so their pre-fill logic re-runs from the new (empty,
     *  until re-crawled) draft instead of stale values (review P2). */
    clearDependentSeeds?: boolean;
    /** Gate names to strip from completed_gates BEFORE adding `gate` — used when a field a gate
     *  covers is being cleared (e.g. company_country/'step3') so that step's fields don't get
     *  permanently locked out of ever re-deriving from a fresh ai_draft again (see the
     *  completed_gates-gated pre-fill logic in steps 3-5 below; review P2). */
    removeGates?: string[];
    /** Set to true by the subject-change paths (step-1 website/social change, "research again")
     *  to persist flow_state.reseed_from_draft. It tells the steps 3-5 pre-fill logic that any
     *  gate-ABSENT field is stale-after-a-fresh-crawl and must reseed from the fresh ai_draft,
     *  NOT from a leftover confirmed profile value belonging to the PREVIOUS subject. Left unset
     *  (and never auto-cleared) otherwise, so advanced-editor / pre-wizard projects — which have
     *  authored profile fields but no gates and never a subject-change — keep showing their own
     *  values in the wizard rather than being masked by the draft (review P2). */
    reseedFromDraft?: boolean;
    /** Override for flow_state.icp_card_index (WP8a) — defaults to the current local cursor
     *  when omitted, so every save (even from unrelated steps) still carries the cursor
     *  forward (whole-object flow_state replace, same reasoning as completed_gates). */
    icpCardIndexOverride?: number;
    /** Override for flow_state.geo_card_index (WP8a) — same reasoning as icpCardIndexOverride. */
    geoCardIndexOverride?: number;
    /** Override for flow_state.calibration_company_index (WP8b) — same reasoning again. */
    calibCompanyIndexOverride?: number;
    /** Override for flow_state.offer_card_index (WP9) — same reasoning as icpCardIndexOverride. */
    offerCardIndexOverride?: number;
    /** Override for flow_state.calibration_icp_id (WP8b P1-C fix) — same reasoning again;
     *  defaults to the current local `calibIcpId` state when omitted, so every save carries the
     *  pinned calibration target forward once it's first resolved. */
    calibIcpIdOverride?: string | null;
    /** WP8b P1 fix — see calibStepTokenRef's own doc comment above. Set by every calibration-loop
     *  navigation change: the four boundary auto-advance transitions (11->12, 12->13, 13->14,
     *  14->15) AND step 12's own intra-loop company-index moves; every other saveStepMut call in
     *  this file leaves it undefined. */
    calibStepToken?: number;
}

export default function ResearchFlowPage() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const qc = useQueryClient();
    const { activeTenantId } = useAuth();
    // Always mirrors the LATEST activeTenantId so in-flight mutation callbacks can tell "has
    // the tenant changed since I started" — see the startedForTenant guards below (review P2:
    // a stale callback from a mutation started under the previous tenant must never repopulate
    // the wizard after a switch). P1 fix (WP8b round 5, adversarial review): this used to be
    // synced ONLY by the passive effect below, which runs strictly AFTER the tenant-switch
    // reset block further down has already executed and committed — a callback resolving in
    // that gap would read the OLD tenant id here, pass the `startedForTenant` check (both sides
    // still equal the OLD tenant), and unconditionally restore stale data (projectId, profile,
    // completedGates, icp/geo card cursors, the pinned calibration ICP) into what is, as of the
    // already-committed reset, the NEW tenant's wizard — the `calibStepToken` guard only ever
    // protected `step`/`calibration_company_index`, nothing else onSuccess writes. The reset
    // block below now ALSO assigns this ref directly and synchronously — the earliest point
    // React can detect the switch at all, so there's no earlier moment to move this to — which
    // closes the gap rather than narrowing it: by the time that block's synchronous body has
    // finished running, this ref already reflects the new tenant, with no window left in
    // between for a stale callback to slip through. The effect below is now a redundant mirror
    // for the ordinary (non-switching) render path — kept for belt-and-suspenders, same style
    // as the rest of this file — it no longer does the only sync.
    const activeTenantIdRef = useRef(activeTenantId);
    useEffect(() => {
        activeTenantIdRef.current = activeTenantId;
    }, [activeTenantId]);

    const [hydrated, setHydrated] = useState(false);
    const [projectId, setProjectId] = useState<string | null>(null);
    const [step, setStep] = useState(1);
    const [completedGates, setCompletedGates] = useState<string[]>([]);
    // Persisted (flow_state.reseed_from_draft): once a subject-change (website/social edit or
    // "research again") has demoted the step 3-5 gates, a gate-ABSENT field must reseed from the
    // fresh ai_draft, not from the leftover confirmed value of the PREVIOUS subject. See the
    // SaveStepVars.reseedFromDraft doc for why this is set-and-never-cleared (only a subject
    // change ever demotes a gate, so "gate absent ⟹ reseed from draft" stays correct).
    const [reseedFromDraft, setReseedFromDraft] = useState(false);

    // Full raw profile object as last known on the server — preserved so a wizard save
    // never drops keys the advanced view (or profile:crawl) wrote.
    const [profile, setProfile] = useState<Record<string, unknown>>({});
    const aiDraft = asRecord(profile.ai_draft);
    const hasAiDraft = Object.keys(aiDraft).length > 0;

    // Step 1 controlled fields (mirrors of profile.contact_name / .website / .social_links
    // + the project's top-level name column).
    const [companyName, setCompanyName] = useState('');
    const [contactName, setContactName] = useState('');
    const [website, setWebsite] = useState('');
    const [socialLinks, setSocialLinks] = useState<string[]>([]);

    // Step 2 (profile:crawl wait screen) — the enqueue mutation + its job poll.
    const [crawlJobId, setCrawlJobId] = useState<string | null>(null);
    // Explicit one-shot latch for the auto-start effect below — NOT derived from crawlMut's own
    // isPending/isError, because the `already_crawled` response path never sets crawlJobId and
    // calls a SEPARATE mutation (fetchDraftMut) afterward; without this latch, the moment
    // crawlMut settles (isPending flips back to false) but before fetchDraftMut's own isPending
    // flips true, the effect's guards would all read false and re-POST /crawl. Only an explicit
    // "Tekrar dene" resets it.
    const [crawlRequested, setCrawlRequested] = useState(false);
    // True when the most recent crawl job "succeeded" server-side but was actually SKIPPED
    // (profileCrawl.ts's staleness guard — the website/social links changed mid-flight, so no
    // ai_draft was written). Drives a "your details changed — researching again" message while
    // a fresh crawl automatically re-fires against the now-current input (review P2).
    const [crawlWasSkipped, setCrawlWasSkipped] = useState(false);
    // One-shot: set true exactly when the user explicitly clicks "Geri" from step 3 back to
    // step 2. Without this, the auto-skip-forward guard below (step 2 + ai_draft already
    // present -> jump straight to 3) fires unconditionally and bounces an explicit Back click
    // right back to step 3, making step 3's Back button a no-op once a draft exists (review
    // P2). Cleared by the effect below the moment `step` actually leaves 2 for any reason, so
    // the NEXT forward arrival at step 2 (e.g. re-submitting step 1) still auto-skips normally.
    const [explicitBackNav, setExplicitBackNav] = useState(false);
    // Same one-shot-latch shape as explicitBackNav, for step 7's analogous auto-advance guard:
    // once ICPs exist, step 7 immediately advances to step 8 — so an explicit "Geri" click from
    // step 8's first card (a plain local setStep(7), not persisted) would otherwise be bounced
    // right back to step 8 before the user ever sees step 7's own Back-to-6 button (review P2).
    // Consumed the moment `step` actually leaves 7 for any reason (see the effect below).
    const [explicitBackToStep7, setExplicitBackToStep7] = useState(false);
    // Same shape again, for step 10's first-card Back → step 9: step 9's own auto-advance
    // effect fires the instant `geoAnalyzeAllDone` is true, which it trivially already is
    // whenever the user could BE on step 10 in the first place — so without this latch, Back
    // bounces straight back to step 10 for every single user (review P1).
    const [explicitBackToStep9, setExplicitBackToStep9] = useState(false);
    // Same shape again, for step 11's Back → step 10 when step 10 has zero geo cells: the
    // zero-cell-skip effect fires the instant it sees an empty list, which it trivially
    // already did to get the user to step 11 in the first place (review P2).
    const [explicitBackToStep10, setExplicitBackToStep10] = useState(false);

    // Steps 3-6 controlled fields — each seeded exactly once, the first time its step
    // actually renders (see the `stepNSeeded` guards below), from the human-approved
    // profile key if already set, else the frozen ai_draft suggestion.
    const [whatTheyDoInput, setWhatTheyDoInput] = useState('');
    const [companyCountryInput, setCompanyCountryInput] = useState('');
    const [step3Seeded, setStep3Seeded] = useState(false);

    const [productsInput, setProductsInput] = useState<string[]>([]);
    const [step4Seeded, setStep4Seeded] = useState(false);

    const [moq, setMoq] = useState('');
    const [leadTime, setLeadTime] = useState('');
    const [certifications, setCertifications] = useState<string[]>([]);
    const [capacity, setCapacity] = useState('');
    const [references, setReferences] = useState<string[]>([]);
    const [languages, setLanguages] = useState<string[]>([]);
    const [step5Seeded, setStep5Seeded] = useState(false);

    const [lookalikeCustomers, setLookalikeCustomers] = useState<string[]>([]);
    const [targetMarketsInput, setTargetMarketsInput] = useState<string[]>([]);
    const [exclusionsInput, setExclusionsInput] = useState<string[]>([]);
    const [step6Seeded, setStep6Seeded] = useState(false);

    // Step 22 (WP11 — HS candidate review, raw step number; see STEP_ORDER's doc comment above
    // for why it isn't literally "7") — mirrors step 7's icp:generate enqueue+poll latch shape.
    const [hsMatchJobId, setHsMatchJobId] = useState<string | null>(null);
    const [hsMatchRequested, setHsMatchRequested] = useState(false);
    // Same shape as explicitBackToStep7/9/10: an explicit Back click from step 7 (now reached
    // via step 23, not step 6 directly — see step 7's onBack below) must actually land on step
    // 23, not bounce straight back to 7 the instant that screen's own auto-skip effect
    // re-observes "zero approved HS codes".
    const [explicitBackToStep23, setExplicitBackToStep23] = useState(false);
    // Step 23 (WP11 — market:analyze wait screen, raw step number) — mirrors step 7's tracked-
    // job shape. Same "Back into an auto-advancing screen" latch, one hop earlier: a Back click
    // from step 23 to step 22 must not be bounced forward again by step 22's own zero-candidate
    // auto-skip effect.
    const [explicitBackToStep22, setExplicitBackToStep22] = useState(false);
    const [marketAnalyzeJobId, setMarketAnalyzeJobId] = useState<string | null>(null);
    const [marketAnalyzeRequested, setMarketAnalyzeRequested] = useState(false);

    // Step 7 (ICP generation wait screen) — mirrors step 2's crawl-enqueue + one-shot latch.
    const [icpGenJobId, setIcpGenJobId] = useState<string | null>(null);
    const [icpGenRequested, setIcpGenRequested] = useState(false);

    // Step 8 (one sub-ICP card at a time) — persisted cursor (flow_state.icp_card_index).
    const [icpCardIndex, setIcpCardIndex] = useState(0);

    // Step 9 (batch geo:analyze wait screen) — one-shot latch + the job ids it started.
    const [geoAnalyzeRequested, setGeoAnalyzeRequested] = useState(false);
    const [geoAnalyzeJobIds, setGeoAnalyzeJobIds] = useState<string[] | null>(null);
    const [geoAnalyzeTotal, setGeoAnalyzeTotal] = useState(0);

    // Step 10 (one geo cell card at a time) — persisted cursor (flow_state.geo_card_index) +
    // the single re-analyze job GeoCellDetail's own "Re-analyze" button can kick off (mirrors
    // GeographiesPanel's own `job` state for the exact same button).
    const [geoCardIndex, setGeoCardIndex] = useState(0);
    const [geoReanalyzeJob, setGeoReanalyzeJob] = useState<{ id: string; geoId: string } | null>(null);

    // Steps 11-14 (calibration loop, WP8b) — one-shot request latches for each auto-firing
    // mutation (sample / feedback save / revise / apply / mark-calibrated), a one-shot seed
    // guard for the geography prefill, the persisted per-company rating cursor, and the
    // explicit-Back latch for the ONE ambient-condition-driven auto-advance in this range
    // (step 11 -> 12, gated on "sampled companies already exist" — same bug shape as
    // explicitBackToStep9/10). The 12->13, 13->14, and 14->15 transitions are each driven by a
    // discrete one-shot request flag tied to an explicit click, not an ambient data condition,
    // so they don't need their own latch — see the trace note above each effect below.
    const [calibSampleRequested, setCalibSampleRequested] = useState(false);
    const [calibGeographySeeded, setCalibGeographySeeded] = useState(false);
    const [explicitBackToStep11, setExplicitBackToStep11] = useState(false);
    // P1 fix (WP8b round 5, adversarial review): tracks "a Run-sample click just fired but its
    // fresh company list hasn't landed yet" — see the un-suppress effect further below (right
    // after the 11->12 auto-advance effect) for the full trace of why this exists and why it's
    // gated on `companiesQuery.dataUpdatedAt` specifically, not `anyRunning`/`jobStatus`. Also
    // used to keep step 11's own manual "Next" button disabled for the same window — that
    // button is a SEPARATE path into step 12 that bypasses `explicitBackToStep11` entirely by
    // design (see its own onPrimary comment), so gating only the auto-advance effect would leave
    // this exact bug one click away.
    const [calibAwaitingResample, setCalibAwaitingResample] = useState(false);
    // Snapshot of companiesQuery.dataUpdatedAt taken the instant a Run-sample click fires — see
    // calibAwaitingResample's own doc comment. A ref, not state: only ever read inside the
    // un-suppress effect's body, never during render. Still part of the un-suppress check
    // (round 6) — the job id ref below proves THIS job succeeded; this timestamp separately
    // proves that job's own success-triggered refetch has actually landed (a job can read
    // 'succeeded' one render before its own invalidateQueries-triggered refetch completes).
    const calibResampleBaselineRef = useRef<number | null>(null);
    // P1 fix (WP8b round 6, adversarial review): the SPECIFIC sample job THIS "Run sample" click
    // started (or 409-adopted) — captured once useCalibration exposes it via `calib.job`, then
    // compared against `calib.jobQuery.data` in the un-suppress effect below. `dataUpdatedAt`
    // moving past the baseline alone doesn't prove THIS job finished: TanStack Query's default
    // `refetchOnReconnect` can bump the exact same companies query key from an UNRELATED network
    // reconnect while this sample is still genuinely running server-side, false-positive-clearing
    // the latch before the real job completes. Requiring this job id to reach a real terminal
    // 'succeeded' status closes that gap; `calibResampleBaselineRef` above still guards the other
    // half (job succeeded but its own refetch hasn't landed on screen yet).
    const calibResampleJobIdRef = useRef<string | null>(null);
    // P1 fix (WP8b round 7, adversarial review): `calibResampleBaselineRef` above (the CLICK-time
    // snapshot) proves the pre-existing race the round-6 fixes closed — but it is not, on its
    // own, causal proof that THIS job's own success-triggered refetch is what advanced
    // `dataUpdatedAt`. `refetchOnReconnect` (still on by default; only `refetchOnWindowFocus` is
    // disabled in App.tsx) can fire a reconnect-triggered refetch of the exact same companies key
    // WHILE the tracked job is still genuinely running server-side, bumping `dataUpdatedAt` past
    // the click-time baseline well before the job reaches 'succeeded'. The instant the job later
    // does reach 'succeeded', the un-suppress effect below would find BOTH its conditions already
    // true on that very render — even though the job's OWN `invalidateQueries` call (useCalibration's
    // job-succeeded effect) hasn't even fired yet, let alone landed. This second ref anchors the
    // causal proof to the job's own actual success moment instead of click time: the un-suppress
    // effect captures `dataUpdatedAt` the first render it observes the tracked job's status as
    // 'succeeded', then requires `dataUpdatedAt` to advance STRICTLY PAST that later snapshot — a
    // bar only the job's own post-success refetch (the one and only other place this exact key is
    // invalidated, per calibResampleBaselineRef's own doc comment above) can clear. Reset to null
    // everywhere the OTHER resample-tracking refs are reset (tenant switch, a fresh "Run sample"
    // click, and retryCalibSample) — never partially, since a stale non-null value here would
    // silently satisfy the comparison for the WRONG resample cycle.
    // P1 REGRESSION fix (WP8b round 8, adversarial review): the round-7 IMPLEMENTATION below used
    // to diverge from this comment's own description — it captured this ref only AFTER an earlier
    // dataUpdatedAt/click-baseline check had already passed, which (in the ordinary case, no
    // reconnect) meant it always captured the exact value that had JUST satisfied that check,
    // making the very next comparison self-referential and permanently unsatisfiable. Fixed to
    // capture this ref in the SAME instant `calibResampleJobSucceededRef` first flips true, exactly
    // as this comment always said — see the un-suppress effect's own doc comment below for the
    // full concrete-timestamp trace of both the normal case and the reconnect-race case this ref
    // exists for.
    const calibResampleSuccessBaselineRef = useRef<number | null>(null);
    // P1 REGRESSION fix (WP8b round 8, adversarial review): round 7's fix above requires the
    // un-suppress effect to read `calib.jobQuery.data?.id === trackedJobId && .status ===
    // 'succeeded'` on EVERY render before it will even look at the dataUpdatedAt baselines —
    // but useCalibration's own job-succeeded effect (useCalibration.ts) invalidates the companies
    // query AND calls `setJob(null)` in the SAME effect run. Once `job` is null, useCalibration's
    // `jobQuery` (`enabled: !!job`, and `job?.id` rides in its OWN queryKey) starts reading
    // `undefined` on the very next render — which arrives before the companies refetch that
    // invalidateQueries kicked off has actually landed (that refetch is an async network request;
    // it cannot resolve within the same synchronous effects flush that called `setJob(null)`).
    // Concretely: render N is the first render `jobStatus` reads 'succeeded'. Because
    // `useCalibration(...)` is called (line ~1034) BEFORE this file's own effects are declared,
    // React attaches useCalibration's internal effects earlier in this component's effect list,
    // so within render N's passive-effects flush, useCalibration's job-succeeded effect runs
    // FIRST (invalidateQueries + setJob(null), the latter only SCHEDULING a future re-render, not
    // applying synchronously) and the un-suppress effect below runs immediately after it, in that
    // SAME flush — at that point `calib.jobQuery.data` still reflects render N's pre-setJob(null)
    // value (succeeded), so the id/status match DOES succeed on this exact pass. But the
    // dataUpdatedAt baseline checks right after it (both of them) still correctly bail on this
    // same pass, since the invalidated companies refetch hasn't resolved yet — an async request
    // started moments ago in the very same flush. By the time that refetch DOES land (a later
    // render, N+2), `job` has already been cleared (render N+1, triggered by the batched
    // `setJob(null)`), so `jobQuery`'s queryKey now reads `job?.id === undefined` and its `data`
    // is `undefined` on every render from N+1 onward — the id/status match at the top of this
    // effect can never pass again, so it bails forever and `calibAwaitingResample` never clears.
    // Fix: latch the "tracked job reached succeeded" FACT into this ref the one time it's
    // observable (render N, same reasoning as above), so every later render — including the ones
    // where `jobQuery.data` has already gone missing — can skip straight to the dataUpdatedAt
    // baseline comparisons instead of re-deriving "did it succeed" from state that's no longer
    // there. Reset to false everywhere the other resample-tracking refs are reset (tenant switch,
    // a fresh "Run sample" click, retryCalibSample, and this effect's own release path) — same
    // rule as `calibResampleJobIdRef`'s own doc comment: a stale `true` left over from a PRIOR
    // cycle would satisfy this latch immediately for the WRONG resample.
    const calibResampleJobSucceededRef = useRef(false);
    const [calibrationCompanyIndex, setCalibrationCompanyIndex] = useState(0);
    // WP8b P1-C fix: which ICP steps 11-14 are calibrating, PINNED once resolved instead of
    // recomputed via pickBestApprovedIcp on every render — see calibIcp's own computation below
    // for why recomputing was the bug (apply-revision's approved->draft demotion could flip or
    // null the target mid-loop). null until a candidate is first pinned or hydrated from
    // flow_state.calibration_icp_id.
    const [calibIcpId, setCalibIcpId] = useState<string | null>(null);
    const [calibFeedbackRequested, setCalibFeedbackRequested] = useState(false);
    const [calibApplyRequested, setCalibApplyRequested] = useState(false);
    const [calibMarkRequested, setCalibMarkRequested] = useState(false);
    // WP8b P1 fix (codex xhigh review, generalized round 4): a run-token for EVERY navigation
    // change inside the calibration loop (steps 11-14) — originally just the four boundary
    // auto-advance transitions (11->12, 12->13, 13->14, 14->15), now ALSO step 12's own
    // intra-loop company-index moves (advance() and back(), see their own comments) — any action
    // that changes WHERE the user is inside this loop bumps it. The one-shot request latches
    // above only ever stopped an auto-advance EFFECT from firing again — they never stopped the
    // fallout of a transition that had ALREADY fired before the user navigated away: saveStepMut's
    // shared onSuccess (below) is unconditional, so an in-flight PATCH from any of these
    // transitions can still resolve AFTER the user has locally navigated elsewhere and snap
    // `step` (or the company cursor) back forward, overwriting that navigation (review P1). Every
    // guarded transition stamps THIS ref's CURRENT value (after bumping it) into the SaveStepVars
    // it passes to saveStepMut.mutate(); onSuccess compares its own captured copy against the
    // ref's LATEST value before applying `step`/`calibration_company_index` — a mismatch means a
    // later click (Back, resample, or a different company index) bumped the ref after this
    // transition was initiated, so the completion is stale and must not move the navigation
    // forward (everything ELSE in onSuccess — profile/gates/other cursors — still applies; only
    // navigation is guarded, mirroring the task's own scope). A ref, not state, because bumping
    // it must never itself cause a re-render — it only matters when READ inside a later callback.
    // The bump is ALWAYS `+= 1` (monotonic), never a reset to a fixed value (including the
    // tenant-switch reset below) — a fixed value like `0` is reusable and could collide with an
    // earlier stamp; a monotonic counter can't. Every saveStepMut call OUTSIDE the calibration
    // loop never sets this field (stays undefined), which onSuccess treats as "not a guarded
    // transition" and applies both fields unconditionally, so steps 1-10's own forward navigation
    // is entirely unaffected.
    const calibStepTokenRef = useRef(0);

    // Step 15 (offer/angle generation wait screen, WP9) — mirrors step 7's icp:generate pattern
    // exactly (one-shot request latch + tracked job id).
    const [offerGenJobId, setOfferGenJobId] = useState<string | null>(null);
    const [offerGenRequested, setOfferGenRequested] = useState(false);
    // Same shape as explicitBackToStep7/9/10: an explicit Back click from step 16's first card
    // must actually land on step 15 (so its own Back-to-14 button is reachable), not bounce
    // straight back to step 16 the instant this auto-advance effect re-observes offers.length>0.
    const [explicitBackToStep15, setExplicitBackToStep15] = useState(false);

    // Step 16 (one offer card at a time, WP9) — persisted cursor (flow_state.offer_card_index),
    // same shape as icpCardIndex/geoCardIndex.
    const [offerCardIndex, setOfferCardIndex] = useState(0);

    // Purely a rendering signal for OfferCard's own mount-entrance animation (never read by any
    // mutation/job-polling/state-machine logic below): WizardShell's Paper is keyed by `step`, so
    // it only remounts (and fades the whole card in) when `step` itself changes — paging between
    // offer cards within step 16 changes offerCardIndex, not step, so WizardShell does NOT
    // re-animate then. usePrevious-style ref: on the render where step first becomes 16 (arriving
    // from 15), this still holds the OLD step value, so OfferCard is told to skip its own
    // entrance (WizardShell's fade is the only animation); on every later re-render within the
    // same step-16 visit it already holds 16, so OfferCard's own per-card entrance plays as the
    // sole animation for that page-in.
    const prevStepForOfferAnimRef = useRef<number | null>(null);
    useEffect(() => {
        prevStepForOfferAnimRef.current = step;
    });

    // Step 17 (scale & credit screen, WP9) — local mirror of research_projects.scale_target;
    // '' = "no target, run until fully covered / out of credit" (the server column is nullable).
    // Seeded once from the server (stepNSeeded-style latch, steps 3-6's own convention).
    const [scaleTargetInput, setScaleTargetInput] = useState<number | ''>('');
    const [scaleTargetSeeded, setScaleTargetSeeded] = useState(false);

    // Step 18 (deep-research orchestrator wait screen, WP9) — mirrors step 7's tracked-job shape;
    // the ONE-shot latch is deliberately just "requested", not "succeeded", because a stale/
    // reload-lost job id must always re-POST — the server's own in-flight guard (route
    // orchestrate.ts) adopts whatever is already running instead of double-enqueueing, the exact
    // same "just re-POST, server adopts" contract icp:generate/geo:analyze already rely on.
    const [orchestrateJobId, setOrchestrateJobId] = useState<string | null>(null);
    const [orchestrateRequested, setOrchestrateRequested] = useState(false);

    // Tenant the wizard's local state was last hydrated for. `queryClient.invalidateQueries()`
    // (called by AuthContext's switchTenant()) only resets react-query's CACHE — it does
    // nothing to this component's local useState. Without this guard, switching tenants
    // would keep showing the PREVIOUS tenant's project/profile indefinitely (the hydration
    // block below only ever runs once, gated by `hydrated`). Initialized to the CURRENT
    // tenant so a normal first mount never wastefully resets already-default state.
    const [hydratedForTenant, setHydratedForTenant] = useState(activeTenantId);
    if (hydratedForTenant !== activeTenantId) {
        // P1 fix (WP8b round 5, adversarial review) — see activeTenantIdRef's own doc comment
        // above: this assignment must happen HERE, synchronously, as the very first thing this
        // block does — not only in the passive effect — so any mutation callback that resolves
        // after this render commits (before that effect has even had a chance to run) already
        // sees the NEW tenant and gets discarded by its own `startedForTenant` guard, instead of
        // slipping through and restoring old-tenant data into the now-reset wizard.
        activeTenantIdRef.current = activeTenantId;
        setHydratedForTenant(activeTenantId);
        setHydrated(false);
        setProjectId(null);
        setStep(1);
        setCompletedGates([]);
        setReseedFromDraft(false);
        setProfile({});
        setCompanyName('');
        setContactName('');
        setWebsite('');
        setSocialLinks([]);
        setCrawlJobId(null);
        setCrawlRequested(false);
        setCrawlWasSkipped(false);
        setExplicitBackNav(false);
        setStep3Seeded(false);
        setWhatTheyDoInput('');
        setCompanyCountryInput('');
        setStep4Seeded(false);
        setProductsInput([]);
        setStep5Seeded(false);
        setMoq('');
        setLeadTime('');
        setCertifications([]);
        setCapacity('');
        setReferences([]);
        setLanguages([]);
        setStep6Seeded(false);
        setLookalikeCustomers([]);
        setTargetMarketsInput([]);
        setExclusionsInput([]);
        setHsMatchJobId(null);
        setHsMatchRequested(false);
        setExplicitBackToStep23(false);
        setExplicitBackToStep22(false);
        setMarketAnalyzeJobId(null);
        setMarketAnalyzeRequested(false);
        setIcpGenJobId(null);
        setIcpGenRequested(false);
        setExplicitBackToStep7(false);
        setIcpCardIndex(0);
        setExplicitBackToStep9(false);
        setGeoAnalyzeRequested(false);
        setGeoAnalyzeJobIds(null);
        setGeoAnalyzeTotal(0);
        setExplicitBackToStep10(false);
        setGeoCardIndex(0);
        setGeoReanalyzeJob(null);
        setCalibSampleRequested(false);
        setCalibGeographySeeded(false);
        setExplicitBackToStep11(false);
        setCalibAwaitingResample(false);
        calibResampleBaselineRef.current = null;
        calibResampleJobIdRef.current = null;
        calibResampleSuccessBaselineRef.current = null;
        calibResampleJobSucceededRef.current = false;
        setCalibrationCompanyIndex(0);
        setCalibIcpId(null);
        setCalibFeedbackRequested(false);
        setCalibApplyRequested(false);
        setCalibMarkRequested(false);
        setOfferGenJobId(null);
        setOfferGenRequested(false);
        setExplicitBackToStep15(false);
        setOfferCardIndex(0);
        setScaleTargetInput('');
        setScaleTargetSeeded(false);
        setOrchestrateJobId(null);
        setOrchestrateRequested(false);
        // Not state (a ref), but invalidated here too for consistency with every other
        // calibration field above. P2 fix, round 4 (codex): this used to hard-reset to a fixed
        // `0` — but 0 is a normal, reusable value (the same value any earlier transition could
        // already have been stamped with). A monotonic bump (matching every OTHER invalidation
        // site in this file — see calibStepTokenRef's own doc comment) makes any token captured
        // before this point provably stale afterward, with no possibility of collision regardless
        // of the exact numeric value — the tenant switch is just another bump using the exact
        // same mechanism, not a separate reset-to-a-specific-number path. Kept as belt-and-
        // suspenders alongside the round-5 `activeTenantIdRef` synchronous-assignment fix just
        // above (see that ref's own doc comment): that fix already closes the tenant-switch race
        // for every field this mutation's onSuccess touches, calibStepToken-guarded ones
        // included — this bump separately still guards step/calibration_company_index against
        // the ORIGINAL, tenant-switch-unrelated Back/resample races calibStepTokenRef exists for
        // (calibIcpId/calibIcp being reset above already makes the guarded effects inert too).
        calibStepTokenRef.current += 1;
    }

    const projectQuery = useLatestResearchProject();

    // Hydrate local state from the most recent project exactly once — later refetches
    // (e.g. after our own mutations) must not stomp on in-progress edits. Adjusted
    // synchronously during render (React's "you might not need an effect" pattern,
    // guarded by `hydrated` so it can only ever fire on the first successful load)
    // rather than in a useEffect, which would cause an extra cascading render.
    if (!hydrated && projectQuery.isSuccess) {
        const project = projectQuery.data.data[0];
        if (project) {
            const p = project.profile ?? {};
            setProjectId(project.id);
            setProfile(p);
            setCompanyName(project.name ?? '');
            setContactName(asStringField(p.contact_name));
            setWebsite(asStringField(p.website));
            setSocialLinks(asStringArray(p.social_links));

            const rawStep = project.flow_state?.step;
            let clampedStep = typeof rawStep === 'number' && rawStep >= 1 ? Math.min(rawStep, KNOWN_STEPS) : 1;
            // Step 2 is a transient wait screen — a resumed session must never re-show it
            // once the crawl has actually produced a draft (never re-run automatically).
            if (clampedStep === 2 && Object.keys(asRecord(p.ai_draft)).length > 0) clampedStep = 3;
            // Website is required before step 2 can ever be entered (step 1's own "İleri" now
            // enforces this) — if a resumed project somehow reached step 2+ without one
            // (pre-fix data, or any future edge case), clamp all the way back to step 1 rather
            // than auto-POSTing /crawl into a guaranteed 400, or rendering step 3+ with no
            // draft to confirm (review P2).
            const hasWebsite = typeof p.website === 'string' && p.website.trim().length > 0;
            if (clampedStep >= 2 && !hasWebsite) clampedStep = 1;
            setStep(clampedStep);
            setCompletedGates(asStringArray(project.flow_state?.completed_gates));
            setReseedFromDraft(project.flow_state?.reseed_from_draft === true);
            // WP8a: carried forward as-is — clamped to each list's actual bounds at RENDER
            // time (steps 8/10 below), since the ICP/geo lists aren't loaded yet at this point.
            const rawIcpIdx = project.flow_state?.icp_card_index;
            setIcpCardIndex(typeof rawIcpIdx === 'number' && rawIcpIdx >= 0 ? rawIcpIdx : 0);
            const rawGeoIdx = project.flow_state?.geo_card_index;
            setGeoCardIndex(typeof rawGeoIdx === 'number' && rawGeoIdx >= 0 ? rawGeoIdx : 0);
            // WP8b: same reasoning — clamped to the companies list's actual bounds at render
            // time (step 12 below), since the sample's companies aren't loaded yet here.
            const rawCalibIdx = project.flow_state?.calibration_company_index;
            setCalibrationCompanyIndex(typeof rawCalibIdx === 'number' && rawCalibIdx >= 0 ? rawCalibIdx : 0);
            // WP8b P1-C: the pinned calibration target ICP, if one was ever persisted — a
            // resumed project with no pin yet (older client, or never reached calibration)
            // falls back to pickBestApprovedIcp at render time below until first pinned.
            const rawCalibIcpId = project.flow_state?.calibration_icp_id;
            setCalibIcpId(typeof rawCalibIcpId === 'string' ? rawCalibIcpId : null);
            // WP9: same reasoning as icp_card_index/geo_card_index — clamped to the offers
            // list's actual bounds at render time (step 16 below), since offers aren't loaded yet.
            const rawOfferIdx = project.flow_state?.offer_card_index;
            setOfferCardIndex(typeof rawOfferIdx === 'number' && rawOfferIdx >= 0 ? rawOfferIdx : 0);
        }
        setHydrated(true);
    }

    const saveStepMut = useMutation({
        mutationFn: async ({ patch, nextStep, gate, clearDependentSeeds, removeGates, reseedFromDraft: reseedFromDraftOverride, icpCardIndexOverride, geoCardIndexOverride, calibCompanyIndexOverride, calibIcpIdOverride, calibStepToken, offerCardIndexOverride }: SaveStepVars) => {
            // Captured at the MOMENT this mutation fires, not read again in onSuccess — so a
            // tenant switch that happens while the request is in flight is detected below
            // (review P2: a stale callback from the PREVIOUS tenant must never repopulate the
            // wizard after a switch).
            const startedForTenant = activeTenantIdRef.current;
            const mergedProfile = { ...profile, ...patch };
            const baseGates = removeGates?.length ? completedGates.filter((g) => !removeGates.includes(g)) : completedGates;
            const nextGates = Array.from(new Set([...baseGates, gate]));
            // WP8a/WP8b: icp_card_index/geo_card_index/calibration_company_index ride along on
            // EVERY flow_state write (whole-object replace, no server merge) — otherwise a save
            // from an unrelated step (e.g. step 3) would silently reset the card cursors back to
            // whatever this closure's local state happened to be, or worse, drop them entirely.
            const flow_state = {
                step: nextStep,
                completed_gates: nextGates,
                // Persist-through on EVERY save (whole-object replace, no server merge — same
                // reasoning as the card cursors): default to the current value so an unrelated
                // step's save can't drop the flag; the subject-change callers pass true.
                reseed_from_draft: reseedFromDraftOverride ?? reseedFromDraft,
                icp_card_index: icpCardIndexOverride ?? icpCardIndex,
                geo_card_index: geoCardIndexOverride ?? geoCardIndex,
                calibration_company_index: calibCompanyIndexOverride ?? calibrationCompanyIndex,
                calibration_icp_id: calibIcpIdOverride ?? calibIcpId,
                offer_card_index: offerCardIndexOverride ?? offerCardIndex,
            };
            const name = companyName.trim();

            let pid = projectId;
            if (!pid) {
                // flow_state is accepted on create too (server-side WP6 fix) — a single
                // POST request, no create-then-patch window where a retry after a network
                // blip between the two calls could create a second project row.
                const created = (await api.post('/research/projects', { name, profile: mergedProfile, flow_state })).data as ResearchProjectSummary;
                pid = created.id;
            } else {
                await api.patch(`/research/projects/${pid}`, { name, profile: mergedProfile, flow_state });
            }
            return { pid, name, mergedProfile, flow_state, startedForTenant, clearDependentSeeds, calibStepToken };
        },
        onSuccess: ({ pid, name, mergedProfile, flow_state, startedForTenant, clearDependentSeeds, calibStepToken }) => {
            if (startedForTenant !== activeTenantIdRef.current) return; // tenant switched mid-flight — discard
            // WP8b P1 fix — see calibStepTokenRef's own doc comment above: only calibration-loop
            // transitions ever set `calibStepToken` (now including step 12's own intra-loop
            // company-index move, round 4 — see that call site's own comment); a mismatch against
            // the ref's LATEST value means an explicit Back/resample/index-change click
            // invalidated this transition after it was initiated, so this completion is stale.
            // P1 fix, round 4 (generalized): guards `calibration_company_index` together with
            // `step` — not `step` alone — because the SAME stale completion that must not move
            // `step` forward must also not snap the local company cursor forward out from under
            // an already-applied Back/index-change (the two are one navigation event, not two).
            // Every OTHER field below still applies normally — the server truly did persist this
            // write, only the local navigation display is held back. Calls outside the
            // calibration loop never set `calibStepToken` (stays undefined), so `stepStale` is
            // always false for them and both fields keep applying unconditionally as before.
            const stepStale = calibStepToken !== undefined && calibStepToken !== calibStepTokenRef.current;
            setProjectId(pid);
            setProfile(mergedProfile);
            setCompletedGates(flow_state.completed_gates);
            setReseedFromDraft(flow_state.reseed_from_draft);
            if (!stepStale) {
                setStep(flow_state.step);
                setCalibrationCompanyIndex(flow_state.calibration_company_index);
            }
            setIcpCardIndex(flow_state.icp_card_index);
            setGeoCardIndex(flow_state.geo_card_index);
            setCalibIcpId(flow_state.calibration_icp_id);
            setOfferCardIndex(flow_state.offer_card_index);
            if (clearDependentSeeds) {
                // The website/social links just changed — the old ai_draft (now cleared in
                // mergedProfile by the caller) is invalid, so steps 3-5's local pre-fill state
                // must re-seed from scratch next time they render, not keep showing values
                // derived from the stale draft (review P2).
                setStep3Seeded(false);
                setStep4Seeded(false);
                setStep5Seeded(false);
            }
            // Synchronously replace the shared "latest project" cache — not just
            // invalidate it — so any reader (RootRedirect included) sees the new project
            // the instant creation/update succeeds, with no refetch round-trip window
            // where a stale "no project yet" result could still be served (WP6 review P2).
            const summary: ResearchProjectSummary = { id: pid, name, profile: mergedProfile, flow_state };
            const queryKey = latestResearchProjectQueryKey(startedForTenant);
            qc.setQueryData<ResearchProjectsListResponse>(queryKey, { data: [summary] });
            qc.invalidateQueries({ queryKey });
        },
        onError: (err: unknown) => showErrorFromApi(err),
    });

    // Pulls the fresh profile and either advances to step 3 (a real ai_draft is present) or —
    // when the crawl job "succeeded" but was actually SKIPPED server-side (profileCrawl.ts's
    // staleness guard: the website/social links changed mid-flight, so no ai_draft was
    // written) — flags it and lets the auto-start effect immediately re-fire a fresh crawl
    // against the now-current input, rather than silently landing on a blank step 3 (review
    // P2). Used both when the crawl job succeeds AND when the server tells us it was already
    // crawled: separating this into its own mutation gives it its own isPending/isError/retry,
    // so a failed refetch shows a "Tekrar dene" that retries JUST this GET, not the whole crawl.
    const fetchDraftMut = useMutation({
        mutationFn: async () => {
            const startedForTenant = activeTenantIdRef.current;
            if (!projectId) throw new Error('no project');
            const fresh = (await api.get(`/research/projects/${projectId}`)).data as {
                name: string;
                profile: Record<string, unknown> | null;
                flow_state: ResearchProjectSummary['flow_state'];
            };
            return { pid: projectId, fresh, startedForTenant };
        },
        onSuccess: ({ pid, fresh, startedForTenant }) => {
            if (startedForTenant !== activeTenantIdRef.current) return; // tenant switched mid-flight — discard
            const freshProfile = fresh.profile ?? {};
            setProfile(freshProfile);
            const freshAiDraft = asRecord(freshProfile.ai_draft);
            if (Object.keys(freshAiDraft).length > 0) {
                setStep(3);
            } else {
                setCrawlWasSkipped(true);
                setCrawlJobId(null);
                setCrawlRequested(false);
                crawlMut.reset();
            }
            // Synchronously replace the shared "latest project" cache with exactly what the
            // server just returned — same pattern as saveStepMut/researchAgainMut — so a
            // client-side SPA remount (useLatestResearchProject()) can't observe a stale
            // cached profile/step even for one read once the fresh profile has actually
            // arrived (review P2).
            const summary: ResearchProjectSummary = { id: pid, name: fresh.name, profile: freshProfile, flow_state: fresh.flow_state };
            const queryKey = latestResearchProjectQueryKey(startedForTenant);
            qc.setQueryData<ResearchProjectsListResponse>(queryKey, { data: [summary] });
            qc.invalidateQueries({ queryKey });
        },
        onError: (err: unknown) => showErrorFromApi(err),
    });

    // ── Step 2: kick off profile:crawl the first time we land here with no draft yet ──
    const crawlMut = useMutation({
        mutationFn: async () => {
            const startedForTenant = activeTenantIdRef.current;
            if (!projectId) throw new Error('profile:crawl requires a project');
            const resp = (await api.post(`/research/projects/${projectId}/crawl`)).data as CrawlEnqueueResponse;
            return { resp, startedForTenant };
        },
        onSuccess: ({ resp, startedForTenant }) => {
            if (startedForTenant !== activeTenantIdRef.current) return; // tenant switched mid-flight — discard
            if (resp.already_crawled) {
                // Server already has a draft (e.g. this same session re-landed on step 2
                // with a stale local cache) — pull it in directly, never re-enqueue.
                fetchDraftMut.mutate();
            } else if (resp.id) {
                setCrawlJobId(resp.id);
            }
        },
        onError: (err: unknown) => showErrorFromApi(err),
    });

    // Tenant-scoped like latestResearchProjectQueryKey, for consistency (a job id is already
    // tenant-bound server-side, but this keeps every cache key in the file following the same
    // convention — WP7 review P2).
    const crawlJobQuery = useQuery<CrawlJob>({
        queryKey: ['research', 'job', crawlJobId, activeTenantId],
        queryFn: async () => (await api.get(`/research/jobs/${crawlJobId}`)).data,
        enabled: !!crawlJobId,
        refetchInterval: (query) => (JOB_RUNNING(query.state.data?.status) ? 1500 : false),
    });
    const crawlJobStatus = crawlJobQuery.data?.status;

    // Auto-start the crawl once, when we actually land on step 2 with no ai_draft yet. Gated
    // by the explicit `crawlRequested` latch (not crawlMut.isPending/isError) — see its doc
    // comment: the already_crawled response path hands off to a DIFFERENT mutation
    // (fetchDraftMut), so crawlMut's own pending/error state alone can't prevent a re-POST in
    // the gap between the two mutations settling.
    useEffect(() => {
        if (step !== 2 || !projectId) return;
        if (hasAiDraft) return; // handled by the render-time skip above
        if (crawlRequested) return;
        setCrawlRequested(true);
        crawlMut.mutate();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step, projectId, hasAiDraft, crawlRequested]);

    // On crawl success, pull the fresh ai_draft into local state and auto-advance to step 3.
    // Suppressed by `explicitBackNav` exactly once (review P1): the render-time "hasAiDraft ->
    // skip to 3" check already respects this latch, but `crawlJobStatus` stays cached as
    // 'succeeded' for the same job after an explicit Back click from step 3, so WITHOUT this
    // check this effect re-fires the instant step becomes 2 again and calls fetchDraftMut,
    // whose own onSuccess unconditionally calls setStep(3) — bouncing the user straight back
    // to step 3 a moment after they clicked Back. `retryCrawl()` clears `explicitBackNav`
    // alongside its other resets, so a genuinely fresh crawl (via "Try again" or "Research
    // again") still advances normally once IT completes.
    useEffect(() => {
        if (step !== 2 || crawlJobStatus !== 'succeeded' || explicitBackNav) return;
        if (fetchDraftMut.isPending || fetchDraftMut.isError) return; // in flight, or user must retry explicitly
        fetchDraftMut.mutate();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step, crawlJobStatus, fetchDraftMut.isPending, fetchDraftMut.isError, explicitBackNav]);

    // Consume the explicit-Back marker the moment we actually LEAVE step 2 (in either
    // direction) — so it only ever suppresses the auto-skip-forward guard for the single
    // step-2 visit it was set for, and a later forward arrival at step 2 (e.g. re-submitting
    // step 1) sees a clean slate and auto-skips normally if a draft already exists.
    useEffect(() => {
        if (step !== 2) setExplicitBackNav(false);
    }, [step]);

    // Same consume-on-leave shape for step 22's own one-shot latch (see explicitBackToStep22's
    // declaration above).
    useEffect(() => {
        if (step !== 22) setExplicitBackToStep22(false);
    }, [step]);

    // Same consume-on-leave shape for step 23's own one-shot latch (see explicitBackToStep23's
    // declaration above).
    useEffect(() => {
        if (step !== 23) setExplicitBackToStep23(false);
    }, [step]);

    // Same consume-on-leave shape for step 7's own one-shot latch (see explicitBackToStep7's
    // declaration above).
    useEffect(() => {
        if (step !== 7) setExplicitBackToStep7(false);
    }, [step]);

    // Same consume-on-leave shape for step 9's own one-shot latch (see explicitBackToStep9's
    // declaration above).
    useEffect(() => {
        if (step !== 9) setExplicitBackToStep9(false);
    }, [step]);

    // Same consume-on-leave shape for step 10's own one-shot latch (see explicitBackToStep10's
    // declaration above).
    useEffect(() => {
        if (step !== 10) setExplicitBackToStep10(false);
    }, [step]);

    const retryCrawl = () => {
        setCrawlJobId(null);
        setCrawlRequested(false);
        setCrawlWasSkipped(false);
        // A genuinely fresh crawl attempt (failure retry, or "Research again" from the explicit-
        // Back screen) is itself the user's forward intent — consume the latch here so the
        // crawl-success effect above is free to auto-advance once THIS new attempt completes
        // (it would otherwise stay suppressed forever, since `step` never actually leaves 2
        // during this whole flow to trigger the normal "leaving step 2" consume effect).
        setExplicitBackNav(false);
        crawlMut.reset();
        fetchDraftMut.reset();
    };

    // "Tekrar araştır" from the "already researched" screen (step 2 reached via explicit Back
    // with a draft already present) — an EXPLICIT manual re-run the user asked for, distinct
    // from retryCrawl (which only re-attempts after a genuine failure). Must clear ai_draft
    // SERVER-SIDE first: the crawl route's already-crawled guard (meant only to prevent
    // double-enqueue) would otherwise short-circuit a plain POST /crawl and hand back the same
    // stale draft instead of actually re-researching (review P2).
    const researchAgainMut = useMutation({
        mutationFn: async () => {
            const startedForTenant = activeTenantIdRef.current;
            const pid = projectId;
            if (!pid) throw new Error('no project');
            const profileWithoutDraft = { ...profile };
            delete profileWithoutDraft.ai_draft;
            // company_country is owned by step 3, but profileCrawl.ts only auto-fills it when
            // still empty — a leftover OLD confirmed/auto-filled guess would otherwise outrank
            // the fresh re-crawl's correct one (review P2). Clear it alongside ai_draft.
            delete profileWithoutDraft.company_country;
            // Persist flow_state.step BACK to 2 in the SAME request as clearing the draft — the
            // earlier "Geri" clicks that got the user from a later step back to step 2 are
            // local-only navigation (never PATCHed), so the server's flow_state.step is still
            // whatever later step the user had reached. Without repersisting step=2 here, a
            // reload at any point during this "research again" flow would resume hydration at
            // that stale LATER step — showing pre-re-crawl what_they_do/products instead of
            // landing back on the crawl screen (review P2). Also demote steps 3-5's gates —
            // they cover company_country/products/differentiators, ALL of which the fresh
            // re-crawl can newly inform, and the completed_gates-gated pre-fill logic must not
            // treat any of those already-answered fields as locked out of the fresh draft
            // forever (review P2 — step 3 alone wasn't enough; 4 and 5 have the identical bug).
            const demotedGates = new Set(['step3', 'step4', 'step5']);
            // reseed_from_draft: this explicit re-research demoted steps 3-5, so their gate-absent
            // pre-fill must come from the FRESH crawl, not the leftover confirmed products/summary/
            // differentiators of the subject we just re-researched (review P2 — the stale fields are
            // preserved in `profile`, only re-seeded away from until the user re-confirms each step).
            const flow_state = { step: 2, completed_gates: completedGates.filter((g) => !demotedGates.has(g)), reseed_from_draft: true };
            await api.patch(`/research/projects/${pid}`, { profile: profileWithoutDraft, flow_state });
            return { pid, profileWithoutDraft, flow_state, startedForTenant };
        },
        onSuccess: ({ pid, profileWithoutDraft, flow_state, startedForTenant }) => {
            if (startedForTenant !== activeTenantIdRef.current) return; // tenant switched mid-flight — discard
            setProfile(profileWithoutDraft);
            setCompletedGates(flow_state.completed_gates);
            setReseedFromDraft(flow_state.reseed_from_draft);
            setStep(2); // explicit — belt-and-suspenders even though we're already here
            setStep3Seeded(false);
            setStep4Seeded(false);
            setStep5Seeded(false);
            retryCrawl();
            // Synchronously replace the shared "latest project" cache — same pattern as
            // saveStepMut/fetchDraftMut — so a client-side SPA remount mid-"research again"
            // can't observe the stale OLD draft/later step even once (review P2).
            const summary: ResearchProjectSummary = { id: pid, name: companyName.trim(), profile: profileWithoutDraft, flow_state };
            const queryKey = latestResearchProjectQueryKey(startedForTenant);
            qc.setQueryData<ResearchProjectsListResponse>(queryKey, { data: [summary] });
            qc.invalidateQueries({ queryKey });
        },
        onError: (err: unknown) => showErrorFromApi(err),
    });

    const goBackToStep2 = () => {
        // Marks this specific arrival at step 2 as "explicit Back" — see explicitBackNav's
        // doc comment above.
        setExplicitBackNav(true);
        setStep(2);
    };

    // ── Step 22 (WP11 raw step — flow-order between 6 and 7, see STEP_ORDER above): auto-run
    // hs:match if the project has no HS code rows yet ──────────────────────────────────────
    const hsQuery = useQuery<{ data: HsCodeRow[] }>({
        queryKey: ['research', 'hs', projectId, activeTenantId],
        queryFn: async () => (await api.get(`/research/hs?project_id=${projectId}`)).data,
        enabled: !!projectId && (step === 22 || step === 23),
    });
    const hsRows = hsQuery.data?.data ?? [];
    const hsCandidates = hsRows.filter((r) => r.status === 'candidate');
    const hsApprovedCount = hsRows.filter((r) => r.status === 'approved').length;

    const hsMatchMut = useMutation({
        mutationFn: async () => {
            const startedForTenant = activeTenantIdRef.current;
            if (!projectId) throw new Error('no project');
            const job = (await api.post('/research/hs/match', { project_id: projectId })).data as { id: string };
            return { job, startedForTenant };
        },
        onSuccess: ({ job, startedForTenant }) => {
            if (startedForTenant !== activeTenantIdRef.current) return; // tenant switched mid-flight — discard
            setHsMatchJobId(job.id);
        },
        onError: (err: unknown) => showErrorFromApi(err),
    });

    const hsMatchJobQuery = useQuery<{ status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'; progress: Record<string, unknown>; error: string | null }>({
        queryKey: ['research', 'job', hsMatchJobId, activeTenantId],
        queryFn: async () => (await api.get(`/research/jobs/${hsMatchJobId}`)).data,
        enabled: !!hsMatchJobId,
        refetchInterval: (query) => (JOB_RUNNING(query.state.data?.status) ? 1500 : false),
    });
    const hsMatchJobStatus = hsMatchJobQuery.data?.status;
    const hsMatchSuccessBaselineRef = useRef<number | null>(null);

    // Same gap as icpGenJobStatus's own fix below: the job query's refetchInterval stopping is
    // not the same as the HS codes LIST becoming fresh.
    useEffect(() => {
        if (hsMatchJobStatus === 'succeeded') {
            // Mirror calibResampleSuccessBaselineRef's causal baseline: the job reads
            // 'succeeded' one render before this invalidate-triggered HS-list refetch can land.
            // Snapshot that exact success render so only a STRICTLY later dataUpdatedAt proves
            // the list now reflects this job, rather than an unrelated earlier refresh.
            hsMatchSuccessBaselineRef.current = hsQuery.dataUpdatedAt;
            qc.invalidateQueries({ queryKey: ['research', 'hs', projectId, activeTenantId] });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [hsMatchJobStatus]);

    // Zero-candidate hs:match completion is otherwise only tracked via session-local React
    // state (hsMatchJobId/hsMatchRequested) — hsRows.length stays 0 in that case too, so it
    // can't distinguish "never ran" from "ran and genuinely found nothing". A reload in the
    // narrow window between the auto-skip effect below detecting success and its step-23 PATCH
    // landing would otherwise re-trigger (and re-bill) hs:match. localStorage survives a
    // same-tab reload; the flag is set the instant zero-candidate success is detected.
    const hsMatchZeroKey = projectId ? `research.hsMatchZero.${projectId}` : null;
    const hsMatchZeroPersisted = hsMatchZeroKey ? localStorage.getItem(hsMatchZeroKey) === '1' : false;

    // Auto-start HS matching once, when we land on step 22 with no HS code rows yet (mirrors
    // step 7's icp:generate auto-start below).
    useEffect(() => {
        if (step !== 22 || !projectId) return;
        if (!hsQuery.isSuccess) return;
        if (hsRows.length > 0) return; // resuming with candidates already generated
        if (hsMatchZeroPersisted) return; // already ran to a confirmed zero-candidate result
        if (hsMatchRequested) return;
        setHsMatchRequested(true);
        hsMatchMut.mutate();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step, projectId, hsQuery.isSuccess, hsRows.length, hsMatchRequested, hsMatchZeroPersisted]);

    // Auto-skip step 22 entirely once hs:match has definitively produced zero candidates (a
    // service-only company, or every candidate failed live Comtrade validation — WP11 spec:
    // "hizmet-ağırlıklı firmada 0 aday dönerse client adım 7'yi otomatik atlar"). Gated on the
    // job having actually reached 'succeeded' (not just "rows are empty", which is also true
    // while the job is still running) so this can never fire before generation had a real
    // chance to produce candidates. Suppressed by `explicitBackToStep22` exactly once, same
    // class of latch as explicitBackToStep7/9/10 below.
    useEffect(() => {
        if (step !== 22 || hsMatchJobStatus !== 'succeeded' || explicitBackToStep22) return;
        // As with calibResampleSuccessBaselineRef, success is visible one render before the
        // invalidate effect above can land its asynchronous HS-list refetch. Until dataUpdatedAt
        // advances STRICTLY past that success-time snapshot, hsRows may still be the stale empty
        // pre-job list and cannot prove that this run genuinely produced zero candidates.
        if (hsMatchSuccessBaselineRef.current === null || hsQuery.dataUpdatedAt <= hsMatchSuccessBaselineRef.current) return;
        if (hsRows.length > 0) return;
        if (hsMatchZeroKey) localStorage.setItem(hsMatchZeroKey, '1');
        // Review fix (BUG 3 medium): this is a genuinely fresh landing on step 23 driven by a
        // hs:match run that just completed — a PRIOR market:analyze success recorded in
        // localStorage from an earlier visit (before the user went back and re-ran matching)
        // must not silently skip analysis of whatever is approved now. `retryMarketAnalyze` is
        // declared further down in this same component body but already initialized by the time
        // this effect callback actually runs (effects fire after the full render completes), so
        // referencing it here is safe.
        retryMarketAnalyze();
        saveStepMut.mutate({ patch: {}, nextStep: 23, gate: 'step22' });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step, hsMatchJobStatus, hsQuery.dataUpdatedAt, hsRows.length, explicitBackToStep22]);

    const retryHsMatch = () => {
        if (hsMatchZeroKey) localStorage.removeItem(hsMatchZeroKey);
        hsMatchSuccessBaselineRef.current = null;
        setHsMatchJobId(null);
        setHsMatchRequested(false);
        hsMatchMut.reset();
    };

    // ── Step 23 (WP11 raw step): auto-run market:analyze once >=1 HS code is approved ───────
    const marketAnalyzeMut = useMutation({
        mutationFn: async () => {
            const startedForTenant = activeTenantIdRef.current;
            if (!projectId) throw new Error('no project');
            const job = (await api.post('/research/hs/market-analyze', { project_id: projectId })).data as { id: string };
            return { job, startedForTenant };
        },
        onSuccess: ({ job, startedForTenant }) => {
            if (startedForTenant !== activeTenantIdRef.current) return; // tenant switched mid-flight — discard
            setMarketAnalyzeJobId(job.id);
        },
        onError: (err: unknown) => showErrorFromApi(err),
    });

    const marketAnalyzeJobQuery = useQuery<{ status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'; progress: Record<string, unknown>; error: string | null }>({
        queryKey: ['research', 'job', marketAnalyzeJobId, activeTenantId],
        queryFn: async () => (await api.get(`/research/jobs/${marketAnalyzeJobId}`)).data,
        enabled: !!marketAnalyzeJobId,
        refetchInterval: (query) => (JOB_RUNNING(query.state.data?.status) ? 1500 : false),
    });
    const marketAnalyzeJobStatus = marketAnalyzeJobQuery.data?.status;

    // BUG 3 fix — same class of gap as hsMatchZeroKey above: a successful market:analyze run was
    // otherwise only tracked via session-local React state (marketAnalyzeJobId/Requested), which
    // resets on remount. A reload landing in the narrow window between this job reaching
    // 'succeeded' and its step-23->7 PATCH landing would find `marketAnalyzeJobId` back at null
    // and `marketAnalyzeRequested` back at false, and the auto-start effect below would fire a
    // SECOND full, paid Comtrade run against the same approved HS codes. localStorage survives a
    // same-tab reload; the flag is set the instant success is observed, mirroring hsMatchZeroKey's
    // own persisted-completion pattern exactly (same key shape, same read/set/clear sites).
    const marketAnalyzeDoneKey = projectId ? `research.marketAnalyzeDone.${projectId}` : null;
    const marketAnalyzeDonePersisted = marketAnalyzeDoneKey ? localStorage.getItem(marketAnalyzeDoneKey) === '1' : false;

    // Auto-skip step 23 entirely when there is nothing approved to analyze — market:analyze
    // itself 409s with zero approved codes, so this must be checked BEFORE ever enqueuing.
    // Mirrors step 22's own zero-candidate skip, one hop later; `hsQuery` is already loaded by
    // the time this can fire (enabled for both step 22 and 23 above).
    useEffect(() => {
        if (step !== 23 || !hsQuery.isSuccess || hsApprovedCount > 0 || explicitBackToStep23) return;
        saveStepMut.mutate({ patch: {}, nextStep: 7, gate: 'step23' });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step, hsQuery.isSuccess, hsApprovedCount, explicitBackToStep23]);

    // Auto-start market:analyze once, when we land on step 23 with >=1 approved code and no run
    // in flight yet this session (the skip effect above owns the zero-approved case). BUG 3 fix:
    // also gated on `marketAnalyzeDonePersisted` — a reload after a completed run must resume
    // straight through (the completion effect below re-fires its PATCH), never re-enqueue.
    useEffect(() => {
        if (step !== 23 || !projectId) return;
        if (!hsQuery.isSuccess || hsApprovedCount === 0) return;
        if (marketAnalyzeDonePersisted) return;
        if (marketAnalyzeRequested) return;
        setMarketAnalyzeRequested(true);
        marketAnalyzeMut.mutate();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step, projectId, hsQuery.isSuccess, hsApprovedCount, marketAnalyzeRequested, marketAnalyzeDonePersisted]);

    // Once market:analyze succeeds, advance to step 7 — same "job succeeded, no list to wait
    // for" shape as step 9's batch geo:analyze completion. A failure stays on step 23 and shows
    // the same Alert+retry pattern every other wait screen in this file uses (see the step 23
    // JSX below) rather than silently swallowing the error and advancing anyway. BUG 3 fix: the
    // persisted flag is set HERE, the instant success is observed — before the PATCH even fires —
    // same ordering as hsMatchZeroKey's own set-then-mutate above, so a reload racing this exact
    // effect still lands on a client that already knows the run completed.
    //
    // P1 follow-up fix: also fire from `marketAnalyzeDonePersisted` alone (not only a live
    // `marketAnalyzeJobStatus === 'succeeded'` transition). A reload that lands after the flag
    // was set but before this PATCH landed resets `marketAnalyzeJobId`/`marketAnalyzeJobStatus`
    // to null (plain React state, no server hydration) and the auto-start effect above is the
    // ONLY thing that would ever repopulate them — but that effect is itself suppressed by the
    // same persisted flag, so `marketAnalyzeJobStatus` could otherwise never become 'succeeded'
    // again and this effect would never re-fire, stranding the user on step 23 with no error and
    // no reachable retry (retry is gated on an actual failure, which never happens here either).
    //
    // Review fix: `marketAnalyzeDonePersisted` is re-derived from localStorage on every render
    // (not a ref), so calling `saveStepMut.mutate()` below flips `saveStepMut.isPending`, which
    // re-renders this component and recomputes the dependency as unchanged-but-now-true only
    // AFTER the flag write above already ran once — that re-render alone was enough to re-run
    // this effect and fire a second overlapping PATCH. Gate on `saveStepMut.isPending` the same
    // way step 2's crawl-success effect gates on `fetchDraftMut.isPending` above. Also suppressed
    // by `explicitBackToStep23` (same one-shot latch the zero-approved skip effect above already
    // honors): without it, clicking Back from step 7 lands on 23 for a single frame and this
    // effect immediately PATCHes right back to 7, making that Back button unreachable.
    //
    // Finding 1 fix (review): `saveStepMut.isPending` going true->false on a FAILED PATCH (network
    // blip, 409 gate conflict, server error) also re-runs this effect — and since the success
    // conditions above are still true and `step` is still 23 (the failed PATCH never advanced it),
    // the effect immediately re-fired the same `mutate()` call with no isError guard, looping
    // forever with repeated error toasts and no escape short of leaving the step. Mirrors step 2's
    // own crawl-success effect above, which gates on `fetchDraftMut.isPending || fetchDraftMut.isError`
    // for the identical reason — `saveStepMut.isError` is safe to gate on here specifically because
    // `step` can only ever BECOME 23 via a saveStepMut PATCH that already succeeded (onSuccess sets
    // `step` from the server response), so arriving on this screen always starts with isError false;
    // it only flips true from a failure of THIS effect's own PATCH, never a stale unrelated one. The
    // step 23 JSX below now surfaces that failure (`stepPatchFailed`) with its own retry button that
    // calls `saveStepMut.mutate()` directly, which resets `isError` immediately on the new attempt.
    useEffect(() => {
        if (step !== 23 || explicitBackToStep23) return;
        if (saveStepMut.isPending || saveStepMut.isError) return; // in flight, or user must retry explicitly
        if (marketAnalyzeJobStatus !== 'succeeded' && !marketAnalyzeDonePersisted) return;
        if (marketAnalyzeDoneKey && !marketAnalyzeDonePersisted) localStorage.setItem(marketAnalyzeDoneKey, '1');
        saveStepMut.mutate({ patch: {}, nextStep: 7, gate: 'step23' });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step, marketAnalyzeJobStatus, marketAnalyzeDonePersisted, explicitBackToStep23, saveStepMut.isPending, saveStepMut.isError]);

    const retryMarketAnalyze = () => {
        if (marketAnalyzeDoneKey) localStorage.removeItem(marketAnalyzeDoneKey);
        setMarketAnalyzeJobId(null);
        setMarketAnalyzeRequested(false);
        marketAnalyzeMut.reset();
    };

    // ── Step 7: auto-generate ICPs if the project has none yet ────────────────────
    const icpsQuery = useQuery<{ data: ResearchIcp[] }>({
        queryKey: ['research', 'icps', projectId, activeTenantId],
        queryFn: async () => (await api.get(`/research/icps?project_id=${projectId}`)).data,
        enabled: !!projectId && step >= 7,
    });
    const icps = icpsQuery.data?.data ?? [];

    const icpGenMut = useMutation({
        mutationFn: async () => {
            const startedForTenant = activeTenantIdRef.current;
            if (!projectId) throw new Error('no project');
            // count:4 mirrors ResearchPage.tsx's own default for the same /generate endpoint.
            const job = (await api.post('/research/icps/generate', { project_id: projectId, count: 4 })).data as { id: string };
            return { job, startedForTenant };
        },
        onSuccess: ({ job, startedForTenant }) => {
            if (startedForTenant !== activeTenantIdRef.current) return; // tenant switched mid-flight — discard
            setIcpGenJobId(job.id);
        },
        onError: (err: unknown) => showErrorFromApi(err),
    });

    const icpGenJobQuery = useQuery<{ status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'; progress: Record<string, unknown>; error: string | null }>({
        queryKey: ['research', 'job', icpGenJobId, activeTenantId],
        queryFn: async () => (await api.get(`/research/jobs/${icpGenJobId}`)).data,
        enabled: !!icpGenJobId,
        refetchInterval: (query) => (JOB_RUNNING(query.state.data?.status) ? 1500 : false),
    });
    const icpGenJobStatus = icpGenJobQuery.data?.status;

    // Fix (adversarial review P1, found while building WP9's analogous step 15 below): nothing
    // else ever refetches `icpsQuery` once the generation job reaches a terminal state — the
    // JOB query's own refetchInterval stopping is not the same as the ICPs LIST becoming fresh.
    // Without this, the auto-advance effect right below can never observe `icps.length > 0`
    // after a fresh generation (only an incidental window refocus/remount would rescue it) — a
    // pre-existing gap in WP6/WP8a's own icp:generate wait screen, fixed here alongside the
    // identical WP9 gap for step 15's offer generation (see offerGenJobStatus further below).
    useEffect(() => {
        if (icpGenJobStatus === 'succeeded') qc.invalidateQueries({ queryKey: ['research', 'icps', projectId, activeTenantId] });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [icpGenJobStatus]);

    // Auto-start ICP generation once, when we land on step 7 with no ICPs yet.
    useEffect(() => {
        if (step !== 7 || !projectId) return;
        if (!icpsQuery.isSuccess) return; // wait for the "does the project already have ICPs" check
        if (icps.length > 0) return; // resuming with ICPs already generated — nothing to do
        if (icpGenRequested) return;
        setIcpGenRequested(true);
        icpGenMut.mutate();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step, projectId, icpsQuery.isSuccess, icps.length, icpGenRequested]);

    // Once ICPs exist (freshly generated, or already there on resume), advance to step 8.
    // Suppressed by `explicitBackToStep7` exactly once: an explicit Back click from step 8's
    // first card must actually land the user ON step 7 (so its own Back-to-6 button is
    // reachable), not bounce them right back to step 8 (review P2) — the same class of bug
    // step 2's `explicitBackNav` already solves for the crawl wait screen.
    useEffect(() => {
        if (step !== 7 || !icpsQuery.isSuccess || icps.length === 0 || explicitBackToStep7) return;
        saveStepMut.mutate({ patch: {}, nextStep: 8, gate: 'step7', icpCardIndexOverride: 0 });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step, icpsQuery.isSuccess, icps.length, explicitBackToStep7]);

    const retryIcpGen = () => {
        setIcpGenJobId(null);
        setIcpGenRequested(false);
        icpGenMut.reset();
    };

    // ── Step 9: batch geo:analyze every geography cell created in step 8 that has
    // no spec yet ──────────────────────────────────────────────────────────────
    // Aggregated across ALL of the project's ICPs — GET /research/geographies only filters
    // by icp_id (no project_id option on that route), so this fetches per-ICP and flattens
    // (icps is already scoped to this project via the step-7 query above).
    const allGeoCellsKey = ['research', 'geographies', 'wizard-all', projectId, icps.map((i) => i.id).join(','), activeTenantId] as const;
    const allGeoCellsQuery = useQuery<GeoCell[]>({
        queryKey: allGeoCellsKey,
        queryFn: async () => {
            const results = await Promise.all(icps.map((icp) => api.get(`/research/geographies?icp_id=${icp.id}`)));
            return results.flatMap((r) => (r.data.data as GeoCell[] | undefined) ?? []);
        },
        enabled: icps.length > 0 && step >= 9,
    });
    const allGeoCells = allGeoCellsQuery.data ?? [];
    // Rejected cells are no longer part of the ICP: they must not be (re-)analyzed in step 9
    // nor shown as reviewable cards in step 10's active flow. IcpCountryChips still renders
    // them in red elsewhere — this filter only scopes the wizard's own step 9/10 flow.
    const activeGeoCells = allGeoCells.filter((c) => c.status !== 'rejected');

    const startBatchAnalyzeMut = useMutation({
        mutationFn: async () => {
            const startedForTenant = activeTenantIdRef.current;
            const unanalyzed = activeGeoCells.filter((c) => !c.spec);
            if (unanalyzed.length === 0) return { jobIds: [] as string[], total: 0, startedForTenant };
            // Independent per cell (allSettled): a 402/409 on one cell must not block the
            // others — collect whichever jobs actually started and poll only those.
            const results = await Promise.allSettled(unanalyzed.map((c) => api.post(`/research/geographies/${c.id}/analyze`)));
            const jobIds: string[] = [];
            for (const r of results) {
                if (r.status === 'fulfilled') {
                    const job = r.value.data as { id?: string };
                    if (job?.id) jobIds.push(job.id);
                }
            }
            return { jobIds, total: unanalyzed.length, startedForTenant };
        },
        onSuccess: ({ jobIds, total, startedForTenant }) => {
            if (startedForTenant !== activeTenantIdRef.current) return; // tenant switched mid-flight — discard
            setGeoAnalyzeJobIds(jobIds);
            setGeoAnalyzeTotal(total);
        },
        onError: (err: unknown) => showErrorFromApi(err),
    });

    // Auto-start the batch once, when we land on step 9 with the geo cell list loaded.
    useEffect(() => {
        if (step !== 9) return;
        if (!allGeoCellsQuery.isSuccess) return;
        if (geoAnalyzeRequested) return;
        setGeoAnalyzeRequested(true);
        startBatchAnalyzeMut.mutate();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step, allGeoCellsQuery.isSuccess, geoAnalyzeRequested]);

    // Poll every job this batch started, collectively (don't block forever on one stuck job —
    // "done" here means terminal, succeeded OR failed).
    const geoAnalyzeJobsQueries = useQueries({
        queries: (geoAnalyzeJobIds ?? []).map((id) => ({
            queryKey: ['research', 'job', id, activeTenantId] as const,
            queryFn: async () => (await api.get(`/research/jobs/${id}`)).data as { status?: string },
            enabled: !!id,
            refetchInterval: (query: { state: { data?: { status?: string } } }) => (JOB_RUNNING(query.state.data?.status) ? 2000 : false),
        })),
    });
    const geoAnalyzeDoneCount = geoAnalyzeJobsQueries.filter((q) => q.data && !JOB_RUNNING(q.data.status)).length;
    const geoAnalyzeAllDone = geoAnalyzeJobIds !== null && geoAnalyzeDoneCount === geoAnalyzeJobIds.length;

    // Zero cells to analyze resolves this instantly (empty jobIds, 0 === 0) — a near-instant,
    // imperceptible pass-through rather than ever showing meaningful wait-screen content, which
    // is the practical equivalent of "skip step 9 entirely" for a screen with nothing to wait for.
    // Suppressed by `explicitBackToStep9` exactly once: `geoAnalyzeAllDone` is trivially already
    // true the moment the user could BE on step 10 to click Back from it in the first place, so
    // without this latch Back is a dead button for every single user past step 9 (review P1) —
    // the same class of bug explicitBackNav/explicitBackToStep7 already solve at their boundaries.
    useEffect(() => {
        if (step !== 9 || geoAnalyzeJobIds === null || !geoAnalyzeAllDone || explicitBackToStep9) return;
        // Invalidate BEFORE advancing (review P1): without this, step 10 renders from the
        // pre-analysis snapshot of the cells query — every cell looks unanalyzed even though
        // the server already persisted the real spec, and a user "fixing" that by clicking
        // Re-analyze gets billed again for an analysis that already ran and succeeded. The
        // single-cell re-analyze mutation already invalidates on success (line ~726); this batch
        // path was the one gap.
        qc.invalidateQueries({ queryKey: allGeoCellsKey });
        saveStepMut.mutate({ patch: {}, nextStep: 10, gate: 'step9', geoCardIndexOverride: 0 });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step, geoAnalyzeJobIds, geoAnalyzeAllDone, explicitBackToStep9]);

    const retryBatchAnalyze = () => {
        setGeoAnalyzeRequested(false);
        setGeoAnalyzeJobIds(null);
        setGeoAnalyzeTotal(0);
        startBatchAnalyzeMut.reset();
    };

    // ── Step 10: single-cell "Re-analyze" (GeoCellDetail's own button, same job-tracking
    // shape as GeographiesPanel's own `job` state for the identical button) ───────
    const geoReanalyzeMut = useMutation({
        mutationFn: async (geoId: string) => {
            const startedForTenant = activeTenantIdRef.current;
            const started = (await api.post(`/research/geographies/${geoId}/analyze`)).data as { id: string };
            return { id: started.id, geoId, startedForTenant };
        },
        onSuccess: ({ id, geoId, startedForTenant }) => {
            if (startedForTenant !== activeTenantIdRef.current) return; // tenant switched mid-flight — discard
            setGeoReanalyzeJob({ id, geoId });
        },
        onError: (err: unknown) => showErrorFromApi(err),
    });

    const geoReanalyzeJobQuery = useQuery<{ status: string }>({
        queryKey: ['research', 'job', geoReanalyzeJob?.id, activeTenantId],
        queryFn: async () => (await api.get(`/research/jobs/${geoReanalyzeJob?.id}`)).data,
        enabled: !!geoReanalyzeJob,
        refetchInterval: (query) => (JOB_RUNNING(query.state.data?.status) ? 2500 : false),
    });
    const geoReanalyzeStatus = geoReanalyzeJobQuery.data?.status;
    useEffect(() => {
        if (geoReanalyzeStatus === 'succeeded') {
            qc.invalidateQueries({ queryKey: allGeoCellsKey });
            setGeoReanalyzeJob(null);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [geoReanalyzeStatus]);

    // Passed to GeoCellDetail as onChanged — same cache-seed-then-invalidate pattern
    // GeographiesPanel's own parent uses for the identical prop.
    const handleGeoCellChanged = (row?: GeoCell) => {
        if (row) {
            qc.setQueryData<GeoCell[]>(allGeoCellsKey, (old) => (old ? old.map((c) => (c.id === row.id ? row : c)) : old));
        }
        qc.invalidateQueries({ queryKey: allGeoCellsKey });
    };

    // Zero geo cells (e.g. the user added no countries across any ICP card in step 8) must not
    // strand the wizard on step 10's per-card loader forever — with an empty list, `currentCell`
    // is permanently null while `isLoading` is false, so the render guard alone never resolves
    // (review P1). Fall straight through to step 11, the same "nothing to do here" pass-through
    // step 9 already applies to itself for the zero-jobs case. Suppressed by
    // `explicitBackToStep10` exactly once: this effect would otherwise re-fire the instant it
    // sees the same empty list that got the user to step 11 in the first place, bouncing an
    // explicit Back-from-11 click straight back to 11 (review P2).
    useEffect(() => {
        if (step !== 10 || !allGeoCellsQuery.isSuccess || allGeoCells.length > 0 || explicitBackToStep10) return;
        saveStepMut.mutate({ patch: {}, nextStep: 11, gate: 'step10', geoCardIndexOverride: 0 });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step, allGeoCellsQuery.isSuccess, allGeoCells.length, explicitBackToStep10]);

    // ── Steps 11-14: calibration loop (WP8b) — reuses useCalibration verbatim (same hook
    // CalibrationDrawer.tsx now also consumes) ─────────────────────────────────────────────
    // Picked ONCE the project's ICPs are loaded (icps is already fetched above, kept enabled
    // for step>=7) — the approved ICP with the highest human_score. Null if none are approved
    // yet, in which case steps 11-14 fall through to the step-15 placeholder (see the render
    // guard below) rather than attempting calibration on nothing.
    // P1-C fix (codex xhigh review): the FALLBACK candidate only — used to pin `calibIcpId` the
    // first time we're actually IN the calibration step range, and as the render guard's
    // last-resort check below. Once `calibIcpId` itself is set, `calibIcp` resolves from it
    // directly (see below) and this fallback is no longer consulted, so a LATER change to which
    // ICP is "best approved" (e.g. the user approves a different/higher-scored ICP after
    // calibration already started) can never retarget an in-progress calibration loop.
    const calibIcpFallback = pickBestApprovedIcp(icps);
    // Pin synchronously during render — same "you might not need an effect" idiom as the
    // hydration/tenant-switch blocks above — the FIRST time we're in the calibration step range
    // (11-14) WITH a candidate. Gated on `step` (codex xhigh round 2): `icps` is fetched/enabled
    // starting at step 7, and step 8 approves ICP cards ONE AT A TIME — without this gate, the
    // moment the FIRST card gets approved (while the user may be about to approve a second,
    // higher-`human_score` one right after, still on step 8) this would pin `calibIcpId` to that
    // first approval and never re-pin to the actual best once the user later reaches step 11.
    // Requiring `step >= 11` ensures ICP approval (step 8) and geo approval (steps 9-10) are
    // already behind the user in this linear wizard, so `pickBestApprovedIcp` reflects the FINAL
    // set of approvals, not a partial one. Once pinned, `calibIcp` below resolves the pinned id
    // REGARDLESS of its current status, so the server-side apply-revision route demoting
    // approved->draft mid-loop can never flip or null the active calibration target out from
    // under the user (codex xhigh P1-C — recomputing via pickBestApprovedIcp on every render was
    // the original bug).
    // Range widened to 16 (P2 fix, adversarial review): steps 15/16 depend on calibIcp the same
    // way 11-14 do (see the "nothing to calibrate" guard's own widened range below) — without
    // this, a project whose flow_state.step somehow reached 15+ with calibration_icp_id never
    // persisted would never self-heal to the fallback candidate either.
    if (step >= 11 && step <= 16 && calibIcpId === null && calibIcpFallback) {
        setCalibIcpId(calibIcpFallback.id);
    }
    const calibIcp = calibIcpId ? (icps.find((i) => i.id === calibIcpId) ?? null) : calibIcpFallback;
    // allGeoCells is already fetched above (enabled for step>=9) — reused here for the sample
    // geography prefill, not re-fetched.
    const calibBestGeoCell = pickBestApprovedGeoCell(allGeoCells, calibIcp?.id);
    const calibEnabled = step >= 11 && step <= 14 && !!calibIcp;
    // Tenant-scoped reset key (P1-D fix, codex xhigh review) — see useCalibration's own doc
    // comment: without this, a tenant switch mid-calibration could leave the previous tenant's
    // typed-in geography/ratings/job behind and fire a real spend against the new tenant's ICP.
    const calib = useCalibration(calibIcp, calibEnabled, activeTenantId);

    // Seed the geography input ONCE per ICP from the best approved geo cell, if one exists —
    // otherwise leave it blank for manual entry (same free-text field CalibrationDrawer always
    // shows). Not a step-mover — no Back-latch needed.
    useEffect(() => {
        if (step !== 11 || calibGeographySeeded || !calibIcp) return;
        if (calibBestGeoCell?.country) calib.setGeography(calibBestGeoCell.country);
        setCalibGeographySeeded(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step, calibGeographySeeded, calibIcp, calibBestGeoCell]);

    // Auto-fire the sample once per ICP, mirroring the crawlRequested-style one-shot guard —
    // but ONLY when there's nothing sampled yet (companies.length === 0): resuming with an
    // already-completed sample (this session or from the Drawer) must never silently re-spend
    // credits, mirroring step 2's hasAiDraft-skip philosophy. Not itself a step-mover (starts a
    // mutation, doesn't touch `step`) — no Back-latch needed, same class as the step 7/9
    // auto-START effects above.
    useEffect(() => {
        if (step !== 11 || !calibIcp || calibSampleRequested) return;
        if (!calibGeographySeeded) return; // wait for the seed attempt above to resolve first
        if (calib.companies.length > 0) return; // already sampled — nothing to auto-fire
        if (!calib.geography.trim()) return; // no prefill AND nothing typed yet — wait for a manual click
        if (calib.live?.status !== 'approved') return; // mirrors canSample's own gate
        setCalibSampleRequested(true);
        // A genuinely fresh sample starting is itself forward intent — consume the latch (same
        // reasoning as retryCrawl clearing explicitBackNav) so the 11->12 advance effect is free
        // to fire once THIS sample completes.
        setExplicitBackToStep11(false);
        calib.sampleMut.mutate();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step, calibIcp, calibSampleRequested, calibGeographySeeded, calib.companies.length, calib.geography, calib.live?.status]);

    // Advance 11 -> 12 once sampled companies exist — covers BOTH a fresh sample's completion
    // (invalidation makes companiesQuery refetch non-empty) AND resuming with an
    // already-completed sample, same "data already exists -> advance" shape as step 9's
    // geoAnalyzeAllDone / step 10's zero-cell-skip. Suppressed by `explicitBackToStep11`
    // exactly once: companies.length>0 is trivially ALREADY true the moment the user could BE
    // on step 12 to click Back from it (or step 14's "Tekrar örnekle") — same bug shape as
    // explicitBackToStep9/10, so it needs the identical latch (review self-trace, WP8b). The
    // latch alone only stops THIS effect from re-firing; it does nothing about a PATCH this same
    // effect already fired on an EARLIER run, still in flight when the user clicks Back on step
    // 11 itself (setStep(10) is a synchronous local update — it doesn't cancel the request) — so
    // this also stamps calibStepTokenRef (P1 fix, see its own doc comment) and step 11's onBack
    // below bumps it, closing that race too.
    // P1 fix (WP8b round 6, adversarial review): also suppressed while `calibAwaitingResample` —
    // that latch means a "Run sample" click has already fired for THIS arrival and its fresh
    // list hasn't landed yet, but `calib.companies` still reflects the OLD (about-to-be-replaced)
    // list the instant this effect's OTHER conditions are satisfied — exactly the scenario this
    // effect exists to avoid (same reasoning as the un-suppress effect just below, which is what
    // actually clears this latch once the SPECIFIC new sample lands). Without this, resuming step
    // 11 with an existing companies list already loaded (companies.length > 0 from a PRIOR
    // sample) lets this effect fire and put a nextStep:12 PATCH in flight BEFORE the user even
    // clicks "Run sample" again — closed together with the click handler's own token bump below
    // (see calibStepTokenRef's own doc comment) so an already-in-flight PATCH from that fire
    // can't move `step` forward once it resolves either.
    useEffect(() => {
        if (step !== 11 || !calib.companiesQuery.isSuccess || calib.companies.length === 0 || explicitBackToStep11 || calibAwaitingResample) return;
        saveStepMut.mutate({ patch: {}, nextStep: 12, gate: 'step11', calibCompanyIndexOverride: 0, calibStepToken: calibStepTokenRef.current });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step, calib.companiesQuery.isSuccess, calib.companies.length, explicitBackToStep11, calibAwaitingResample]);

    // P1 fix (WP8b round 5, adversarial review): un-suppresses `explicitBackToStep11` ONLY once
    // the resample the "Run sample" button started has genuinely landed — not merely once the
    // button was clicked. That button used to clear the latch synchronously on click, which let
    // the 11->12 effect above fire on its VERY NEXT render using `calib.companies` — but that
    // list is still the OLD sample's data at that point: the POST hasn't even returned yet, let
    // alone been invalidated/refetched. The effect would immediately persist step 12 against
    // companies about to be replaced, and step 12 itself has no running-job gate to stop the
    // user from rating them meanwhile.
    // `companiesQuery.dataUpdatedAt` is TanStack Query's own "a fetch for this exact query key
    // actually completed" timestamp. Gating on `calib.anyRunning`/`jobStatus` instead would only
    // NARROW this same window, not close it: useCalibration's own job-succeeded effect only
    // calls `invalidateQueries` (which is what triggers the companies refetch) from inside a
    // `useEffect` that fires the render AFTER `jobStatus` first reads 'succeeded' — so there is
    // at least one render where `anyRunning` already reads false (job no longer "running") but
    // the refetch hasn't even been dispatched yet, same class of gap as `activeTenantIdRef`'s own
    // fix above. `dataUpdatedAt` instead only advances at the moment fresh data for THIS exact
    // query key (['research','companies',icpId,'calibration']) actually lands — the one and only
    // place that invalidates that key in this flow is useCalibration's job-succeeded effect,
    // fired exclusively by a 'sample' job reaching 'succeeded', and this app's QueryClient sets
    // `refetchOnWindowFocus: false` (App.tsx) so nothing else can bump it spuriously while this
    // effect waits. Capturing the baseline at CLICK time (not job-start time, see the button's
    // own onClick below) means even a sample that resolves instantly still requires at least one
    // NEW fetch to complete before the latch clears — and because `data`/`dataUpdatedAt` update
    // atomically on the same query object, the render where this effect flips the latch off is
    // the SAME render where `calib.companies` already reflects the fresh list, so the 11->12
    // effect above fires next with the right data, not the stale one.
    // P1 fix (WP8b round 6, adversarial review): `dataUpdatedAt` moving past the baseline is NOT
    // proof that THIS resample finished — TanStack Query's default `refetchOnReconnect` can
    // refetch the exact same companies query key (['research','companies',icpId,'calibration'])
    // from an unrelated network reconnect while the real sample job is still running, bumping
    // `dataUpdatedAt` and false-positive-clearing this latch before the actual job succeeds. Fix:
    // latch onto the SPECIFIC job this click started (or 409-adopted) via `calib.job` — kind is
    // always 'sample' for both paths (useCalibration's sampleMut) — and require ITS id to reach a
    // real terminal 'succeeded' status in `calib.jobQuery.data`, the same job-scoped signal
    // useCalibration's own job-succeeded effect and CalibrationDrawer.tsx's failure banner both
    // already key off. `dataUpdatedAt` still guards the OTHER half of the race: the render where
    // `jobStatus` first reads 'succeeded' is the SAME render where useCalibration's own effect
    // fires `invalidateQueries` — the resulting refetch is async and hasn't landed data yet on
    // that render, so requiring `dataUpdatedAt` to have ALSO advanced past the click-time baseline
    // still closes that separate gap (same reasoning the previous fix already relied on).
    // P1 fix (WP8b round 7, adversarial review): the click-time baseline check just above is NOT
    // causal proof on its own — `refetchOnReconnect` (on by default; only `refetchOnWindowFocus`
    // is disabled in App.tsx) can refetch this exact companies key from an unrelated reconnect
    // WHILE the tracked job is still genuinely running, bumping `dataUpdatedAt` past the click-time
    // baseline well before the job ever succeeds. The moment that job LATER does reach
    // 'succeeded', both this effect's checks would already read true on the very same render —
    // even though the job's OWN success-triggered `invalidateQueries` (useCalibration's
    // job-succeeded effect) hasn't fired yet, let alone landed fresh data. `calibResampleSuccessBaselineRef`
    // closes this: the first render this effect observes the tracked job's status as 'succeeded',
    // it snapshots `dataUpdatedAt` right here (whatever it is at that instant — possibly already
    // past the click-time baseline from the unrelated reconnect) as a SECOND, later baseline, and
    // the latch is only released once `dataUpdatedAt` advances STRICTLY PAST that later snapshot —
    // a bar only the job's own post-success refetch can clear, since (per calibResampleBaselineRef's
    // own doc comment above) that is the one and only other place this exact query key is
    // invalidated in this flow.
    useEffect(() => {
        if (!calibAwaitingResample) return;
        // Capture once per cycle: the first job (fresh POST or 409-adopted) useCalibration
        // reports back after this click. Cleared to null again by the click handler itself for
        // the NEXT cycle, and by the tenant-switch reset above.
        if (!calibResampleJobIdRef.current && calib.job?.kind === 'sample' && calib.job.id) {
            calibResampleJobIdRef.current = calib.job.id;
        }
        const trackedJobId = calibResampleJobIdRef.current;
        if (!trackedJobId) return; // the POST (or 409-adopt) hasn't resolved yet — nothing to watch
        // P1 REGRESSION fix (WP8b round 8): latch "this tracked job reached succeeded" into a ref
        // the FIRST render it's observable, instead of re-deriving it from `calib.jobQuery.data`
        // on every run — see `calibResampleJobSucceededRef`'s own doc comment for the full render-
        // by-render trace of why re-checking `jobQuery.data` here on later renders deadlocks: once
        // useCalibration's own job-succeeded effect clears `job` back to null (which it does the
        // very next render after this succeeds, in the same effects flush as the invalidate that
        // this code is waiting on), `jobQuery`'s queryKey no longer includes this job's id and its
        // `data` goes back to `undefined` — permanently, until the NEXT resample cycle — so an
        // id/status check against `jobQuery.data` can only ever pass on that one first render.
        // SECOND, independent bug fixed in the SAME pass (found while verifying the above): the
        // success-baseline anchor below must be captured in this SAME atomic step — the instant
        // `calibResampleJobSucceededRef.current` first flips true — rather than gated behind the
        // dataUpdatedAt/click-baseline check that used to precede it. Concretely: in the NORMAL
        // (no unrelated reconnect) case, `companiesQuery.dataUpdatedAt` does NOT exceed the
        // click-time baseline until the job's OWN post-success invalidate/refetch actually lands —
        // there is nothing else to bump it before that. So the render where the click-baseline
        // check FIRST passes is ALWAYS the exact same render where that real refetch just landed.
        // The old code anchored `calibResampleSuccessBaselineRef` to `dataUpdatedAt` only AFTER
        // that check passed — meaning the anchor was always set to the very value that just
        // barely satisfied it, and the very next line then compared that SAME value against
        // itself (`dataUpdatedAt <= successBaselineRef`), which is always true, and returned —
        // forever, since nothing else ever bumps this query again for this cycle (verified: no
        // other call site invalidates the `['research','companies']` family in this flow besides
        // this exact job-succeeded effect). That is a PERMANENT deadlock in the ordinary happy
        // path, fully independent of (and masked by) the `jobQuery.data`-goes-null bug above — the
        // old top-of-effect guard returned early on every render once `job` cleared, so this second
        // bug could never even be reached until that first one was fixed. Capturing the anchor here
        // — at the moment success is first observed, before any dataUpdatedAt comparison — fixes
        // it: in the normal case the anchor lands on the PRE-refetch value (same as the click-time
        // baseline), so the later real refetch cleanly exceeds it; in the reconnect-race case (the
        // scenario round 7 originally introduced this anchor for) it lands on whatever inflated
        // value the reconnect already produced, and the LATER real refetch still has to exceed
        // THAT — both cases verified by hand-tracing concrete timestamps.
        if (!calibResampleJobSucceededRef.current) {
            if (calib.jobQuery.data?.id === trackedJobId && calib.jobQuery.data?.status === 'succeeded') {
                calibResampleJobSucceededRef.current = true;
                calibResampleSuccessBaselineRef.current = calib.companiesQuery.dataUpdatedAt;
            } else {
                return; // this job hasn't reached 'succeeded' yet (or already has and jobQuery.data is gone — but then the ref above would already be true, so reaching here means it genuinely hasn't)
            }
        }
        if (calib.companiesQuery.dataUpdatedAt <= (calibResampleBaselineRef.current ?? 0)) return;
        // `calibResampleSuccessBaselineRef` is always non-null past this point — it was set the
        // moment `calibResampleJobSucceededRef.current` first flipped true, above (this render or
        // an earlier one), never reset in between (only at cycle boundaries — see the reset sites
        // this ref's own doc comment lists).
        if (calib.companiesQuery.dataUpdatedAt <= (calibResampleSuccessBaselineRef.current ?? 0)) return;
        calibResampleJobIdRef.current = null;
        calibResampleSuccessBaselineRef.current = null;
        calibResampleJobSucceededRef.current = false;
        setCalibAwaitingResample(false);
        setExplicitBackToStep11(false);
    }, [calibAwaitingResample, calib.job, calib.jobQuery.data, calib.companiesQuery.dataUpdatedAt]);

    // Consume-on-leave, same shape as explicitBackToStep7/9/10's own effects. P1 fix (round 5):
    // also discards any awaited-resample bookkeeping — otherwise a resample abandoned by
    // navigating away from step 11 (e.g. a plain Back click) keeps `calibAwaitingResample`
    // (and its baseline) alive, and when that OLD job eventually lands in the background, the
    // effect above would fire and clear `explicitBackToStep11` on whatever LATER, unrelated
    // visit to step 11 happens to be in progress by then — the exact "stale callback stomps
    // current state" class of bug calibStepTokenRef exists to prevent elsewhere in this file.
    useEffect(() => {
        if (step !== 11) {
            setExplicitBackToStep11(false);
            setCalibAwaitingResample(false);
        }
    }, [step]);

    const retryCalibSample = () => {
        // WP8b P2 fix (codex xhigh review): a 409-adopted job (see useCalibration's sampleMut
        // onError) may still be genuinely RUNNING even when this action is reachable — firing a
        // new attempt here would earn nothing but another redundant 409 while the server is
        // already processing one for this ICP.
        // P2 fix (WP8b round 7, adversarial review): guard on the FULL `canSample` gate (approved
        // + geography present + not running) rather than just `anyRunning` — this function now
        // fires the retry itself (see below) instead of delegating to the auto-fire effect, so it
        // must reproduce that effect's OWN safety gates rather than skip them.
        if (!calib.canSample) return;
        // P2 fix (WP8b round 7, adversarial review, genuinely new defect): treat Retry as
        // equivalent to a fresh "Run sample" click for state-machine purposes — mirrors the
        // manual "Run sample" button's onClick below line-for-line, including firing `sampleMut`
        // directly. The PREVIOUS body of this function only reset `calibSampleRequested`/
        // `sampleMut` and relied on the auto-fire effect above to notice `calibSampleRequested`
        // go false and re-`mutate()` on its own — which has two distinct failure modes for a
        // FAILED RESAMPLE specifically (as opposed to a failed FIRST-EVER sample):
        // (1) that auto-fire effect refuses to run at all once `calib.companies.length > 0`
        // ("already sampled — nothing to auto-fire") — but a failed resample is reached with the
        // OLD companies list still on screen, so clicking Retry did literally nothing;
        // (2) even in the companies.length === 0 case where the auto-fire effect DID start a new
        // job, `calibAwaitingResample`/`calibResampleJobIdRef`/`calibResampleBaselineRef`/
        // `calibResampleSuccessBaselineRef` — all armed by the FAILED attempt's own "Run sample"
        // click, if that's how it started — were never reset by the old retry body: the
        // un-suppress effect above only ever clears them on an actual 'succeeded' status, never
        // on 'failed', so they stayed latched onto the DEAD job's id/baseline forever, and the
        // new job's own real success could never unlock them.
        // Firing `sampleMut` directly here — with the exact same resample-state resets the
        // button's onClick performs — fixes both: it no longer depends on the companies-length
        // gate, and the un-suppress effect gets a clean slate to latch onto THIS new job instead
        // of the dead one. `calibSampleRequested` is set true (not false) since this call site
        // IS the request now, not a hand-off to the auto-fire effect.
        calibStepTokenRef.current += 1;
        setCalibSampleRequested(true);
        setExplicitBackToStep11(false);
        calibResampleBaselineRef.current = calib.companiesQuery.dataUpdatedAt;
        calibResampleJobIdRef.current = null;
        calibResampleSuccessBaselineRef.current = null;
        calibResampleJobSucceededRef.current = false;
        setCalibAwaitingResample(true);
        calib.sampleMut.reset();
        calib.sampleMut.mutate();
    };

    // Advance 12 -> 13 once the batch of ratings is saved. Trace (review self-audit, WP8b),
    // CORRECTED (P1 fix, codex xhigh review — the original trace below was incomplete): this
    // transition is gated by `calibFeedbackRequested`, a one-shot flag ONLY set true by the
    // explicit "İleri" click at the last company, so a plain Back into step 12 from step 13
    // cannot re-trigger it. Disabling both nav buttons while `calib.feedbackMut.isPending` (step
    // 12 render below) closes the window WHILE feedbackMut is in flight — but the moment it
    // SUCCEEDS, Back is re-enabled again, and if the last card is also the FIRST (a single-
    // company sample), Back at that point calls step 12's own `back()` at index 0, which sets
    // `step` to 11 immediately — while THIS effect may have already fired (or is about to) and
    // put a saveStepMut(nextStep:13) PATCH in flight, whose unconditional onSuccess would
    // otherwise snap `step` back to 13 once it resolves (the actual P1 bug). Two-part fix: (a)
    // `back()`'s index-0 branch now also clears `calibFeedbackRequested`, so if this effect
    // hasn't fired yet it never will; (b) this effect stamps calibStepTokenRef, and that same
    // `back()` branch bumps it, so an ALREADY-in-flight PATCH from this effect can't move `step`
    // forward either once it resolves (P1 fix, see calibStepTokenRef's own doc comment).
    useEffect(() => {
        if (!calibFeedbackRequested || !calib.feedbackMut.isSuccess) return;
        setCalibFeedbackRequested(false);
        saveStepMut.mutate({ patch: {}, nextStep: 13, gate: 'step12', calibStepToken: calibStepTokenRef.current });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [calibFeedbackRequested, calib.feedbackMut.isSuccess]);

    // BUG 2 fix (product directive): revision generation is now something the human explicitly
    // REQUESTS (the step 13 render's "Propose revision" button, still calling `proposeAgain` ->
    // `calib.reviseMut.mutate()`), never an automatic consequence of landing on step 13 with
    // feedback saved. The auto-fire effect that used to live here bumped `revision_job_id` the
    // instant feedback was persisted — which then made mark-calibrated 409 ("apply or regenerate
    // the pending revision first", the server's own codex #5 rule in icps.ts) for every customer
    // who just wanted to close the loop as-is, forcing them through apply-revision, which reverts
    // approved->draft and bumps ruleset_version (062 trigger), invalidating the very feedback that
    // got them here and forcing a real, paid resample — a live-confirmed infinite loop (zero ICPs
    // in the whole isolated DB ever reached calibration_state='calibrated'). See step 13's render
    // below for the new direct "Mark calibrated" action this fix pairs with.

    // Advance 13 -> 14 once Apply succeeds. Same one-shot-request shape as the 12 -> 13
    // transition above — `calibApplyRequested` is only ever set true by the explicit "Uygula"
    // click, never by merely landing on step 13. CORRECTED (P1 fix, codex xhigh review): unlike
    // the 12->13 transition, step 13's onBack has NO isPending guard at all (only the primary
    // "Apply" button itself is disabled while applyMut.isPending) — so Back is clickable the
    // ENTIRE time applyMut is pending, and `calibApplyRequested` stays true the whole time (this
    // effect only clears it once it actually fires). Clicking Back on step 13 while apply is
    // pending therefore left this flag armed: once applyMut later succeeds, this effect fires
    // regardless of where the user has navigated since, and its saveStepMut(nextStep:14) PATCH's
    // unconditional onSuccess would move `step` forward out from under them (the actual P1 bug).
    // Two-part fix: step 13's onBack below now clears `calibApplyRequested` so this effect can
    // never fire post-Back, AND stamps/bumps calibStepTokenRef so an ALREADY-in-flight PATCH
    // from this effect (fired a moment before the Back click) can't move `step` forward either
    // (P1 fix, see calibStepTokenRef's own doc comment).
    useEffect(() => {
        if (!calibApplyRequested || !calib.applyMut.isSuccess) return;
        setCalibApplyRequested(false);
        saveStepMut.mutate({ patch: {}, nextStep: 14, gate: 'step13', calibStepToken: calibStepTokenRef.current });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [calibApplyRequested, calib.applyMut.isSuccess]);

    // Advance to step 15 once mark-calibrated succeeds. Same one-shot-request shape again.
    // CORRECTED (P1 fix, codex xhigh review): identical race as the 13->14 transition above —
    // step 14's onBack (and its "Sample again"/restartCalibLoop) have no isPending guard against
    // markMut, so `calibMarkRequested` can still be armed when the user navigates away while mark
    // is pending, and this effect would otherwise fire regardless once markMut succeeds. Step
    // 14's onBack and restartCalibLoop below now both clear `calibMarkRequested` (restartCalibLoop
    // was missing this reset entirely) and stamp/bump calibStepTokenRef so neither a not-yet-fired
    // nor an already-in-flight saveStepMut(nextStep:15) PATCH can move `step` forward after the
    // user leaves step 14 (P1 fix, see calibStepTokenRef's own doc comment). BUG 2 fix: this
    // effect isn't gated on a specific `step` value, so it now ALSO drives the new direct-from-
    // step-13 "Approve the logic" action (see step 13's own `markDirectly` above, and its onBack,
    // which clears the same latch for the identical reason) — one transition, two entry points.
    useEffect(() => {
        if (!calibMarkRequested || !calib.markMut.isSuccess) return;
        setCalibMarkRequested(false);
        saveStepMut.mutate({ patch: {}, nextStep: 15, gate: 'step14', calibStepToken: calibStepTokenRef.current });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [calibMarkRequested, calib.markMut.isSuccess]);

    // P2 fix (review, finding 2): markMut's own onError (useCalibration.ts) has no way to reach
    // back into this component's state, so a FAILED "Approve the logic" click left
    // `calibMarkRequested` stuck true forever (it's only ever cleared on markMut SUCCESS, on
    // step 13/14's onBack, on restartCalibLoop, or a full wizard reset) — stranding the
    // Propose-revision button (disabled includes `calibMarkRequested`) disabled with no direct
    // path back short of leaving the step. Clear it the instant markMut errors, mirroring every
    // other one-shot latch in this file.
    useEffect(() => {
        if (!calibMarkRequested || !calib.markMut.isError) return;
        setCalibMarkRequested(false);
    }, [calibMarkRequested, calib.markMut.isError]);

    // "Tekrar örnekle" (step 14 -> 11): reset every per-loop one-shot flag so a NEW sample/rate/
    // revise round can run, and suppress step 11's own "companies already exist -> advance"
    // effect for this one arrival (same latch as a plain Back click from step 12 — see its own
    // doc comment above) so the user actually gets to run — or skip — a fresh sample instead of
    // being bounced straight back to step 12 on the OLD companies list.
    const restartCalibLoop = () => {
        setCalibSampleRequested(false);
        setCalibFeedbackRequested(false);
        setCalibApplyRequested(false);
        // P1 fix (codex xhigh review): was missing entirely — "Sample again" is clickable from
        // step 14 with no isPending guard against markMut, so a pending mark could otherwise
        // still fire the 14->15 advance effect after this restart (see that effect's own trace
        // comment above).
        setCalibMarkRequested(false);
        // P1 fix — bump the shared transition token so an ALREADY-in-flight saveStepMut PATCH
        // from any of the four calibration auto-advance transitions (fired before this click)
        // can't move `step` forward once it resolves (see calibStepTokenRef's own doc comment).
        calibStepTokenRef.current += 1;
        setCalibrationCompanyIndex(0);
        setExplicitBackToStep11(true);
        setStep(11);
    };

    // ── Step 15: auto-generate offer/angle cards for the calibrated ICP (WP9, mirrors step 7's
    // icp:generate pattern exactly) ─────────────────────────────────────────────────────────
    const offersQuery = useQuery<{ data: OfferRow[] }>({
        queryKey: ['research', 'offers', calibIcp?.id, activeTenantId],
        queryFn: async () => (await api.get(`/research/offers?icp_id=${calibIcp!.id}`)).data,
        enabled: !!calibIcp && step >= 15,
    });
    const offers = offersQuery.data?.data ?? [];

    const offerGenMut = useMutation({
        mutationFn: async () => {
            const startedForTenant = activeTenantIdRef.current;
            if (!calibIcp) throw new Error('no ICP to generate offers for');
            const job = (await api.post('/research/offers/generate', { icp_id: calibIcp.id })).data as { id: string };
            return { job, startedForTenant };
        },
        onSuccess: ({ job, startedForTenant }) => {
            if (startedForTenant !== activeTenantIdRef.current) return; // tenant switched mid-flight — discard
            setOfferGenJobId(job.id);
        },
        onError: (err: unknown) => {
            const status = (err as { response?: { status?: number } }).response?.status;
            if (status === 402) {
                showError(t('research.offers.noCredits', 'You do not have research credits — top up before generating angles.'));
                return;
            }
            showErrorFromApi(err);
        },
    });

    const offerGenJobQuery = useQuery<{ status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'; progress: Record<string, unknown>; error: string | null }>({
        queryKey: ['research', 'job', offerGenJobId, activeTenantId],
        queryFn: async () => (await api.get(`/research/jobs/${offerGenJobId}`)).data,
        enabled: !!offerGenJobId,
        refetchInterval: (query) => (JOB_RUNNING(query.state.data?.status) ? 1500 : false),
    });
    const offerGenJobStatus = offerGenJobQuery.data?.status;

    // Fix (adversarial review P1): same gap as icpGenJobStatus's own fix above — nothing else
    // refetches `offersQuery` once the generation job terminates, so the 15->16 auto-advance
    // effect below could never observe `offers.length > 0` after a fresh generation.
    useEffect(() => {
        if (offerGenJobStatus === 'succeeded') qc.invalidateQueries({ queryKey: ['research', 'offers', calibIcp?.id, activeTenantId] });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [offerGenJobStatus]);

    // Auto-start once, when we land on step 15 with the calibrated ICP resolved and no cards yet.
    useEffect(() => {
        if (step !== 15 || !calibIcp) return;
        if (!offersQuery.isSuccess) return; // wait for the "does this ICP already have offers" check
        if (offers.length > 0) return; // resuming with cards already generated — nothing to do
        if (calibIcp.status !== 'approved') return; // mirrors the route's own gate
        if (offerGenRequested) return;
        setOfferGenRequested(true);
        offerGenMut.mutate();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step, calibIcp, offersQuery.isSuccess, offers.length, offerGenRequested]);

    // Once cards exist (freshly generated, or already there on resume), advance to step 16.
    // Suppressed by `explicitBackToStep15` exactly once — same class of bug as
    // explicitBackToStep7/9/10 (an explicit Back click from step 16's first card must actually
    // land on step 15, not bounce right back the instant this effect re-observes offers.length>0).
    // P2 fix (adversarial review): also stamps `calibStepTokenRef` — an explicit Back click from
    // step 15 to step 14 (see the step-15 render block's onBack) bumps the SAME ref, so an
    // already-in-flight PATCH from THIS effect (fired a moment before the Back click) can't snap
    // `step` forward to 16 once it resolves after the user has already navigated away. Reusing
    // calibStepTokenRef here (not a new ref) is deliberate — it's already the generic "did a
    // later navigation-affecting click invalidate this in-flight transition" token; step 15/16
    // are simply one more guarded range on top of 11-14.
    useEffect(() => {
        if (step !== 15 || !offersQuery.isSuccess || offers.length === 0 || explicitBackToStep15) return;
        saveStepMut.mutate({ patch: {}, nextStep: 16, gate: 'step15', offerCardIndexOverride: 0, calibStepToken: calibStepTokenRef.current });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step, offersQuery.isSuccess, offers.length, explicitBackToStep15]);

    const retryOfferGen = () => {
        setOfferGenJobId(null);
        setOfferGenRequested(false);
        offerGenMut.reset();
    };

    // Same consume-on-leave shape as step 7/9/10's own latches (see explicitBackToStep15's
    // declaration above).
    useEffect(() => {
        if (step !== 15) setExplicitBackToStep15(false);
    }, [step]);

    // ── Step 16 → 17: per-card offer approval doesn't need its own effects — advance()/back()
    // below (in the render block) mirror step 8's IcpCard pattern exactly, no ambient auto-
    // advance involved (an explicit click moves `step`, same as step 8→9).

    // ── Step 17: scale & credit screen (WP9) — E sum from allGeoCells + a live credit balance ──
    const creditsQuery = useQuery<{ balance: number; available: number; reserved: number }>({
        queryKey: ['research', 'credits', activeTenantId],
        queryFn: async () => (await api.get('/research/harvest/credits')).data,
        enabled: step === 17,
        refetchInterval: step === 17 ? 10000 : false,
    });

    // The project row's own scale_target isn't part of ResearchProjectSummary (top-level column,
    // separate from profile/flow_state) — read it directly, once, the first time step 17 renders.
    const projectScaleQuery = useQuery<{ scale_target: number | null }>({
        queryKey: ['research', 'project-scale-target', projectId, activeTenantId],
        queryFn: async () => (await api.get(`/research/projects/${projectId}`)).data,
        enabled: !!projectId && step === 17,
    });
    useEffect(() => {
        if (step !== 17 || scaleTargetSeeded || !projectScaleQuery.isSuccess) return;
        const v = projectScaleQuery.data.scale_target;
        setScaleTargetInput(typeof v === 'number' ? v : '');
        setScaleTargetSeeded(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step, scaleTargetSeeded, projectScaleQuery.isSuccess]);

    // scale_target is its OWN top-level column (not profile/flow_state), so it does NOT go
    // through saveStepMut's patch/flow_state machinery — a separate, small PATCH, then the
    // ordinary saveStepMut call advances the step exactly like every other screen's "Next".
    const scaleTargetMut = useMutation({
        mutationFn: async () => {
            const startedForTenant = activeTenantIdRef.current;
            // P2 fix (adversarial review round 2): captured at CLICK time (synchronously, before
            // the PATCH below even starts) — this is a two-request chain (PATCH scale_target,
            // THEN advance the step), so the usual single-mutate token capture isn't enough on
            // its own; onSuccess re-checks this against the ref's LATEST value before deciding
            // to advance at all, closing the window where an explicit Back click (which bumps
            // the same ref) happens while THIS request is still in flight.
            const startedStepToken = calibStepTokenRef.current;
            if (!projectId) throw new Error('no project');
            // P2 fix (adversarial review): 0 is accepted by the server schema (min(0)) but means
            // "already reached" the instant the conductor checks it — indistinguishable in
            // practice from "no target", so treat it the same way (null = run until saturated).
            const value = scaleTargetInput === '' || scaleTargetInput === 0 ? null : scaleTargetInput;
            await api.patch(`/research/projects/${projectId}`, { scale_target: value });
            return { startedForTenant, startedStepToken };
        },
        onSuccess: ({ startedForTenant, startedStepToken }) => {
            if (startedForTenant !== activeTenantIdRef.current) return; // tenant switched mid-flight — discard
            // P2 fix (adversarial review round 2): the scale_target write itself already landed
            // (harmless either way) — but if the user navigated away (an explicit Back bumped
            // the token) while this PATCH was in flight, don't ALSO force them forward to 18.
            if (startedStepToken !== calibStepTokenRef.current) return;
            // P2 fix (adversarial review): reset the orchestrate latch on EVERY 17->18 advance,
            // not just the first one — otherwise raising the target after a prior run already
            // finished (Back to 17, save a higher number, Next) re-lands on 18 with
            // orchestrateJobId/orchestrateRequested still set, so the auto-fire effect never
            // re-POSTs and the screen just shows the OLD stale "finished" result forever, even
            // though the conductor would happily pick up the new target on a fresh run.
            setOrchestrateJobId(null);
            setOrchestrateRequested(false);
            saveStepMut.mutate({ patch: {}, nextStep: 18, gate: 'step17', calibStepToken: calibStepTokenRef.current });
        },
        onError: (err: unknown) => showErrorFromApi(err),
    });

    // ── Step 18: deep-research orchestrator wait screen (WP9) ────────────────────────────────
    const orchestrateMut = useMutation({
        mutationFn: async () => {
            const startedForTenant = activeTenantIdRef.current;
            if (!calibIcp || !calibBestGeoCell) throw new Error('no cell to orchestrate');
            const job = (await api.post('/research/orchestrate/run', { icp_id: calibIcp.id, geo_id: calibBestGeoCell.id })).data as { id: string };
            return { job, startedForTenant };
        },
        onSuccess: ({ job, startedForTenant }) => {
            if (startedForTenant !== activeTenantIdRef.current) return; // tenant switched mid-flight — discard
            setOrchestrateJobId(job.id);
        },
        onError: (err: unknown) => {
            // P3 fix (adversarial review): the route no longer 409s for "a harvest is already
            // running" (round-1 fix removed that check — the conductor adopts it itself, so
            // nothing is ever left un-adopted for the route to warn about). Its only remaining
            // 409s are "ICP/geography not approved" — genuine errors, not a resumable state, so
            // they fall through to the generic handler (which surfaces the server's own message)
            // rather than the old, now-inaccurate "already running — resuming it" toast.
            const status = (err as { response?: { status?: number } }).response?.status;
            if (status === 402) {
                showError(t('research.wizard.step18.noCredits', 'You do not have research credits — top up before deep research.'));
                return;
            }
            showErrorFromApi(err);
        },
    });

    const orchestrateJobQuery = useQuery<{
        status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
        progress: Record<string, unknown>;
        result: Record<string, unknown> | null;
        error: string | null;
    }>({
        queryKey: ['research', 'job', orchestrateJobId, activeTenantId],
        queryFn: async () => (await api.get(`/research/jobs/${orchestrateJobId}`)).data,
        enabled: !!orchestrateJobId,
        refetchInterval: (query) => (JOB_RUNNING(query.state.data?.status) ? 4000 : false),
    });
    const orchestrateStatus = orchestrateJobQuery.data?.status;

    // P2 fix (adversarial review, round 2): step 18 used to embed the full GeoCellDetail editor
    // (spec form + Save/Approve + channel launcher) for live coverage badges — but that exposes
    // a real footgun: saving a spec edit while THIS cell is actively being orchestrated demotes
    // it to 'draft' server-side, and the conductor's very next child re-checks approval and
    // fails (surfacing as child_failed) out from under a run the customer never touched
    // themselves. Read-only coverage badges only, no editable form, no channel launcher —
    // mirrors GeoCellDetail's own CellCoveragePanel data source (same endpoint) without any of
    // its mutation surface.
    const orchestrateCoverageQuery = useQuery<{
        data: {
            found_count: number; estimate: number | null; channels_found: number; channels_harvested: number;
            saturation_a: boolean; saturation_b: boolean; fully_covered: boolean;
        } | null;
    }>({
        queryKey: ['research', 'coverage', calibBestGeoCell?.id, activeTenantId],
        queryFn: async () => (await api.get(`/research/channels/coverage?geo_id=${calibBestGeoCell!.id}`)).data,
        enabled: step === 18 && !!calibBestGeoCell,
        refetchInterval: step === 18 && JOB_RUNNING(orchestrateStatus) ? 5000 : false,
    });
    const orchestrateCoverage = orchestrateCoverageQuery.data?.data ?? null;

    // Auto-start once, when we land on step 18 with a resolvable cell — the server's own
    // in-flight guard (route orchestrate.ts) adopts an already-running job for this cell
    // instead of double-enqueueing, so a reload that loses this local job id is safe to just
    // re-POST (same contract icp:generate/geo:analyze already rely on).
    useEffect(() => {
        if (step !== 18 || !calibIcp || !calibBestGeoCell) return;
        if (orchestrateJobId || orchestrateRequested) return;
        setOrchestrateRequested(true);
        orchestrateMut.mutate();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step, calibIcp, calibBestGeoCell, orchestrateJobId, orchestrateRequested]);

    const retryOrchestrate = () => {
        setOrchestrateJobId(null);
        setOrchestrateRequested(false);
        orchestrateMut.reset();
    };

    // Same skip guard as the hydration block above, live version: if we ARRIVE at step 2 via
    // forward progress or resume and ai_draft already exists, skip the wait screen — never
    // re-run the crawl automatically. Suppressed by `explicitBackNav` exactly once: an explicit
    // Back click from step 3 must actually land the user ON step 2, not bounce them right back
    // (review P2). Placed AFTER every hook call above (rules-of-hooks: hooks must run
    // unconditionally in the same order every render — only the early RETURN needs to come
    // after them, not the hooks).
    if (step === 2 && hasAiDraft && !explicitBackNav) {
        setStep(3);
        return (
            <Center h="60vh">
                <Loader />
            </Center>
        );
    }

    if (projectQuery.isLoading) {
        return (
            <Center h="60vh">
                <Loader />
            </Center>
        );
    }

    // Checked BEFORE `!hydrated` below: hydration only ever completes on a SUCCESSFUL
    // load (see the render-time hydration block above), so a failed query means
    // `hydrated` will never become true. Gating on `!hydrated` first would strand the
    // user on an infinite spinner instead of ever surfacing this error.
    if (projectQuery.isError) {
        return (
            <Center h="60vh">
                <Stack align="center" gap="sm">
                    <Alert color="red" icon={<IconInfoCircle size={18} />}>
                        {t('research.wizard.loadFailed', 'Could not load project data')}
                    </Alert>
                    <Button variant="light" onClick={() => projectQuery.refetch()}>
                        {t('common.retry', 'Retry')}
                    </Button>
                </Stack>
            </Center>
        );
    }

    if (!hydrated) {
        return (
            <Center h="60vh">
                <Loader />
            </Center>
        );
    }

    // ── Step 1 — kickoff form ────────────────────────────────────────────────
    if (step === 1) {
        return (
            <WizardShell
                step={displayStep(1)}
                totalSteps={KNOWN_STEPS}
                title={t('research.wizard.step1.title', "Let's get to know you")}
                subtitle={t('research.wizard.step1.subtitle', 'One form, four fields — nothing else to fill in yet.')}
                primaryLabel={t('research.wizard.next', 'Next')}
                onPrimary={() => {
                    // Only website/social_links invalidate the crawl — a contact_name-only edit
                    // must NOT clear ai_draft or trigger a wasted re-crawl (review P2). Compared
                    // against `profile`, the last-known SERVER state (same baseline the merge-
                    // safe spread everywhere else in this file already trusts).
                    const newWebsite = website.trim();
                    const inputChanged =
                        newWebsite !== asStringField(profile.website) ||
                        JSON.stringify(socialLinks) !== JSON.stringify(asStringArray(profile.social_links));
                    const patch: Record<string, unknown> = {
                        contact_name: contactName.trim(),
                        website: newWebsite,
                        social_links: socialLinks,
                    };
                    if (inputChanged) {
                        patch.ai_draft = null;
                        // company_country is owned by step 3, but profileCrawl.ts only
                        // auto-fills it when still empty — a leftover OLD guess would otherwise
                        // outrank the fresh crawl's correct guess for the NEW website (review
                        // P2). Clear it alongside ai_draft, in the SAME write.
                        patch.company_country = null;
                        // Also throw away any stale step-2 crawl-job state (a prior failed/
                        // terminal job, or a stale crawlRequested latch) — otherwise landing on
                        // step 2 for the NEW input would show the OLD job's leftover state
                        // instead of auto-starting a fresh crawl (review P2).
                        retryCrawl();
                    }
                    saveStepMut.mutate({
                        patch,
                        nextStep: 2,
                        gate: 'step1',
                        clearDependentSeeds: inputChanged,
                        // Steps 3-5's gates cover company_country/products/differentiators —
                        // ALL of which the fresh re-crawl can newly inform — so demote all
                        // three, not just step 3, or the completed_gates-gated pre-fill logic
                        // would permanently lock products/differentiators out of the fresh
                        // draft too (review P2).
                        removeGates: inputChanged ? ['step3', 'step4', 'step5'] : undefined,
                        // A changed website/social IS a fresh-crawl subject change: mark the
                        // profile's confirmed step 3-5 fields as stale so their gate-absent
                        // pre-fill reseeds from the NEW draft, not the previous subject's values.
                        reseedFromDraft: inputChanged ? true : undefined,
                    });
                }}
                primaryLoading={saveStepMut.isPending}
                primaryDisabled={!companyName.trim() || !website.trim()}
            >
                <Stack gap="sm">
                    <TextInput
                        label={t('research.wizard.step1.contactName', 'Your name')}
                        value={contactName}
                        onChange={(e) => setContactName(e.currentTarget.value)}
                    />
                    <TextInput
                        label={t('research.wizard.step1.companyName', 'Company name')}
                        description={!companyName.trim() ? t('research.wizard.step1.companyNameRequired', 'Company name is required to continue') : undefined}
                        value={companyName}
                        onChange={(e) => setCompanyName(e.currentTarget.value)}
                    />
                    <TextInput
                        label={t('research.wizard.step1.website', 'Website')}
                        placeholder="https://…"
                        description={!website.trim() ? t('research.wizard.step1.websiteRequired', 'Website is required to continue') : undefined}
                        value={website}
                        onChange={(e) => setWebsite(e.currentTarget.value)}
                    />
                    <TagsInput
                        label={t('research.wizard.step1.socialLinks', 'Social media links')}
                        placeholder={t('research.wizard.step1.socialLinksPlaceholder', 'LinkedIn, Instagram, other — paste and press Enter')}
                        value={socialLinks}
                        onChange={setSocialLinks}
                    />
                </Stack>
            </WizardShell>
        );
    }

    // ── Step 2 — "Firmanızı araştırıyoruz" (profile:crawl wait screen) ──────────
    if (step === 2) {
        // The ONE place in the wizard where landing on step 2 with a draft already present
        // shows UI instead of being a pure transit step: an explicit Back click here (see
        // explicitBackNav) suppresses the normal auto-skip-to-3, but the auto-start-crawl
        // effect ALSO bails whenever ai_draft exists (nothing to crawl) — so without this
        // branch the user would be stuck looking at a bare spinner with no way forward
        // (review P2).
        if (explicitBackNav && hasAiDraft) {
            // While researchAgainMut is awaiting its clear-draft PATCH, Back and BOTH CTAs are
            // disabled — clicking "Next" during that window would advance to step 3 with the
            // draft already cleared but no fresh crawl started (the auto-crawl effect only runs
            // while step === 2, and the user may have already navigated away by the time it
            // resolves) (review P2).
            const researchAgainPending = researchAgainMut.isPending;
            return (
                <WizardShell
                    step={displayStep(2)}
                    totalSteps={KNOWN_STEPS}
                    title={t('research.wizard.step2.title', "We're researching your company")}
                    onBack={researchAgainPending ? undefined : () => setStep(1)}
                    primaryLabel={t('research.wizard.next', 'Next')}
                    onPrimary={() => setStep(3)}
                    primaryDisabled={researchAgainPending}
                    secondaryActions={
                        <Button
                            variant="subtle"
                            color="gray"
                            loading={researchAgainPending}
                            disabled={researchAgainPending}
                            onClick={() => researchAgainMut.mutate()}
                        >
                            {t('research.wizard.step2.researchAgain', 'Research again')}
                        </Button>
                    }
                >
                    <Alert color="teal" icon={<IconInfoCircle size={18} />}>
                        {t('research.wizard.step2.alreadyResearched', 'We already researched your company.')}
                    </Alert>
                </WizardShell>
            );
        }

        const crawlFailed = crawlMut.isError || crawlJobStatus === 'failed' || crawlJobStatus === 'canceled';
        // Distinct from crawlFailed: the crawl itself succeeded, but pulling the fresh draft
        // afterward failed — retrying should re-fetch, NOT re-run the whole (already-paid)
        // crawl job (review P2).
        const draftFetchFailed = !crawlFailed && fetchDraftMut.isError;
        const stage = typeof crawlJobQuery.data?.progress?.stage === 'string' ? crawlJobQuery.data.progress.stage : null;
        const stageKey = stage && (CRAWL_STAGES as readonly string[]).includes(stage) ? stage : 'default';

        return (
            <WizardShell step={displayStep(2)} totalSteps={KNOWN_STEPS} title={t('research.wizard.step2.title', "We're researching your company")} onBack={() => setStep(1)}>
                <Stack align="center" gap="md" py="lg">
                    {crawlFailed ? (
                        <>
                            <Alert color="red" icon={<IconInfoCircle size={18} />} w="100%">
                                {t('research.wizard.step2.failed', 'The research job failed.')}
                            </Alert>
                            <Button onClick={retryCrawl}>{t('research.wizard.step2.retry', 'Try again')}</Button>
                        </>
                    ) : draftFetchFailed ? (
                        <>
                            <Alert color="red" icon={<IconInfoCircle size={18} />} w="100%">
                                {t('research.wizard.step2.draftFetchFailed', 'The research finished, but we could not load the result.')}
                            </Alert>
                            <Button onClick={() => fetchDraftMut.mutate()}>{t('research.wizard.step2.retry', 'Try again')}</Button>
                        </>
                    ) : (
                        <AiWaitScreen
                            stages={CRAWL_STAGES.map((k) => ({ key: k, label: t(`research.wizard.step2.stage.${k}`, k) }))}
                            activeKey={crawlWasSkipped ? null : stage}
                            label={
                                crawlWasSkipped
                                    ? t('research.wizard.step2.inputChanged', 'Your details changed — researching again…')
                                    : t(`research.wizard.step2.stage.${stageKey}`, 'Getting ready…')
                            }
                        />
                    )}
                </Stack>
            </WizardShell>
        );
    }

    // ── Step 3 — Firma özeti onayı + firma ülkesi ────────────────────────────
    if (step === 3) {
        if (!step3Seeded) {
            // Once 'step3' is in the PERSISTED completed_gates, its fields were genuinely
            // answered (even if left blank on purpose) and must read straight from `profile` —
            // never re-derive from ai_draft again. For an un-completed step 3 (gate absent) the
            // source depends on WHY the gate is absent:
            //   • reseedFromDraft (a website/social change or "research again" demoted this gate):
            //     the confirmed field belongs to the PREVIOUS subject and is stale, so seed from
            //     the FRESH ai_draft — never the leftover `profile.what_they_do` (that was the
            //     "same summary + ceramic floor tiles on a new site" bug).
            //   • otherwise (a never-configured wizard project, or an advanced-editor / pre-wizard
            //     project that authored these fields WITHOUT gates): keep the prior behavior of
            //     preferring the authored profile value so we don't mask the user's own data.
            // Local `stepNSeeded` can't carry this across a reload (always false on a fresh mount)
            // — completed_gates + reseed_from_draft are the server-persisted signals (review P2).
            const step3Done = completedGates.includes('step3');
            const seedSummary = step3Done
                ? asStringField(profile.what_they_do)
                : reseedFromDraft
                  ? asStringField(aiDraft.company_summary)
                  : profile.what_they_do
                    ? asStringField(profile.what_they_do)
                    : asStringField(aiDraft.company_summary);
            const seedCountry = step3Done
                ? asStringField(profile.company_country)
                : reseedFromDraft
                  ? asStringField(aiDraft.company_country)
                  : profile.company_country
                    ? asStringField(profile.company_country)
                    : asStringField(aiDraft.company_country);
            setWhatTheyDoInput(seedSummary);
            setCompanyCountryInput(seedCountry);
            setStep3Seeded(true);
        }
        return (
            <WizardShell
                step={displayStep(3)}
                totalSteps={KNOWN_STEPS}
                title={t('research.wizard.step3.title', 'Did we get you right?')}
                subtitle={t('research.wizard.step3.subtitle', "Edit the summary if needed, and confirm your company's home country.")}
                onBack={goBackToStep2}
                primaryLabel={t('research.wizard.next', 'Next')}
                primaryLoading={saveStepMut.isPending}
                onPrimary={() =>
                    saveStepMut.mutate({
                        patch: { what_they_do: whatTheyDoInput.trim(), company_country: companyCountryInput.trim() || null },
                        nextStep: 4,
                        gate: 'step3',
                    })
                }
            >
                <Stack gap="sm">
                    <Textarea
                        label={t('research.wizard.step3.summary', 'Company summary')}
                        autosize
                        minRows={3}
                        value={whatTheyDoInput}
                        onChange={(e) => setWhatTheyDoInput(e.currentTarget.value)}
                    />
                    <TextInput
                        label={t('research.wizard.step3.country', "Your company's country")}
                        value={companyCountryInput}
                        onChange={(e) => setCompanyCountryInput(e.currentTarget.value)}
                    />
                </Stack>
            </WizardShell>
        );
    }

    // ── Step 4 — Ürün/hizmet listesi ─────────────────────────────────────────
    if (step === 4) {
        if (!step4Seeded) {
            // Same completed_gates + reseed_from_draft rule as step 3 (see its comment): once
            // 'step4' is persisted, an intentionally-empty product list stays as-is on reload.
            // Gate absent + reseedFromDraft (subject changed) → seed from the fresh draft, never
            // the leftover `profile.products` of the PREVIOUS subject (the "ceramic floor tiles on
            // a new metal-machining site" bug); the stale value is left in `profile` untouched
            // (non-destructive) and the user's next step-4 confirm overwrites it. Gate absent
            // WITHOUT reseedFromDraft (fresh wizard project, or advanced-editor/pre-wizard project
            // that authored products without gates) → keep preferring the authored list.
            const existing = asStringArray(profile.products);
            const seedProducts = completedGates.includes('step4')
                ? existing
                : reseedFromDraft
                  ? asStringArray(aiDraft.products_services)
                  : existing.length > 0
                    ? existing
                    : asStringArray(aiDraft.products_services);
            setProductsInput(seedProducts);
            setStep4Seeded(true);
        }
        return (
            <WizardShell
                step={displayStep(4)}
                totalSteps={KNOWN_STEPS}
                title={t('research.wizard.step4.title', 'Your products and services')}
                subtitle={t('research.wizard.step4.subtitle', 'We listed what we found on your site — add, remove, or fix as needed.')}
                onBack={() => setStep(3)}
                primaryLabel={t('research.wizard.next', 'Next')}
                primaryLoading={saveStepMut.isPending}
                onPrimary={() => {
                    // A products edit makes any prior HS match stale — the server (projects.ts PATCH)
                    // clears the old codes on this save. Also clear the local zero-candidate
                    // suppression flag so a project that previously matched zero HS candidates
                    // re-runs step 22 against its new products instead of staying skipped.
                    if (hsMatchZeroKey) localStorage.removeItem(hsMatchZeroKey);
                    saveStepMut.mutate({ patch: { products: productsInput }, nextStep: 5, gate: 'step4' });
                }}
            >
                <TagsInput
                    label={t('research.wizard.step4.products', 'Products / services')}
                    value={productsInput}
                    onChange={setProductsInput}
                />
            </WizardShell>
        );
    }

    // ── Step 5 — Farklılaştırıcılar (opsiyonel, "Atla" mümkün) ───────────────
    if (step === 5) {
        if (!step5Seeded) {
            // Same completed_gates + reseed_from_draft rule as steps 3-4 (see step 3's comment):
            // gate present → the confirmed answer; gate absent + reseedFromDraft (subject changed)
            // → the fresh draft, never the prior subject's leftover `profile.differentiators`
            // (left untouched, non-destructive; overwritten on the next step-5 confirm); gate
            // absent WITHOUT reseedFromDraft (fresh, or advanced/pre-wizard authored) → keep the
            // authored answer.
            const existing = asRecord(profile.differentiators);
            const source = completedGates.includes('step5')
                ? existing
                : reseedFromDraft
                  ? asRecord(aiDraft.differentiators)
                  : Object.keys(existing).length > 0
                    ? existing
                    : asRecord(aiDraft.differentiators);
            setMoq(asStringField(source.moq));
            setLeadTime(asStringField(source.lead_time));
            setCertifications(asStringArray(source.certifications));
            setCapacity(asStringField(source.capacity));
            setReferences(asStringArray(source.references));
            setLanguages(asStringArray(source.languages));
            setStep5Seeded(true);
        }
        const saveDifferentiators = (nextStep: number) =>
            saveStepMut.mutate({
                patch: {
                    differentiators: {
                        moq: moq.trim() || null,
                        lead_time: leadTime.trim() || null,
                        certifications,
                        capacity: capacity.trim() || null,
                        references,
                        languages,
                    },
                },
                nextStep,
                gate: 'step5',
            });
        return (
            <WizardShell
                step={displayStep(5)}
                totalSteps={KNOWN_STEPS}
                title={t('research.wizard.step5.title', 'What sets you apart?')}
                subtitle={t('research.wizard.step5.subtitle', 'Optional but encouraged — this becomes the raw material for message angles later.')}
                onBack={() => setStep(4)}
                primaryLabel={t('research.wizard.next', 'Next')}
                primaryLoading={saveStepMut.isPending}
                onPrimary={() => saveDifferentiators(6)}
                secondaryActions={
                    <Button variant="subtle" color="gray" loading={saveStepMut.isPending} onClick={() => saveStepMut.mutate({ patch: {}, nextStep: 6, gate: 'step5' })}>
                        {t('research.wizard.skip', 'Skip')}
                    </Button>
                }
            >
                <Stack gap="sm">
                    <TextInput label={t('research.wizard.step5.moq', 'Minimum order quantity (MOQ)')} value={moq} onChange={(e) => setMoq(e.currentTarget.value)} />
                    <TextInput label={t('research.wizard.step5.leadTime', 'Lead / delivery time')} value={leadTime} onChange={(e) => setLeadTime(e.currentTarget.value)} />
                    <TagsInput label={t('research.wizard.step5.certifications', 'Certifications')} value={certifications} onChange={setCertifications} />
                    <TextInput label={t('research.wizard.step5.capacity', 'Production capacity')} value={capacity} onChange={(e) => setCapacity(e.currentTarget.value)} />
                    <TagsInput label={t('research.wizard.step5.references', 'Reference customers')} value={references} onChange={setReferences} />
                    <TagsInput label={t('research.wizard.step5.languages', 'Languages spoken')} value={languages} onChange={setLanguages} />
                </Stack>
            </WizardShell>
        );
    }

    // ── Step 6 — İpuçları (opsiyonel, atlanabilir) ───────────────────────────
    if (step === 6) {
        if (!step6Seeded) {
            setLookalikeCustomers(asStringArray(profile.lookalike_customers));
            setTargetMarketsInput(asStringArray(profile.target_markets));
            setExclusionsInput(asStringArray(profile.exclusions));
            setStep6Seeded(true);
        }
        const saveHints = () =>
            saveStepMut.mutate({
                patch: {
                    lookalike_customers: lookalikeCustomers,
                    target_markets: targetMarketsInput,
                    exclusions: exclusionsInput,
                },
                nextStep: 22,
                gate: 'step6',
            });
        return (
            <WizardShell
                step={displayStep(6)}
                totalSteps={KNOWN_STEPS}
                title={t('research.wizard.step6.title', 'A few more hints')}
                subtitle={t('research.wizard.step6.subtitle', 'All optional — feel free to skip.')}
                onBack={() => setStep(5)}
                primaryLabel={t('research.wizard.finish', 'Finish')}
                primaryLoading={saveStepMut.isPending}
                onPrimary={saveHints}
                secondaryActions={
                    <Button variant="subtle" color="gray" loading={saveStepMut.isPending} onClick={() => saveStepMut.mutate({ patch: {}, nextStep: 22, gate: 'step6' })}>
                        {t('research.wizard.skip', 'Skip')}
                    </Button>
                }
            >
                <Stack gap="sm">
                    <TagsInput
                        label={t('research.wizard.step6.lookalikeCustomers', 'Your best current customers')}
                        value={lookalikeCustomers}
                        onChange={setLookalikeCustomers}
                    />
                    <TagsInput label={t('research.wizard.step6.targetMarkets', 'Target markets')} value={targetMarketsInput} onChange={setTargetMarketsInput} />
                    <TagsInput
                        label={t('research.wizard.step6.exclusions', "Types you'd never want as a customer")}
                        value={exclusionsInput}
                        onChange={setExclusionsInput}
                    />
                </Stack>
            </WizardShell>
        );
    }

    // ── Step 22 (WP11 raw step) — HS candidate review, ana-akış adım 7 ───────────────────────
    // Only ever rendered while candidates still exist to review — the effects above
    // auto-advance straight past this screen the moment hs:match confirms there are none.
    if (step === 22) {
        const hsMatchFailed = hsMatchMut.isError || hsMatchJobStatus === 'failed' || hsMatchJobStatus === 'canceled';
        const hsMatchLoading = !hsQuery.isSuccess || JOB_RUNNING(hsMatchJobStatus) || (hsMatchJobId != null && hsMatchJobStatus === undefined);
        const hsMatchStage = typeof hsMatchJobQuery.data?.progress?.stage === 'string' ? hsMatchJobQuery.data.progress.stage : null;
        const hsMatchStageKey = hsMatchStage && (HS_MATCH_STAGES as readonly string[]).includes(hsMatchStage) ? hsMatchStage : 'default';
        return (
            <WizardShell
                step={displayStep(22)}
                totalSteps={KNOWN_STEPS}
                title={t('research.wizard.step22.title', 'Which product codes apply?')}
                subtitle={hsMatchLoading ? undefined : t('research.wizard.step22.subtitle', 'AI matched your products to official HS/GTIP codes — approve the ones that fit.')}
                onBack={() => {
                    setExplicitBackToStep22(true);
                    setStep(6);
                }}
                primaryLabel={hsMatchLoading ? undefined : t('research.wizard.next', 'Next')}
                primaryLoading={saveStepMut.isPending}
                // Review fix (BUG 3 medium): same reasoning as the auto zero-candidate path
                // above — a manual "Next" here is the user acting on whatever is approved RIGHT
                // NOW, which may include codes added since an earlier market:analyze already
                // succeeded and set the persisted-done flag. Reset that state first so step 23
                // actually re-runs analysis instead of silently PATCHing straight through to 7.
                onPrimary={hsMatchLoading ? undefined : () => {
                    retryMarketAnalyze();
                    saveStepMut.mutate({ patch: {}, nextStep: 23, gate: 'step22' });
                }}
            >
                {hsMatchFailed ? (
                    <Stack align="center" gap="md" py="lg">
                        <Alert color="red" icon={<IconInfoCircle size={18} />} w="100%">
                            {t('research.wizard.step22.failed', 'Product code matching failed.')}
                        </Alert>
                        <Button onClick={retryHsMatch}>{t('research.wizard.step2.retry', 'Try again')}</Button>
                    </Stack>
                ) : hsMatchLoading ? (
                    <AiWaitScreen
                        stages={HS_MATCH_STAGES.map((k) => ({ key: k, label: t(`research.wizard.step22.stage.${k}`, k) }))}
                        activeKey={hsMatchStage}
                        label={t(`research.wizard.step22.stage.${hsMatchStageKey}`, 'Matching your products to trade codes…')}
                    />
                ) : (
                    <HsCodeCandidates candidates={hsCandidates} onChanged={() => hsQuery.refetch()} />
                )}
            </WizardShell>
        );
    }

    // ── Step 23 (WP11 raw step) — market:analyze wait screen, ana-akış adım 8 ────────────────
    // Mirrors step 7's icp:generate wait screen exactly (same fail/retry shape) — no new
    // pattern invented, only auto-skipped (via the effects above) when nothing was approved.
    if (step === 23) {
        const marketAnalyzeFailed = marketAnalyzeMut.isError || marketAnalyzeJobStatus === 'failed' || marketAnalyzeJobStatus === 'canceled';
        // Distinct from marketAnalyzeFailed: the market:analyze job itself succeeded, but the
        // step23->7 completion PATCH failed (network blip, 409 gate conflict, server error) — the
        // effect above now bails on `saveStepMut.isError` instead of looping the same failed
        // mutate forever (finding 1 fix). Retrying here re-fires ONLY that PATCH, never the paid
        // Comtrade run — same "distinct failure, distinct retry" shape as step 2's own
        // `draftFetchFailed` above.
        const stepPatchFailed = !marketAnalyzeFailed && saveStepMut.isError;
        // P3 fix (review): this same `saveStepMut.isError` flag is ALSO set by the zero-approved-
        // codes auto-skip effect above (fires an identical-shaped step23->7 PATCH when
        // `hsApprovedCount === 0`, where no market:analyze job ever runs at all). Without this
        // distinction the alert always claimed "the analysis finished", which is simply false for
        // the auto-skip case — wording only, the retry button below does the correct thing
        // (re-fires the same step23->7 PATCH) regardless of which path failed.
        const zeroApprovedAutoSkip = hsApprovedCount === 0;
        const marketAnalyzeStage = typeof marketAnalyzeJobQuery.data?.progress?.stage === 'string' ? marketAnalyzeJobQuery.data.progress.stage : null;
        const marketAnalyzeStageKey = marketAnalyzeStage && (MARKET_ANALYZE_STAGES as readonly string[]).includes(marketAnalyzeStage) ? marketAnalyzeStage : 'default';
        return (
            <WizardShell
                step={displayStep(23)}
                totalSteps={KNOWN_STEPS}
                title={t('research.wizard.step23.title', 'Analyzing world markets')}
                onBack={() => {
                    setExplicitBackToStep23(true);
                    setStep(22);
                }}
            >
                <Stack align="center" gap="md" py="lg">
                    {marketAnalyzeFailed ? (
                        <>
                            <Alert color="red" icon={<IconInfoCircle size={18} />} w="100%">
                                {t('research.wizard.step23.failed', 'Market analysis failed.')}
                            </Alert>
                            <Button onClick={retryMarketAnalyze}>{t('research.wizard.step2.retry', 'Try again')}</Button>
                        </>
                    ) : stepPatchFailed ? (
                        <>
                            <Alert color="red" icon={<IconInfoCircle size={18} />} w="100%">
                                {zeroApprovedAutoSkip
                                    ? t('research.wizard.step23.patchFailedSkip', 'We could not move to the next step.')
                                    : t('research.wizard.step23.patchFailed', 'The analysis finished, but we could not move to the next step.')}
                            </Alert>
                            <Button onClick={() => saveStepMut.mutate({ patch: {}, nextStep: 7, gate: 'step23' })}>
                                {t('research.wizard.step2.retry', 'Try again')}
                            </Button>
                        </>
                    ) : (
                        <AiWaitScreen
                            stages={MARKET_ANALYZE_STAGES.map((k) => ({ key: k, label: t(`research.wizard.step23.stage.${k}`, k) }))}
                            activeKey={marketAnalyzeStage}
                            label={t(`research.wizard.step23.stage.${marketAnalyzeStageKey}`, 'Checking UN Comtrade for the biggest importers…')}
                        />
                    )}
                </Stack>
            </WizardShell>
        );
    }

    // ── Step 7 — ICP generation wait screen ──────────────────────────────────
    if (step === 7) {
        const icpGenFailed = icpGenMut.isError || icpGenJobStatus === 'failed' || icpGenJobStatus === 'canceled';
        const icpGenStage = typeof icpGenJobQuery.data?.progress?.stage === 'string' ? icpGenJobQuery.data.progress.stage : null;
        const icpGenStageKey = icpGenStage && (ICP_GEN_STAGES as readonly string[]).includes(icpGenStage) ? icpGenStage : 'default';
        return (
            <WizardShell
                step={displayStep(7)}
                totalSteps={KNOWN_STEPS}
                title={t('research.wizard.step7.title', 'Building your ICP profiles')}
                onBack={() => {
                    setExplicitBackToStep23(true);
                    setStep(23);
                }}
            >
                <Stack align="center" gap="md" py="lg">
                    {icpGenFailed ? (
                        <>
                            <Alert color="red" icon={<IconInfoCircle size={18} />} w="100%">
                                {t('research.wizard.step7.failed', 'ICP generation failed.')}
                            </Alert>
                            <Button onClick={retryIcpGen}>{t('research.wizard.step2.retry', 'Try again')}</Button>
                        </>
                    ) : (
                        <AiWaitScreen
                            stages={ICP_GEN_STAGES.map((k) => ({ key: k, label: t(`research.wizard.step7.stage.${k}`, k) }))}
                            activeKey={icpGenStage}
                            label={t(`research.wizard.step7.stage.${icpGenStageKey}`, 'Working on it…')}
                        />
                    )}
                </Stack>
            </WizardShell>
        );
    }

    // ── Step 8 — one sub-ICP card at a time (IcpCard reused verbatim) ────────
    if (step === 8) {
        const icpClampedIndex = icps.length > 0 ? Math.min(Math.max(0, icpCardIndex), icps.length - 1) : 0;
        const currentIcp = icps[icpClampedIndex] ?? null;

        if (icpsQuery.isLoading || !currentIcp) {
            return (
                <Center h="60vh">
                    <Loader />
                </Center>
            );
        }

        const advance = () => {
            const next = icpClampedIndex + 1;
            if (next >= icps.length) {
                saveStepMut.mutate({ patch: {}, nextStep: 9, gate: 'step8', icpCardIndexOverride: 0 });
            } else {
                saveStepMut.mutate({ patch: {}, nextStep: 8, gate: 'step8', icpCardIndexOverride: next });
            }
        };
        // Back is a pure local navigation, same convention as every other step's "Geri" —
        // only forward progress ("İleri") persists to flow_state (review pattern from steps 3-6).
        const back = () => {
            if (icpClampedIndex === 0) {
                // Marks this arrival at step 7 as "explicit Back" (review P2) — see
                // explicitBackToStep7's doc comment above.
                setExplicitBackToStep7(true);
                setStep(7);
            } else {
                setIcpCardIndex(icpClampedIndex - 1);
            }
        };

        return (
            <WizardShell
                step={displayStep(8)}
                totalSteps={KNOWN_STEPS}
                title={t('research.wizard.step8.title', 'Review your sub-ICP profiles')}
                subtitle={t('research.wizard.cardOf', '{{current}} / {{total}}', { current: icpClampedIndex + 1, total: icps.length })}
                // BUG 1 fix: this screen had no pending-guard at all, unlike every other
                // carousel step in this file (steps 10/12 below) — a double-click (or a Back
                // click while a PATCH from an earlier Next click is still in flight) could fire
                // a second, overlapping saveStepMut call whose stale onSuccess (unconditional
                // here — this screen carries no calibStepToken) could snap `icpCardIndex`/`step`
                // back forward out from under a Back click already applied, transiently
                // resurrecting the previous card's screen state alongside the new one. Disabling
                // both nav actions for the exact duration of the in-flight PATCH removes the
                // overlap window entirely — same discipline step 12 already applies.
                onBack={saveStepMut.isPending ? undefined : back}
                primaryLabel={t('research.wizard.next', 'Next')}
                primaryLoading={saveStepMut.isPending}
                primaryDisabled={saveStepMut.isPending}
                onPrimary={advance}
            >
                <Stack gap="md">
                    {/* Keyed by icp.id: IcpCard seeds its own draft state from the `icp` prop only
                        at mount, so switching cards without a remount would keep showing the
                        previous card's data. IcpCountryChips gets its OWN distinct key (prefixed,
                        not the same literal `currentIcp.id`) — two sibling elements sharing one
                        key confuses React's reconciliation and can leave the previous IcpCard
                        mounted alongside the new one instead of replacing it. IcpCountryChips
                        itself doesn't strictly need identity-based remounting (its react-query
                        queryKey already includes icpId, so its data refetches correctly either
                        way), but remounting also resets its local "add country" text input when
                        switching ICPs, which is the right UX. */}
                    <IcpCard key={currentIcp.id} icp={currentIcp} />
                    <IcpCountryChips key={`chips-${currentIcp.id}`} icpId={currentIcp.id} />
                </Stack>
            </WizardShell>
        );
    }

    // ── Step 9 — batch geo:analyze wait screen ───────────────────────────────
    if (step === 9) {
        const total = geoAnalyzeJobIds?.length ?? geoAnalyzeTotal;
        const batchFailed = startBatchAnalyzeMut.isError;
        return (
            <WizardShell step={displayStep(9)} totalSteps={KNOWN_STEPS} title={t('research.wizard.step9.title', 'Adapting to each country')} onBack={() => setStep(8)}>
                <Stack align="center" gap="md" py="lg">
                    {batchFailed ? (
                        <>
                            <Alert color="red" icon={<IconInfoCircle size={18} />} w="100%">
                                {t('research.wizard.step9.failed', 'Country analysis could not start.')}
                            </Alert>
                            <Button onClick={retryBatchAnalyze}>{t('research.wizard.step2.retry', 'Try again')}</Button>
                        </>
                    ) : (
                        <AiWaitScreen
                            label={
                                total > 0
                                    ? t('research.wizard.step9.progress', '{{done}} / {{total}} countries analyzed', { done: geoAnalyzeDoneCount, total })
                                    : t('research.wizard.step9.starting', 'Starting analysis…')
                            }
                        />
                    )}
                </Stack>
            </WizardShell>
        );
    }

    // ── Step 10 — one geo cell card at a time (GeoCellDetail reused, no Drawer chrome) ──
    if (step === 10) {
        const geoClampedIndex = activeGeoCells.length > 0 ? Math.min(Math.max(0, geoCardIndex), activeGeoCells.length - 1) : 0;
        const currentCell = activeGeoCells[geoClampedIndex] ?? null;

        if (allGeoCellsQuery.isLoading) {
            return (
                <Center h="60vh">
                    <Loader />
                </Center>
            );
        }

        if (!currentCell) {
            // Zero cells, reached via an explicit Back-from-11 click (the skip-suppression
            // latch above is what let `step` actually settle on 10 here — the normal
            // zero-cell path never renders this far, the skip effect advances away first).
            // Without a real WizardShell, this would just be the bare loader above forever —
            // the exact class of dead end this whole fix chain exists to prevent (review P2
            // follow-up on top of the original P1).
            return (
                <WizardShell
                    step={displayStep(10)}
                    totalSteps={KNOWN_STEPS}
                    title={t('research.wizard.step10.title', 'Review each country')}
                    // Review fix (BUG 1, remaining branch) — same pending-guard gap and fix as the
                    // populated-carousel branch below.
                    onBack={saveStepMut.isPending ? undefined : () => {
                        // Same latch this screen's OWN existence depends on (review P1 follow-
                        // up): without setting it here too, step 9's auto-advance effect would
                        // immediately bounce this Back click straight back to this same screen.
                        setExplicitBackToStep9(true);
                        setStep(9);
                    }}
                    primaryLabel={t('research.wizard.next', 'Next')}
                    primaryLoading={saveStepMut.isPending}
                    primaryDisabled={saveStepMut.isPending}
                    onPrimary={() => saveStepMut.mutate({ patch: {}, nextStep: 11, gate: 'step10', geoCardIndexOverride: 0 })}
                >
                    <Text size="sm" c="dimmed">
                        {t('research.wizard.step10.noCells', 'No countries to review yet.')}
                    </Text>
                </WizardShell>
            );
        }

        const advance = () => {
            const next = geoClampedIndex + 1;
            if (next >= activeGeoCells.length) {
                saveStepMut.mutate({ patch: {}, nextStep: 11, gate: 'step10', geoCardIndexOverride: 0 });
            } else {
                saveStepMut.mutate({ patch: {}, nextStep: 10, gate: 'step10', geoCardIndexOverride: next });
            }
        };
        const back = () => {
            if (geoClampedIndex === 0) {
                // Marks this arrival at step 9 as "explicit Back" (review P1) — see
                // explicitBackToStep9's doc comment above.
                setExplicitBackToStep9(true);
                setStep(9);
            } else {
                setGeoCardIndex(geoClampedIndex - 1);
            }
        };
        const cellAnalyzing = geoReanalyzeJob?.geoId === currentCell.id && JOB_RUNNING(geoReanalyzeStatus);

        return (
            <WizardShell
                step={displayStep(10)}
                totalSteps={KNOWN_STEPS}
                title={t('research.wizard.step10.title', 'Review each country')}
                subtitle={t('research.wizard.cardOf', '{{current}} / {{total}}', { current: geoClampedIndex + 1, total: activeGeoCells.length })}
                // BUG 1 fix — same pending-guard gap and fix as step 8's carousel above.
                onBack={saveStepMut.isPending ? undefined : back}
                primaryLabel={t('research.wizard.next', 'Next')}
                primaryLoading={saveStepMut.isPending}
                primaryDisabled={saveStepMut.isPending}
                onPrimary={advance}
            >
                <GeoCellDetail
                    key={`${currentCell.id}:${currentCell.updated_at}`}
                    cell={currentCell}
                    analyzing={cellAnalyzing}
                    onReanalyze={(geoId) => geoReanalyzeMut.mutate(geoId)}
                    onChanged={handleGeoCellChanged}
                />
            </WizardShell>
        );
    }

    // ── Steps 11-14 — calibration loop (WP8b) — defensive fallback: zero approved ICPs ──────
    // Shouldn't normally happen (step 8 requires review before advancing), but if it does, land
    // on the step-15 placeholder instead of attempting calibration on nothing. Purely static
    // (no auto-advance effect drives THIS screen itself), but its Back button still lands on
    // step 10 — P2 fix (WP8b round 5, adversarial review): step 10's own zero-geo-cell
    // auto-advance effect fires the instant it sees an empty list, which it trivially already
    // did to reach here in the first place, so without the same latch every OTHER step-10-bound
    // Back click in this file already sets, this Back button was bounced straight back to step
    // 11, making it inert.
    // P1-C fix: gated on BOTH calibIcp and calibIcpFallback being empty — a PINNED ICP that's
    // merely demoted to draft mid-revision still resolves via calibIcp (regardless of status),
    // so this only fires when there's truly nothing to calibrate (no pin resolves AND no
    // approved candidate exists at all), not merely because the pinned ICP's status flipped.
    // Range widened to 16 (WP9): steps 15-16's own auto-fire effects (offer generation + the
    // per-card review) depend on calibIcp exactly the same way steps 11-14 do — without this,
    // a null calibIcp would strand either screen on a bare loader forever (the same class of
    // dead end this guard already exists to prevent for 11-14).
    if (step >= 11 && step <= 16 && !calibIcp && !calibIcpFallback) {
        return (
            <WizardShell
                step={displayStep(step)}
                totalSteps={KNOWN_STEPS}
                title={t('research.wizard.stepCalib.noIcp', 'Nothing to calibrate yet')}
                onBack={() => {
                    // Mirrors step 11's own onBack exactly (see its own comment above) — same
                    // latch, same token bump, same target step.
                    setExplicitBackToStep10(true);
                    calibStepTokenRef.current += 1;
                    setStep(10);
                }}
            >
                <Stack gap="sm">
                    <Text size="sm" c="dimmed">
                        {t('research.wizard.stepCalib.noIcpBody', 'No approved ICP was found to calibrate. You can approve one from the advanced view.')}
                    </Text>
                    <Button variant="light" onClick={() => navigate(projectId ? `/research/full?project=${projectId}` : '/research/full')}>
                        {t('research.wizard.stepCalib.advancedView', 'Switch to advanced view')}
                    </Button>
                </Stack>
            </WizardShell>
        );
    }

    // ── Step 11 — sampling wait screen (CalibrationDrawer's step 1, reused verbatim) ────────
    if (step === 11) {
        // WP8b P2 fix, round 4 (codex): a 409 response is CAUGHT and handled gracefully by
        // useCalibration's sampleMut.onError (adopts the server's job_id and keeps polling it) —
        // but React Query still marks the MUTATION ITSELF `isError: true` regardless of what the
        // onError handler did, and that flag is STICKY: it never clears just because the tracked
        // `job` later moves on (e.g. the adopted job succeeds — useCalibration clears `job` back
        // to null on success). Rounds 1-3 fell back to `calib.sampleMut.isError` whenever no job
        // was currently tracked, which meant a SUCCEEDED adopted job could still render as
        // "failed" the instant its `job` got cleared, since the fallback then kicked in and found
        // the original 409's `isError` still true. Fix: match the ORIGINAL CalibrationDrawer.tsx
        // exactly (still true today, see its own step-1 Paper) — it never consults the initiating
        // mutation's `isError` for this banner at all, only `job?.kind === 'sample' && jobStatus
        // === 'failed'`. No fallback branch means a genuine error with nothing ever adopted (a
        // network failure or non-409/402 rejection) surfaces via the toast `showErrorFromApi`
        // already fires inside useCalibration's onError, not via this inline banner — exactly the
        // same as the Drawer.
        const sampleFailed = calib.job?.kind === 'sample' && calib.jobStatus === 'failed';
        return (
            <WizardShell
                step={displayStep(11)}
                totalSteps={KNOWN_STEPS}
                title={t('research.wizard.step11.title', "We're finding your first target companies")}
                onBack={() => {
                    // P1-B fix (codex xhigh review): if step 10 was reached via its own
                    // zero-geo-cell auto-skip, step 10's effect would immediately re-fire the
                    // instant `step` becomes 10 again (that same empty list is still true) and
                    // bounce this Back click straight back to 11 — same latch shape as
                    // explicitBackToStep9/10 elsewhere in this file.
                    setExplicitBackToStep10(true);
                    // P1 fix — an 11->12 auto-PATCH may already be in flight (companies.length
                    // was already >0 the moment this screen rendered) when this Back is clicked;
                    // bump the token so that PATCH's stale completion can't move `step` forward
                    // to 12 once it resolves (see calibStepTokenRef's own doc comment, and the
                    // 11->12 effect's own trace above).
                    calibStepTokenRef.current += 1;
                    setStep(10);
                }}
                primaryLabel={t('research.wizard.next', 'Next')}
                primaryLoading={saveStepMut.isPending}
                // P1 fix (round 5): also disabled while `calibAwaitingResample` — this manual
                // click reaches the exact same nextStep:12 PATCH as the 11->12 auto-advance
                // effect above and, by design, is NOT gated on `explicitBackToStep11` (see its
                // own comment just below) — so without this it stayed clickable with the OLD,
                // about-to-be-replaced companies list for the entire window between a "Run
                // sample" click and the fresh data landing (see calibAwaitingResample's own doc
                // comment for the full trace).
                primaryDisabled={calib.companies.length === 0 || calibAwaitingResample}
                // P1 fix — this manual click is the SAME 11->12 transition as the auto-advance
                // effect above (reachable when `explicitBackToStep11` suppressed that effect, or
                // simply before it has run yet) — it must stamp the SAME token, or a PATCH it
                // fires could still be overwritten-past by a Back click the identical way (see
                // calibStepTokenRef's own doc comment, and the 11->12 effect's own trace above).
                onPrimary={() => saveStepMut.mutate({ patch: {}, nextStep: 12, gate: 'step11', calibCompanyIndexOverride: 0, calibStepToken: calibStepTokenRef.current })}
            >
                <Stack gap="md">
                    <TextInput
                        label={t('research.calibration.geography', 'Geography')}
                        placeholder={t('research.calibration.geographyPh', 'e.g. Germany, Netherlands, Bavaria…')}
                        leftSection={<IconWorld size={16} />}
                        value={calib.geography}
                        onChange={(e) => calib.setGeography(e.currentTarget.value)}
                        disabled={calib.anyRunning}
                    />
                    {sampleFailed ? (
                        <>
                            <Alert color="red" icon={<IconInfoCircle size={18} />}>
                                {t('research.calibration.sampleFailed', 'Sample failed')}: {calib.jobQuery.data?.error ?? 'unknown'}
                            </Alert>
                            <Button onClick={retryCalibSample}>{t('research.wizard.step2.retry', 'Try again')}</Button>
                        </>
                    ) : calib.anyRunning ? (
                        <AiWaitScreen
                            inline
                            label={`${t('research.calibration.sampling', 'Sample running…')}${calib.jobQuery.data?.progress?.stage ? ` (${String(calib.jobQuery.data.progress.stage)})` : ''}`}
                        />
                    ) : (
                        <Button
                            leftSection={<IconPlayerPlay size={16} />}
                            onClick={() => {
                                setCalibSampleRequested(true);
                                // P1 fix (round 6, adversarial review): the 11->12 auto-advance
                                // effect above fires whenever `calib.companies.length > 0`,
                                // regardless of user intent — reachable whenever step 11 is
                                // resumed with an existing (pre-resample) companies list already
                                // loaded, meaning a nextStep:12 PATCH can ALREADY be in flight the
                                // instant this button is clicked (fired before the click, on an
                                // earlier render). That effect is now also gated on
                                // `calibAwaitingResample` (set below) so it can't fire AGAIN once
                                // this click lands, but it does nothing about a PATCH that was
                                // already dispatched a moment earlier — bump the shared token so
                                // THAT PATCH's stale completion can't move `step` to 12 using the
                                // stale list once it resolves (see calibStepTokenRef's own doc
                                // comment, and the 11->12 effect's own trace above).
                                calibStepTokenRef.current += 1;
                                // P1 fix (round 5): a fresh manual sample (e.g. after "Tekrar
                                // örnekle") IS forward intent, so the 11->12 advance effect
                                // should become free to fire again — but only once THIS sample
                                // actually lands, not the instant this button is clicked. Round
                                // 4 cleared `explicitBackToStep11` right here, which let the
                                // 11->12 effect fire on the very next render using the OLD
                                // companies list (the new POST hasn't even returned yet). Instead,
                                // snapshot the current companiesQuery timestamp and arm
                                // `calibAwaitingResample` — the effect right after the 11->12
                                // advance effect above un-suppresses `explicitBackToStep11` (and
                                // disarms this) only once the SPECIFIC job this click starts has
                                // actually succeeded AND `companiesQuery.dataUpdatedAt` has moved
                                // past this snapshot (see that effect's own doc comment, round 6,
                                // for why a bare timestamp comparison alone isn't enough).
                                calibResampleBaselineRef.current = calib.companiesQuery.dataUpdatedAt;
                                // P1 fix (round 6): start a fresh capture for the specific job
                                // THIS click starts (or 409-adopts) — see the un-suppress effect
                                // above for how it's latched onto and checked.
                                calibResampleJobIdRef.current = null;
                                // P1 fix (round 7): clear the success-anchored second baseline
                                // too — a leftover value here from a PRIOR cycle would let the
                                // un-suppress effect's second check pass immediately against a
                                // stale snapshot instead of anchoring fresh to THIS job's own
                                // success (see calibResampleSuccessBaselineRef's own doc comment).
                                calibResampleSuccessBaselineRef.current = null;
                                // P1 fix (round 8): same reset for the "did THIS job's success
                                // already get observed" latch (see calibResampleJobSucceededRef's
                                // own doc comment) — a leftover `true` from a PRIOR cycle would
                                // let the un-suppress effect skip straight past this NEW job's own
                                // succeeded check.
                                calibResampleJobSucceededRef.current = false;
                                setCalibAwaitingResample(true);
                                calib.sampleMut.mutate();
                            }}
                            disabled={!calib.canSample}
                        >
                            {t('research.calibration.runSample', 'Run sample')}
                        </Button>
                    )}
                    {calib.live?.status !== 'approved' && (
                        <Text size="sm" c="dimmed">{t('research.calibration.notApproved', 'The ICP must be approved before sampling.')}</Text>
                    )}
                </Stack>
            </WizardShell>
        );
    }

    // ── Step 12 — Rate, one company per screen ───────────────────────────────
    if (step === 12) {
        const calibCompanies = calib.companies;
        const calibClampedIndex = calibCompanies.length > 0 ? Math.min(Math.max(0, calibrationCompanyIndex), calibCompanies.length - 1) : 0;
        const currentCompany = calibCompanies[calibClampedIndex] ?? null;

        if (calib.companiesQuery.isLoading) {
            return (
                <Center h="60vh">
                    <Loader />
                </Center>
            );
        }

        const advancePending = saveStepMut.isPending || calib.feedbackMut.isPending;

        if (!currentCompany) {
            // Defensive: nothing deletes sampled companies, so this shouldn't normally happen —
            // reachable when calib.companiesQuery genuinely errors, or a sample legitimately
            // comes back with zero companies (both leave `calib.companies` empty without ever
            // loading forever — companiesQuery.isLoading is already false by this point, see the
            // guard above). P2 fix (codex xhigh review): the ORIGINAL code here silently
            // persisted step 13 with zero saved ratings — but step 13 can't auto-propose a
            // revision (`calib.savedCount === 0` gates that effect) AND its manual "Propose
            // revision" button is disabled at the same savedCount===0 check, so the user landed
            // in a dead end with only Back to escape (the exact class of bug this whole wizard
            // exists to prevent). Give a real way out instead: explain what happened and route
            // back to step 11 to resample. Same discipline as step 12's own back() (calibClamped-
            // Index===0 branch) below: clear `calibFeedbackRequested` (nothing to save from this
            // branch, but consistent in case of a stale latch) and bump calibStepTokenRef in case
            // an earlier 12->13 PATCH is somehow still in flight from a prior visit to this same
            // dead end (P1 fix, see calibStepTokenRef's own doc comment).
            const backToResample = () => {
                setCalibFeedbackRequested(false);
                calibStepTokenRef.current += 1;
                setExplicitBackToStep11(true);
                setStep(11);
            };
            return (
                <WizardShell
                    step={displayStep(12)}
                    totalSteps={KNOWN_STEPS}
                    title={t('research.wizard.step12.title', 'Rate the sampled companies')}
                    onBack={backToResample}
                    primaryLabel={t('research.wizard.step12.resample', 'Resample')}
                    onPrimary={backToResample}
                >
                    <Alert color="yellow" icon={<IconInfoCircle size={18} />}>
                        {t('research.wizard.step12.noCompanies', 'No sampled companies to rate — go back and try sampling again.')}
                    </Alert>
                </WizardShell>
            );
        }

        // P2 fix, round 2 (codex xhigh review): the server's feedback schema requires
        // items.min(1) — clicking through every company without rating any of them would
        // otherwise surface an ugly validation-error toast. The FIRST fix (silently skipping
        // forward to step 13 with zero saved ratings) just moved the dead end there instead —
        // step 13's "Propose revision" is disabled at savedCount===0 and its auto-revise effect
        // won't fire either, stranding the user with only Back. Correct fix mirrors the original
        // Drawer's actual semantics ("Save disabled when nothing to save"): the primary button
        // below is disabled on the LAST card while ratedCount===0, so this branch is only ever
        // reachable once at least one rating exists — no special-casing needed here.
        const isLastCard = calibClampedIndex === calibCompanies.length - 1;
        const nothingRatedOnLastCard = isLastCard && calib.ratedCount === 0;
        // P1 fix, round 4 (generalized — codex found rounds 1-3's index-0-only special case
        // still left two gaps open, see back()'s own comment below): `onBack` is only disabled
        // while `calib.feedbackMut.isPending` (not while THIS intra-loop saveStepMut is pending),
        // so a mid-loop forward move (staying on step 12, just changing the company index) can
        // race a Back click the identical way the 11->12/12->13/13->14/14->15 boundary
        // transitions already do. Rather than special-case this one save too, it now carries the
        // SAME calibStepToken every other calibration-loop transition does — one mechanism, not
        // two code paths that can drift apart again (see calibStepTokenRef's own doc comment and
        // onSuccess's guard above, which now holds back `calibration_company_index` right
        // alongside `step`).
        const advance = () => {
            const next = calibClampedIndex + 1;
            calibStepTokenRef.current += 1;
            const token = calibStepTokenRef.current;
            if (next >= calibCompanies.length) {
                setCalibFeedbackRequested(true);
                calib.feedbackMut.mutate();
            } else {
                saveStepMut.mutate({ patch: {}, nextStep: 12, gate: 'step12', calibCompanyIndexOverride: next, calibStepToken: token });
            }
        };
        // Back is a pure local navigation (same convention as steps 3-6/8/10) — no network call
        // of its own, but it must still invalidate whatever the company loop's OWN mutations
        // (the last card's feedbackMut, or advance()'s own intra-loop saveStepMut above) might
        // already have in flight. P1 fix, round 4 (generalized, codex): rounds 1-3 only cleared
        // `calibFeedbackRequested`/bumped the token inside the `calibClampedIndex === 0` branch,
        // which left two gaps: (1) the LAST rated card is only EVER index 0 for a single-company
        // sample — for any multi-company sample, clicking Back right after the last card's
        // feedbackMut succeeds fell into the plain `else` branch below, which never touched the
        // flag/token, so the 12->13 effect (gated on `calibFeedbackRequested &&
        // feedbackMut.isSuccess`) could still fire and snap `step` to 13 out from under the Back
        // click; (2) advance()'s own intra-loop saveStepMut (moving company index N -> N+1 while
        // staying on step 12) had no token at all, so an in-flight one could overwrite a Back
        // click's local cursor decrement once it resolved. Fix: clear the flag and bump the
        // token FIRST, unconditionally, before either local-navigation branch below — the same
        // one mechanism now covers the step-11 boundary, the last-card-not-at-index-0 case, and
        // every intra-loop index change identically, instead of three separate code paths that
        // can silently drift out of sync again (see calibStepTokenRef's own doc comment).
        const back = () => {
            setCalibFeedbackRequested(false);
            calibStepTokenRef.current += 1;
            if (calibClampedIndex === 0) {
                // `calib.companies.length > 0` is already true at this point (that's WHY the user
                // could be on step 12), so without this latch the 11->12 auto-advance effect
                // immediately re-fires and bounces this Back click straight back to step 12 —
                // same latch shape as explicitBackToStep9/10.
                setExplicitBackToStep11(true);
                setStep(11);
            } else {
                setCalibrationCompanyIndex(calibClampedIndex - 1);
            }
        };
        const website = currentCompany.website || currentCompany.domain;
        const websiteHref = website ? (/^https?:\/\//.test(website) ? website : `https://${website}`) : null;
        const r = calib.ratings[currentCompany.id];

        return (
            <WizardShell
                step={displayStep(12)}
                totalSteps={KNOWN_STEPS}
                title={t('research.wizard.step12.title', 'Rate the sampled companies')}
                subtitle={t('research.wizard.cardOf', '{{current}} / {{total}}', { current: calibClampedIndex + 1, total: calibCompanies.length })}
                onBack={calib.feedbackMut.isPending ? undefined : back}
                primaryLabel={t('research.wizard.next', 'Next')}
                primaryLoading={advancePending}
                primaryDisabled={advancePending || nothingRatedOnLastCard}
                onPrimary={advance}
            >
                <Stack gap="sm">
                    <Group justify="space-between" align="flex-start">
                        <div>
                            <Text fw={600}>{currentCompany.name}</Text>
                            {websiteHref && (
                                <Text size="xs" c="blue" component="a" target="_blank" rel="noreferrer" href={websiteHref}>
                                    {currentCompany.domain || currentCompany.website}
                                </Text>
                            )}
                        </div>
                        <Badge variant="filled" color={VERDICT_COLOR[currentCompany.status] ?? 'gray'}>
                            {t(`research.companies.${currentCompany.status}`, currentCompany.status)}
                        </Badge>
                    </Group>
                    <Text size="sm" c="dimmed">{t('research.calibration.score', 'Score')}: {currentCompany.score ?? '—'}</Text>
                    {(currentCompany.evidence || currentCompany.elimination_reason) && (
                        <Tooltip label={currentCompany.evidence || currentCompany.elimination_reason} multiline maw={420} withArrow>
                            <Text size="sm" c="dimmed" lineClamp={3}>{currentCompany.evidence || currentCompany.elimination_reason}</Text>
                        </Tooltip>
                    )}
                    <Group gap="sm" justify="center" py="sm">
                        <ActionIcon
                            size="xl" variant={r?.rating === 'good' ? 'filled' : 'default'} color="teal"
                            onClick={() => calib.setRating(currentCompany.id, 'good')}
                            aria-label={t('research.calibration.good', 'Good')}
                        >
                            <IconThumbUp size={24} />
                        </ActionIcon>
                        <ActionIcon
                            size="xl" variant={r?.rating === 'bad' ? 'filled' : 'default'} color="red"
                            onClick={() => calib.setRating(currentCompany.id, 'bad')}
                            aria-label={t('research.calibration.bad', 'Bad')}
                        >
                            <IconThumbDown size={24} />
                        </ActionIcon>
                    </Group>
                    {nothingRatedOnLastCard && (
                        <Text size="xs" c="dimmed" ta="center">
                            {t('research.wizard.step12.rateAtLeastOne', 'Rate at least one company to continue.')}
                        </Text>
                    )}
                    <TextInput
                        label={t('research.calibration.note', 'Note')}
                        placeholder={t('research.calibration.notePh', 'Note (optional)')}
                        value={r?.note ?? ''}
                        onChange={(e) => calib.setNote(currentCompany.id, e.currentTarget.value)}
                    />
                </Stack>
            </WizardShell>
        );
    }

    // ── Step 13 — revision diff review (CalibrationDrawer's step 3, reused verbatim) ────────
    if (step === 13) {
        const live = calib.live;
        if (!live) {
            return (
                <Center h="60vh">
                    <Loader />
                </Center>
            );
        }
        const revision = calib.revision;
        // WP8b P2 fix, round 4 (codex) — same sticky-isError bug as step 11's sampleFailed above,
        // fixed the same way: matching the ORIGINAL CalibrationDrawer.tsx exactly (its step-3
        // Paper only ever checks `job?.kind === 'revise' && jobStatus === 'failed'`, no fallback
        // to `reviseMut.isError` at all), so a succeeded 409-adopted revision job can no longer
        // render as "failed" just because `job` was cleared back to null after success while the
        // original 409's `isError` was still sitting there true.
        const reviseFailed = calib.job?.kind === 'revise' && calib.jobStatus === 'failed';
        const proposeAgain = () => {
            calib.reviseMut.mutate();
        };
        // BUG 2 fix — direct exit from the calibration loop (product directive): mark-calibrated
        // is reachable HERE, right after rating, without ever going through apply-revision. The
        // server's own gate (icps.ts POST /:id/mark-calibrated) already allows this — status
        // approved (still true: feedback alone never changes it), >=1 saved rating at the CURRENT
        // ruleset (guaranteed by the 12->13 transition itself, which only fires once feedbackMut
        // succeeds), and no pending unreviewed proposal. That last condition is the only way this
        // button can be legitimately disabled here: if the human explicitly requested a revision
        // (the "Propose revision" button below) and it's back with a draft, the server correctly
        // refuses "calibrated with an unreviewed revision outstanding" — the human either applies
        // it (Apply -> step 14) or regenerates it again; nothing here forces that choice.
        // Review fix (BUG 2 race): also require `!calib.reviseRunning` (covers both
        // `reviseMut.isPending` and the job still running server-side) — without it, clicking
        // "Propose revision" then immediately "Approve the logic" races the two mutations before
        // `revision_job_id` comes back and is reflected in `live`, wasting a paid revision job.
        const canMarkDirectly = live.status === 'approved' && calib.savedCount > 0 && !live.revision_job_id && !calib.reviseRunning;
        const markDirectly = () => {
            setCalibMarkRequested(true);
            calib.markMut.mutate();
        };
        // P1 fix (review, finding 2 continued): the previous guard (`calibMarkRequested ||
        // saveStepMut.isPending`) only covered the mark-calibrated request WHILE its follow-up
        // step13->15 PATCH was in flight. If that PATCH fails, `saveStepMut.isPending` flips back
        // to false, `calibMarkRequested` was already cleared the instant markMut succeeded, and
        // `markMut.isPending` is also false (it succeeded) — every term in the old disabled
        // condition goes false while `step` is still stuck at 13, re-enabling Propose-revision
        // against an ICP the server has ALREADY marked calibrated. `markMut.isSuccess` stays true
        // until a NEW markMut.mutate() call (never called again from this screen once marked), so
        // gating on it closes the window permanently instead of only during the PATCH's flight.
        const markPatchFailed = calib.markMut.isSuccess && saveStepMut.isError;

        return (
            <WizardShell
                step={displayStep(13)}
                totalSteps={KNOWN_STEPS}
                title={t('research.wizard.step13.title', 'Review the proposed changes')}
                onBack={() => {
                    // P1 fix (codex xhigh review): step 13's onBack has NO isPending guard
                    // against applyMut — Back is clickable the entire time Apply is pending, and
                    // `calibApplyRequested` would otherwise stay armed for the 13->14 advance
                    // effect to fire regardless of where the user has navigated once applyMut
                    // eventually succeeds. Clear it here so that effect can never fire post-Back,
                    // and bump calibStepTokenRef so an ALREADY-in-flight saveStepMut(nextStep:14)
                    // PATCH (fired a moment before this click) can't move `step` forward either
                    // once it resolves (see calibStepTokenRef's own doc comment, and the 13->14
                    // effect's own trace above). BUG 2 fix: this screen can now ALSO fire markMut
                    // directly (see `markDirectly` above) — clear that latch here too, for the
                    // exact same reason (the shared 14->15 advance effect below has no step check
                    // and no isPending guard of its own against a Back click mid-flight).
                    setCalibApplyRequested(false);
                    setCalibMarkRequested(false);
                    calibStepTokenRef.current += 1;
                    setStep(12);
                }}
                primaryLabel={revision ? t('research.calibration.apply', 'Apply') : undefined}
                primaryLoading={calib.applyMut.isPending}
                primaryDisabled={!revision || !live.revision_job_id}
                onPrimary={() => {
                    if (!live.revision_job_id) return;
                    setCalibApplyRequested(true);
                    calib.applyMut.mutate({ rulesetVersion: live.ruleset_version, revisionJobId: live.revision_job_id });
                }}
                secondaryActions={
                    <Button
                        variant="light"
                        color="teal"
                        leftSection={<IconChecks size={16} />}
                        loading={calib.markMut.isPending}
                        disabled={!canMarkDirectly}
                        onClick={markDirectly}
                    >
                        {t('research.calibration.markCalibrated', 'Approve the logic')}
                    </Button>
                }
            >
                <Stack gap="sm">
                    {!canMarkDirectly && live.revision_job_id && (
                        <Text size="xs" c="dimmed">
                            {t('research.calibration.pendingRevisionBlocksMark', 'A proposed revision is waiting — apply it or propose a different one before marking calibrated.')}
                        </Text>
                    )}
                    {markPatchFailed && (
                        // P1 fix (review, finding 2 continued): the ICP is ALREADY marked
                        // calibrated server-side at this point — retrying here only re-fires the
                        // step13->15 PATCH (never markMut again), same "distinct failure, distinct
                        // retry" shape as step 23's own `stepPatchFailed` below.
                        <Alert color="orange" icon={<IconInfoCircle size={18} />}>
                            <Stack gap={4}>
                                <Text size="sm">
                                    {t('research.calibration.markPatchFailed', 'The ICP was marked calibrated, but we could not move to the next step.')}
                                </Text>
                                <Button
                                    size="xs"
                                    variant="light"
                                    onClick={() => saveStepMut.mutate({ patch: {}, nextStep: 15, gate: 'step14', calibStepToken: calibStepTokenRef.current })}
                                >
                                    {t('research.wizard.step2.retry', 'Try again')}
                                </Button>
                            </Stack>
                        </Alert>
                    )}
                    {reviseFailed ? (
                        <>
                            <Alert color="red" icon={<IconInfoCircle size={18} />}>
                                {t('research.calibration.reviseFailed', 'Revision failed')}: {calib.jobQuery.data?.error ?? 'unknown'}
                            </Alert>
                            <Button leftSection={<IconRefresh size={16} />} onClick={proposeAgain}>{t('research.wizard.step2.retry', 'Try again')}</Button>
                        </>
                    ) : calib.reviseRunning ? (
                        <AiWaitScreen inline label={t('research.calibration.revising', 'Revision being generated…')} />
                    ) : !revision ? (
                        // Review fix (BUG 2 race), reverse direction: also blocked while
                        // markMut is in flight — same mutual-exclusion reasoning as canMarkDirectly.
                        // Finding 2 fix (review): `calib.markMut.isPending` alone leaves a window
                        // open — the instant markMut succeeds, isPending flips false, but the
                        // separate step13->15 saveStepMut PATCH that actually moves the wizard away
                        // from step 13 is still in flight (no shared guard). In that window this
                        // button would re-enable and could fire a real, paid revision job on an ICP
                        // that is about to be (or already is) marked calibrated. Also gate on
                        // `calibMarkRequested` (true from the "Approve the logic" click until
                        // markMut succeeds) and `saveStepMut.isPending` (true from the instant
                        // markMut succeeds until the 13->15 PATCH lands) — together they cover the
                        // whole mark-calibrated request through its post-success PATCH window, the
                        // same pair `markDirectly`'s own effect above relies on. P1 fix (review,
                        // finding 2 continued): also gate on `calib.markMut.isSuccess` directly —
                        // the three flags above all go false again if the follow-up step13->15
                        // PATCH FAILS (see `markPatchFailed` above), re-enabling this button against
                        // an ICP the server already marked calibrated. `isSuccess` stays true past
                        // that failure (only a fresh `markMut.mutate()` call would clear it, and
                        // this screen never calls it again once marked), so it closes the window
                        // permanently instead of only for the PATCH's flight.
                        <Button
                            leftSection={<IconSparkles size={16} />}
                            onClick={proposeAgain}
                            disabled={calib.savedCount === 0 || calib.markMut.isPending || calib.markMut.isSuccess || calibMarkRequested || saveStepMut.isPending}
                        >
                            {t('research.calibration.propose', 'Propose revision')}
                        </Button>
                    ) : (
                        <Stack gap="sm">
                            {RULESET_KEYS.map((key) => {
                                const { added, removed } = diffArrays(live[key] ?? [], revision[key] ?? []);
                                return (
                                    <div key={key}>
                                        <Text size="sm" fw={600}>{t(`research.calibration.${RULESET_LABEL[key].key}`, RULESET_LABEL[key].fallback)}</Text>
                                        {added.length === 0 && removed.length === 0 ? (
                                            <Text size="xs" c="dimmed">{t('research.calibration.noChange', 'No change')}</Text>
                                        ) : (
                                            <Stack gap={2}>
                                                {removed.map((s) => <Text key={`-${s}`} size="xs" c="red" td="line-through">− {s}</Text>)}
                                                {added.map((s) => <Text key={`+${s}`} size="xs" c="green">+ {s}</Text>)}
                                            </Stack>
                                        )}
                                    </div>
                                );
                            })}
                            <Divider />
                            <Text size="sm" fw={600}>{t('research.calibration.changes', 'What changed')}</Text>
                            <List size="sm" spacing={2}>
                                {revision.changes_summary.map((s, i) => <List.Item key={i}>{s}</List.Item>)}
                            </List>
                            <Text size="sm" fw={600}>{t('research.calibration.rationale', 'Rationale')}</Text>
                            <Text size="sm" c="dimmed">{revision.rationale}</Text>
                        </Stack>
                    )}
                </Stack>
            </WizardShell>
        );
    }

    // ── Step 14 — re-approve (IcpCard reused verbatim) + finish/loop ─────────────────────────
    if (step === 14) {
        const live = calib.live;
        if (!live) {
            return (
                <Center h="60vh">
                    <Loader />
                </Center>
            );
        }
        return (
            <WizardShell
                step={displayStep(14)}
                totalSteps={KNOWN_STEPS}
                title={t('research.wizard.step14.title', 'Re-approve and finish')}
                onBack={() => {
                    // P1 fix (codex xhigh review): identical race as step 13's onBack above, for
                    // markMut/calibMarkRequested/the 14->15 advance effect — clear the latch so
                    // that effect can never fire post-Back, and bump calibStepTokenRef so an
                    // already-in-flight saveStepMut(nextStep:15) PATCH can't move `step` forward
                    // either (see calibStepTokenRef's own doc comment, and the 14->15 effect's
                    // own trace above).
                    setCalibMarkRequested(false);
                    calibStepTokenRef.current += 1;
                    setStep(13);
                }}
            >
                <Stack gap="md">
                    {live.calibrated_at && (
                        <Alert color="teal" icon={<IconChecks size={18} />}>
                            {t('research.calibration.calibratedAt', 'Calibrated: {{date}}', { date: new Date(live.calibrated_at).toLocaleString() })}
                        </Alert>
                    )}
                    {/* Keyed by id+ruleset_version+status (mirrors GeoCellDetail's own key): IcpCard
                        seeds its own draft state from the `icp` prop only at mount, so a JUST-applied
                        revision (same id, new arrays) needs a forced remount to actually show — and
                        (live smoke, WP8b review) so does re-approving on THIS screen: unlike step 8
                        (where the user auto-advances to a different card after approving) or the
                        advanced view (a fresh list row per icp.id), step 14 keeps the SAME card
                        mounted right after its own Approve click and immediately needs the badge (and
                        the primary button below, gated on the freshly-invalidated `live.status` from
                        useCalibration's own query) to reflect draft->approved without a manual reload. */}
                    <IcpCard key={`${live.id}:${live.ruleset_version}:${live.status}`} icp={live} />
                    <Group grow>
                        <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={restartCalibLoop}>
                            {t('research.wizard.step14.restart', 'Sample again')}
                        </Button>
                        <Button
                            color="green"
                            leftSection={<IconChecks size={16} />}
                            disabled={live.status !== 'approved'}
                            loading={calib.markMut.isPending}
                            onClick={() => {
                                setCalibMarkRequested(true);
                                calib.markMut.mutate();
                            }}
                        >
                            {t('research.calibration.markCalibrated', 'Approve the logic')}
                        </Button>
                    </Group>
                </Stack>
            </WizardShell>
        );
    }

    // ── Step 15 — offer/angle generation wait screen (WP9, mirrors step 7) ──────────────────
    if (step === 15) {
        const offerGenFailed = offerGenMut.isError || offerGenJobStatus === 'failed' || offerGenJobStatus === 'canceled';
        const offerGenStage = typeof offerGenJobQuery.data?.progress?.stage === 'string' ? offerGenJobQuery.data.progress.stage : null;
        const offerGenStageKey = offerGenStage && (OFFER_GEN_STAGES as readonly string[]).includes(offerGenStage) ? offerGenStage : 'default';
        return (
            <WizardShell
                step={displayStep(15)}
                totalSteps={KNOWN_STEPS}
                title={t('research.wizard.step15.title', 'Drafting your message angles')}
                onBack={() => {
                    // P2 fix (adversarial review): bump the shared token so an already-in-flight
                    // 15->16 auto-advance PATCH (fired a moment before this click) can't move
                    // `step` forward once it resolves — see that effect's own comment above.
                    calibStepTokenRef.current += 1;
                    setStep(14);
                }}
            >
                <Stack align="center" gap="md" py="lg">
                    {offerGenFailed ? (
                        <>
                            <Alert color="red" icon={<IconInfoCircle size={18} />} w="100%">
                                {t('research.wizard.step15.failed', 'Angle generation failed.')}
                            </Alert>
                            <Button onClick={retryOfferGen}>{t('research.wizard.step2.retry', 'Try again')}</Button>
                        </>
                    ) : (
                        <AiWaitScreen
                            stages={OFFER_GEN_STAGES.map((k) => ({ key: k, label: t(`research.wizard.step15.stage.${k}`, k) }))}
                            activeKey={offerGenStage}
                            label={t(`research.wizard.step15.stage.${offerGenStageKey}`, 'Working on it…')}
                        />
                    )}
                </Stack>
            </WizardShell>
        );
    }

    // ── Step 16 — one offer/angle card at a time (OfferCard reused verbatim) ────────────────
    if (step === 16) {
        const offerClampedIndex = offers.length > 0 ? Math.min(Math.max(0, offerCardIndex), offers.length - 1) : 0;
        const currentOffer = offers[offerClampedIndex] ?? null;
        // See prevStepForOfferAnimRef's doc comment above.
        const isFreshStep16Arrival = prevStepForOfferAnimRef.current !== 16;

        if (offersQuery.isLoading) {
            return (
                <Center h="60vh">
                    <Loader />
                </Center>
            );
        }

        if (!currentOffer) {
            // Zero offers reaching step 16 should be unreachable (offers have no delete
            // endpoint, and step 15 only ever advances once offers.length > 0) — same
            // defensive belt-and-suspenders as step 10's zero-cell fallback, so a resumed
            // session in some unforeseen state bounces back to step 15 instead of being
            // stranded on a bare loader forever.
            return (
                <WizardShell
                    step={displayStep(16)}
                    totalSteps={KNOWN_STEPS}
                    title={t('research.wizard.step16.title', 'Review your message angles')}
                    onBack={() => {
                        setExplicitBackToStep15(true);
                        setStep(15);
                    }}
                >
                    <Text size="sm" c="dimmed">
                        {t('research.wizard.step16.empty', 'No angles to review yet.')}
                    </Text>
                </WizardShell>
            );
        }

        const advance = () => {
            const next = offerClampedIndex + 1;
            if (next >= offers.length) {
                // P2 fix (adversarial review round 2): guard the 16->17 STEP transition the same
                // way 15->16 already is — an in-flight PATCH from this click racing an explicit
                // Back click (below, which bumps the SAME ref) must not snap `step` forward once
                // it resolves. Read-only here (matches every other forward transition's own
                // convention in this file) — the bump belongs at the Back/reset site, not here.
                saveStepMut.mutate({ patch: {}, nextStep: 17, gate: 'step16', offerCardIndexOverride: 0, calibStepToken: calibStepTokenRef.current });
            } else {
                saveStepMut.mutate({ patch: {}, nextStep: 16, gate: 'step16', offerCardIndexOverride: next });
            }
        };
        // Back is a pure local navigation, same convention as every other card-review step.
        const back = () => {
            if (offerClampedIndex === 0) {
                // Marks this arrival at step 15 as "explicit Back" — see explicitBackToStep15's
                // doc comment above. Also bumps the shared token (P2 fix) so an already-in-flight
                // 16->17 PATCH (fired a moment before this click) can't move `step` forward once
                // it resolves.
                calibStepTokenRef.current += 1;
                setExplicitBackToStep15(true);
                setStep(15);
            } else {
                setOfferCardIndex(offerClampedIndex - 1);
            }
        };

        return (
            <WizardShell
                step={displayStep(16)}
                totalSteps={KNOWN_STEPS}
                title={t('research.wizard.step16.title', 'Review your message angles')}
                subtitle={t('research.wizard.cardOf', '{{current}} / {{total}}', { current: offerClampedIndex + 1, total: offers.length })}
                onBack={back}
                primaryLabel={t('research.wizard.next', 'Next')}
                primaryLoading={saveStepMut.isPending}
                onPrimary={advance}
            >
                {/* Keyed by id+updated_at (offers precedent): any landed change (save/approve/
                    reject) remounts the card so its local edit state stays the same row generation. */}
                <OfferCard
                    key={`${currentOffer.id}:${currentOffer.updated_at}`}
                    offer={currentOffer}
                    stats={null}
                    onChanged={() => offersQuery.refetch()}
                    skipEntranceAnimation={isFreshStep16Arrival}
                />
            </WizardShell>
        );
    }

    // ── Step 17 — scale & credit screen ──────────────────────────────────────
    if (step === 17) {
        // P1 fix (adversarial review): scoped to the ONE cell step 18 will actually orchestrate
        // (calibBestGeoCell), not summed across every approved cell of this ICP — showing a
        // multi-country pool total here while only ever researching one country made the
        // customer's target expectation (and the credit-cost preview) provably wrong for any
        // project with more than one approved geography.
        const cellEstimate = calibBestGeoCell?.estimate ?? null;
        const available = creditsQuery.data?.available ?? null;
        return (
            <WizardShell
                step={displayStep(17)}
                totalSteps={KNOWN_STEPS}
                title={t('research.wizard.step17.title', 'How many companies should we find?')}
                subtitle={t(
                    'research.wizard.step17.subtitle',
                    calibBestGeoCell
                        ? 'For {{country}} — credits are only spent for companies that turn out to be a good fit.'
                        : 'Credits are only spent for companies that turn out to be a good fit.',
                    { country: calibBestGeoCell?.country }
                )}
                onBack={() => {
                    // P2 fix (adversarial review round 2): bump the shared token so an
                    // already-in-flight 17->18 completion (scaleTargetMut below) can't move
                    // `step` forward once it resolves after this click.
                    calibStepTokenRef.current += 1;
                    setStep(16);
                }}
                primaryLabel={t('research.wizard.next', 'Next')}
                primaryLoading={scaleTargetMut.isPending}
                onPrimary={() => scaleTargetMut.mutate()}
            >
                <Stack gap="sm">
                    <Group gap="xs" wrap="wrap">
                        <Badge variant="light" color="blue">
                            {t('research.wizard.step17.estimate', 'Estimated pool')}: {cellEstimate ?? '—'}
                        </Badge>
                        <Badge variant="light" color="teal">
                            {t('research.wizard.step17.available', 'Available credits')}: {available ?? '…'}
                        </Badge>
                    </Group>
                    <NumberInput
                        label={t('research.wizard.step17.target', 'Target number of companies')}
                        placeholder={t('research.wizard.step17.unlimited', 'No target — run until fully covered')}
                        value={scaleTargetInput}
                        onChange={(v) => setScaleTargetInput(typeof v === 'number' ? v : '')}
                        min={1}
                    />
                    <Text size="xs" c="dimmed">
                        {t('research.wizard.step17.hint', 'This uses at most {{count}} credits — one per company found to be a good fit.', { count: scaleTargetInput || available || 0 })}
                    </Text>
                </Stack>
            </WizardShell>
        );
    }

    // ── Step 18 — deep-research orchestrator wait screen (Y1 + Y3, one approved cell) ───────
    if (step === 18) {
        if (!calibIcp || !calibBestGeoCell) {
            return (
                <WizardShell
                    step={displayStep(18)}
                    totalSteps={KNOWN_STEPS}
                    title={t('research.wizard.step18.noCellTitle', 'Add a country first')}
                    onBack={() => {
                        calibStepTokenRef.current += 1;
                        setStep(17);
                    }}
                >
                    <Text size="sm" c="dimmed">
                        {t('research.wizard.step18.noCellBody', 'Deep research needs at least one approved country — add one from the advanced view.')}
                    </Text>
                    <Button variant="light" mt="sm" onClick={() => navigate(projectId ? `/research/full?project=${projectId}` : '/research/full')}>
                        {t('research.wizard.stepCalib.advancedView', 'Switch to advanced view')}
                    </Button>
                </WizardShell>
            );
        }

        const orchestrateFailed = orchestrateMut.isError;
        const orchestrateStage = typeof orchestrateJobQuery.data?.progress?.stage === 'string' ? orchestrateJobQuery.data.progress.stage : null;
        const orchestrateStageKey = orchestrateStage && (ORCHESTRATE_STAGES as readonly string[]).includes(orchestrateStage) ? orchestrateStage : 'default';
        const result = orchestrateJobQuery.data?.result as { stopped_by?: string; matches?: number } | null | undefined;
        const isDone = orchestrateStatus === 'succeeded';
        const isFailed = orchestrateStatus === 'failed' || orchestrateStatus === 'canceled';
        // P3 fix (adversarial review): a child job failing for a real reason (not credit
        // exhaustion) is still a "succeeded" conductor job (graceful stop, same philosophy as
        // harvest:run) — but it is NOT the same as scale_target_reached/fully_covered, and
        // shouldn't read as one.
        const stoppedByChildFailure = isDone && result?.stopped_by === 'child_failed';

        return (
            <WizardShell
                step={displayStep(18)}
                totalSteps={KNOWN_STEPS}
                title={t('research.wizard.step18.title', 'Deep research is running')}
                onBack={() => {
                    // P2 fix (adversarial review round 2): bump the shared token so an
                    // already-in-flight 18->19 completion (below) can't move `step` forward once
                    // it resolves after this click.
                    calibStepTokenRef.current += 1;
                    setStep(17);
                }}
                primaryLabel={isDone ? t('research.wizard.next', 'Next') : undefined}
                onPrimary={isDone ? () => saveStepMut.mutate({ patch: {}, nextStep: 19, gate: 'step18', calibStepToken: calibStepTokenRef.current }) : undefined}
            >
                <Stack gap="md">
                    {orchestrateFailed || isFailed ? (
                        <>
                            <Alert color="red" icon={<IconInfoCircle size={18} />}>
                                {t('research.wizard.step18.failed', 'Deep research could not start.')}
                            </Alert>
                            <Button onClick={retryOrchestrate}>{t('research.wizard.step2.retry', 'Try again')}</Button>
                        </>
                    ) : stoppedByChildFailure ? (
                        <>
                            <Alert color="yellow" icon={<IconInfoCircle size={18} />}>
                                {t('research.wizard.step18.stopped.child_failed', 'Deep research stopped after an error — you can try again.')}
                                {' '}
                                {t('research.wizard.step18.summary', '{{matches}} matching companies found.', { matches: result?.matches ?? 0 })}
                            </Alert>
                            <Button onClick={retryOrchestrate}>{t('research.wizard.step2.retry', 'Try again')}</Button>
                        </>
                    ) : isDone ? (
                        <Alert color="teal" icon={<IconChecks size={18} />}>
                            {t(`research.wizard.step18.stopped.${result?.stopped_by ?? 'unknown'}`, 'Deep research finished.')}
                            {' '}
                            {t('research.wizard.step18.summary', '{{matches}} matching companies found.', { matches: result?.matches ?? 0 })}
                        </Alert>
                    ) : (
                        <AiWaitScreen inline label={t(`research.wizard.step18.stage.${orchestrateStageKey}`, 'Working on it…')} />
                    )}
                    {orchestrateCoverage && (
                        <Group gap="xs" wrap="wrap">
                            <Badge variant="light" color="blue">
                                {t('research.channels.found', 'Found')}: {orchestrateCoverage.found_count}{orchestrateCoverage.estimate != null ? ` / E ${orchestrateCoverage.estimate}` : ''}
                            </Badge>
                            <Badge variant="light" color="grape">
                                {t('research.wizard.step18.channels', 'Channels')}: {orchestrateCoverage.channels_harvested}/{orchestrateCoverage.channels_found}
                            </Badge>
                            <Badge variant="light" color={orchestrateCoverage.saturation_a ? 'green' : 'gray'}>
                                {t('research.channels.ruleA', 'Lists')}: {orchestrateCoverage.saturation_a ? t('research.channels.saturated', 'saturated') : t('research.channels.open', 'in progress')}
                            </Badge>
                            <Badge variant="light" color={orchestrateCoverage.saturation_b ? 'green' : 'gray'}>
                                {t('research.channels.ruleB', 'Open web')}: {orchestrateCoverage.saturation_b ? t('research.channels.saturated', 'saturated') : t('research.channels.open', 'in progress')}
                            </Badge>
                            {orchestrateCoverage.fully_covered && (
                                <Badge color="teal">{t('research.channels.fullyCovered', 'Fully covered')}</Badge>
                            )}
                        </Group>
                    )}
                </Stack>
            </WizardShell>
        );
    }

    // ── Step 19 — results (CompaniesPanel reused verbatim, pre-scoped to the calibrated
    // project/ICP via its own seed-once props — WP10) ────────────────────────────────────────
    if (step === 19) {
        return (
            <WizardShell
                step={displayStep(19)}
                totalSteps={KNOWN_STEPS}
                title={t('research.wizard.step19.title', 'Your results')}
                subtitle={t('research.wizard.step19.subtitle', "Review the companies we found — hide any you don't want, they'll never come back.")}
                wide
                onBack={() => {
                    // P2 fix (adversarial review round 2): same token-guard treatment as every
                    // other step in this range — see step 15's onBack for the original trace.
                    calibStepTokenRef.current += 1;
                    setStep(18);
                }}
                primaryLabel={t('research.wizard.next', 'Next')}
                primaryLoading={saveStepMut.isPending}
                onPrimary={() => saveStepMut.mutate({ patch: {}, nextStep: 20, gate: 'step19', calibStepToken: calibStepTokenRef.current })}
            >
                <CompaniesPanel initialProjectId={projectId ?? undefined} initialIcpId={calibIcp?.id} lockScope />
            </WizardShell>
        );
    }

    // ── Step 20 — decision-maker contacts (EnrichmentPanel reused verbatim, pre-scoped) ──────
    if (step === 20) {
        return (
            <WizardShell
                step={displayStep(20)}
                totalSteps={KNOWN_STEPS}
                title={t('research.wizard.step20.title', 'Find decision-makers')}
                subtitle={t('research.wizard.step20.subtitle', 'Pick companies and priority titles — contacts arrive per company.')}
                wide
                onBack={() => {
                    // P2 fix (adversarial review round 2): same token-guard treatment as every
                    // other step in this range.
                    calibStepTokenRef.current += 1;
                    setStep(19);
                }}
                primaryLabel={t('research.wizard.next', 'Next')}
                primaryLoading={saveStepMut.isPending}
                onPrimary={() => saveStepMut.mutate({ patch: {}, nextStep: 21, gate: 'step20', calibStepToken: calibStepTokenRef.current })}
            >
                <EnrichmentPanel initialProjectId={projectId ?? undefined} initialIcpId={calibIcp?.id} lockScope />
            </WizardShell>
        );
    }

    // ── Step 21 — closing screen + the "living loop" re-entry gates ─────────────────────────
    return (
        <WizardShell
            step={displayStep(21)}
            totalSteps={KNOWN_STEPS}
            title={t('research.wizard.step21.title', "You're set up")}
            subtitle={t('research.wizard.step21.subtitle', 'Come back any time — pick up wherever you like.')}
            onBack={() => {
                // P2 fix (adversarial review round 2): consistent with every other step in this
                // range, even though step 21 has no forward transition of its own to race.
                calibStepTokenRef.current += 1;
                setStep(20);
            }}
            secondaryActions={
                <Text
                    size="sm"
                    c="violet"
                    fw={500}
                    style={{ cursor: 'pointer' }}
                    onClick={() => navigate(projectId ? `/research/full?project=${projectId}` : '/research/full')}
                >
                    {t('research.wizard.step21.advancedView', 'Switch to advanced view')}
                </Text>
            }
        >
            <Stack gap="sm">
                <Text size="sm" c="dimmed">
                    {t('research.wizard.step21.body', "Send your matches to the CRM from the results screen when you're ready — outreach then runs from there.")}
                </Text>
                <Group grow>
                    <Button variant="light" onClick={() => setStep(8)}>{t('research.wizard.step21.addCountry', 'Add another country')}</Button>
                    <Button variant="light" onClick={restartCalibLoop}>{t('research.wizard.step21.recalibrate', 'Recalibrate the logic')}</Button>
                </Group>
                <Group grow>
                    <Button variant="light" onClick={() => setStep(17)}>{t('research.wizard.step21.deepen', 'Find more companies')}</Button>
                    <Button variant="light" onClick={() => setStep(20)}>{t('research.wizard.step21.moreContacts', 'Find more contacts')}</Button>
                </Group>
            </Stack>
        </WizardShell>
    );
}
