/**
 * useCalibration — shared calibration-loop logic (WP1 C1-C2), extracted from
 * CalibrationDrawer.tsx (WP8b) so the wizard's steps 11-14 can drive the EXACT same
 * queries/mutations (fenced RPCs, dual-CAS apply, ratingsVersion pinning) without a Drawer,
 * one company per screen instead of a table. CalibrationDrawer.tsx now calls this hook too —
 * this file owns the logic, that file owns ONLY its own Drawer chrome/table JSX. No behavior
 * change versus the pre-extraction Drawer: every mutation/query body below is a verbatim move.
 */
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import api from './api';
import { showError, showErrorFromApi, showSuccess, showWarning } from './notifications';
import type { ResearchIcp } from '../components/research/IcpCard';

/** The strategy model's proposed revision (icpRevisionSchema) — FULL replacement arrays. */
export type IcpRevision = {
    signals: string[]; negative_signals: string[]; neutral_signals: string[];
    elimination_rules: string[]; changes_summary: string[]; rationale: string;
};

export interface CalibrationIcp extends ResearchIcp {
    revision_draft: IcpRevision | null;
    revision_job_id?: string | null;
}

export interface CompanyRow {
    id: string; name: string; domain: string | null; website: string | null;
    status: 'match' | 'partial' | 'eliminated' | 'review';
    score: number | null; evidence: string | null; elimination_reason: string | null;
}

export interface FeedbackRow { company_id: string; rating: 'good' | 'bad'; note: string | null }

export interface CalibrationJob {
    id: string; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
    progress: Record<string, unknown> | null; result: Record<string, unknown> | null; error: string | null;
}

export type RatingDraft = { rating: 'good' | 'bad' | null; note: string };
type TrackedJob = { id: string; kind: 'sample' | 'revise' };

export const JOB_RUNNING = (s?: string) => s === 'queued' || s === 'running';

export const RULESET_KEYS = ['signals', 'negative_signals', 'neutral_signals', 'elimination_rules'] as const;
export const RULESET_LABEL: Record<(typeof RULESET_KEYS)[number], { key: string; fallback: string }> = {
    signals: { key: 'signals', fallback: 'Signals' },
    negative_signals: { key: 'negativeSignals', fallback: 'Negative signals' },
    neutral_signals: { key: 'neutralSignals', fallback: 'Neutral signals' },
    elimination_rules: { key: 'eliminationRules', fallback: 'Elimination rules' },
};

export function diffArrays(current: string[], proposed: string[]) {
    const cur = new Set(current);
    const next = new Set(proposed);
    return { removed: current.filter((s) => !next.has(s)), added: proposed.filter((s) => !cur.has(s)) };
}

export function httpInfo(err: unknown) {
    const resp = (err as { response?: { status?: number; data?: { job_id?: string; reason?: string } } }).response;
    return { status: resp?.status, jobId: resp?.data?.job_id, reason: resp?.data?.reason };
}

/**
 * @param icp The ICP being calibrated, or null before one is selected/resolved.
 * @param enabled Replaces the Drawer's own `opened` — gates every query so nothing fetches
 *   while the caller isn't actually showing calibration UI (Drawer closed, or wizard on a
 *   different step). Hooks below still run unconditionally every render (rules-of-hooks) —
 *   only their query `enabled` flags react to this.
 * @param resetKey Identity the local draft state (geography/source/ratings/job) is scoped to —
 *   in practice the active tenant id. This hook's own `useState` initializers only run once on
 *   MOUNT, and a caller-side "tenant switched" reset (e.g. ResearchFlowPage.tsx's render-time
 *   tenant-switch block) runs BEFORE this hook is even called in that render, so it can't reach
 *   into state declared here. Without this, switching tenants mid-calibration would leave the
 *   PREVIOUS tenant's typed-in geography hanging around, and the auto-sample effect could fire
 *   a real `/calibrate` POST (spends budget) using stale input against the NEW tenant's ICP
 *   (P1-D, WP8b review).
 */
export function useCalibration(icp: ResearchIcp | null, enabled: boolean, resetKey: string | null) {
    const { t } = useTranslation();
    const qc = useQueryClient();
    const icpId = icp?.id;

    const [geography, setGeography] = useState('');
    const [source, setSource] = useState<'web' | 'maps'>('web');
    const [ratings, setRatings] = useState<Record<string, RatingDraft>>({});
    // The ruleset the local ratings were MADE against (codex verify #1): captured when rating
    // starts, sent with the save, and reset whenever the drafts are cleared — so a 409'd batch
    // can never be resubmitted against a newer ruleset it doesn't describe.
    const [ratingsVersion, setRatingsVersion] = useState<number | null>(null);
    const [job, setJob] = useState<TrackedJob | null>(null);

    // Synchronous "tracked value changed -> reset" (same idiom as ResearchFlowPage.tsx's own
    // tenant-switch block — React's "you might not need an effect" pattern, adjusted during
    // render rather than in a useEffect, which would cost an extra cascading render). Scoped to
    // resetKey identity ONLY — independent of restartCalibLoop's explicit "Tekrar örnekle" reset
    // in ResearchFlowPage.tsx, which is a deliberate user action within the SAME tenant/ICP and
    // must keep working exactly as before; this reset fires only when resetKey itself changes.
    const [resetKeyTrackedFor, setResetKeyTrackedFor] = useState(resetKey);
    // WP8b round 6 P1 fix: the reset above only clears state SYNCHRONOUSLY at render time — it
    // does nothing about async requests already in flight under the OLD resetKey (tenant). A
    // mutation's mutationFn/onSuccess/onError closure can still resolve AFTER this reset commits
    // (this hook instance persists across the tenant switch, per this function's own doc comment
    // above) and call setJob/setRatings/setRatingsVersion below, repopulating state that was just
    // cleared with data describing a tenant this hook is no longer scoped to. This ref is a
    // monotonic generation counter — bumped every time the block below resets — that every such
    // async write captures at REQUEST START (via each mutation's own `onMutate` context, or a
    // local variable at the top of `mutationFn`) and re-checks before applying its result; a
    // mismatch means a reset happened mid-flight, so the write is stale and must be discarded
    // (same shape as ResearchFlowPage.tsx's own calibStepTokenRef).
    const resetGenerationRef = useRef(0);
    // P2 fix (WP8b round 8, adversarial review): whether the `icp` PROP can still be trusted as a
    // fallback for `live` below when the scoped `icpQuery` has no data yet. CalibrationDrawer.tsx
    // stays mounted across a tenant switch (same reasoning as this hook's own doc comment above),
    // so `icp` can still describe the tenant this hook was JUST scoped away from for however long
    // it takes the caller to re-render with a new one — meanwhile `icpQuery` has already re-keyed
    // itself to the new `resetKey` (see its own queryKey below) and has no data for that new key
    // yet. Falling back to `icp` unconditionally in that window renders the OLD tenant's ICP
    // name/rules under the NEWLY selected tenant, possibly for a while, or indefinitely if the new
    // fetch errors. Set true on the exact same render-time reset this hook already performs for
    // resetKey (below — same generation bump), cleared the moment `icpQuery` actually has data for
    // the CURRENT key (see `live`'s own computation further down) — so the fallback is only
    // trusted once we haven't crossed a resetKey boundary more recently than the last confirmed-
    // fresh fetch. Mutated directly during render, same idiom as `resetGenerationRef` just above.
    const icpPropStaleRef = useRef(false);
    if (resetKeyTrackedFor !== resetKey) {
        resetGenerationRef.current += 1;
        setResetKeyTrackedFor(resetKey);
        setGeography('');
        setSource('web');
        setRatings({});
        setRatingsVersion(null);
        setJob(null);
        icpPropStaleRef.current = true;
    }

    const invalidateIcp = () => {
        qc.invalidateQueries({ queryKey: ['research', 'icp', icpId] });
        qc.invalidateQueries({ queryKey: ['research', 'icps', icp?.project_id] });
    };
    const invalidateFeedback = () => qc.invalidateQueries({ queryKey: ['research', 'calibration', 'feedback', icpId] });

    // Fresh ICP (calibration_state + revision_draft live here; the list row can be stale).
    // `resetKey` rides along in the cache key (WP8b round 7 P1 fix, same idiom as jobQuery's
    // own comment below): without it, this query — and companiesQuery/feedbackQuery just below
    // — kept serving/refetching the OLD tenant's cached data for as long as `icpId` happened to
    // still read the same value across a tenant switch (this hook instance persists across the
    // switch; only the synchronous resetKeyTrackedFor block above clears LOCAL state, it can't
    // touch react-query's cache). Appending `resetKey` makes a tenant switch look like a brand
    // new query identity to react-query itself, so a late-arriving OLD-tenant response can only
    // ever populate the OLD (now unsubscribed, inert) cache entry — never the one this render is
    // actually reading. `invalidateIcp()`/`invalidateFeedback()` below still work unchanged:
    // TanStack Query's default `invalidateQueries` match is a PREFIX match, not exact-length, so
    // their shorter `['research','icp',icpId]` / `['research','calibration','feedback',icpId]`
    // filters still match this longer key (verified: no `exact: true` anywhere in this codebase).
    const icpQuery = useQuery<CalibrationIcp>({
        queryKey: ['research', 'icp', icpId, resetKey],
        queryFn: async () => (await api.get(`/research/icps/${icpId}`)).data,
        enabled: enabled && !!icpId,
    });

    // Sampled companies (verdict-aware view, same endpoint as CompaniesPanel). `resetKey`
    // appended for the same tenant-isolation reason as icpQuery above; CompaniesPanel.tsx's own
    // query key ('research','companies',icpId,status,page) is already a different shape, so this
    // doesn't collide with it, and every invalidate of this key elsewhere in the app uses the
    // short `['research','companies']` prefix, which still matches (prefix match, see above).
    const companiesQuery = useQuery<{ data: CompanyRow[] }>({
        queryKey: ['research', 'companies', icpId, 'calibration', resetKey],
        queryFn: async () => (await api.get(`/research/harvest/companies?icp_id=${icpId}&limit=50`)).data,
        enabled: enabled && !!icpId,
    });
    const companies = companiesQuery.data?.data ?? [];

    // Existing feedback at the CURRENT ruleset — prefills the rating column. `resetKey` appended
    // for the same tenant-isolation reason as icpQuery above — this also naturally isolates the
    // prefill effect just below, since react-query now hands it fresh, correctly-scoped data for
    // the current tenant instead of a stale cross-tenant response.
    const feedbackQuery = useQuery<{ data: FeedbackRow[]; ruleset_version: number }>({
        queryKey: ['research', 'calibration', 'feedback', icpId, resetKey],
        queryFn: async () => (await api.get(`/research/icps/${icpId}/feedback`)).data,
        enabled: enabled && !!icpId,
    });
    const savedCount = feedbackQuery.data?.data.length ?? 0;

    // Prefill saved ratings without clobbering unsaved local edits.
    useEffect(() => {
        const rows = feedbackQuery.data?.data;
        if (!rows?.length) return;
        setRatingsVersion((v) => v ?? feedbackQuery.data?.ruleset_version ?? null);
        setRatings((prev) => {
            const next = { ...prev };
            for (const r of rows) {
                if (!next[r.company_id]) next[r.company_id] = { rating: r.rating, note: r.note ?? '' };
            }
            return next;
        });
    }, [feedbackQuery.data]);

    // Poll whichever job (sample or revise) is in flight; mirror CompaniesPanel's approach.
    const jobQuery = useQuery<CalibrationJob>({
        // `resetKey` rides along in the cache key (WP8b round 6 P1 fix) — belt-and-suspenders
        // alongside the mutation-side generation guards below: even if `job` were ever
        // repopulated by a stale post-reset write, this ties the poll's cache entry to the
        // tenant it started under, so a reset can never keep observing/continuing a poll that
        // began under a different one.
        queryKey: ['research', 'job', job?.id, resetKey],
        queryFn: async () => (await api.get(`/research/jobs/${job?.id}`)).data,
        enabled: !!job,
        refetchInterval: (query) => (JOB_RUNNING(query.state.data?.status) ? 2500 : false),
    });
    const jobStatus = jobQuery.data?.status;
    useEffect(() => {
        if (jobStatus !== 'succeeded') return;
        if (job?.kind === 'sample') {
            showSuccess(t('research.calibration.sampleDone', 'Sample finished — rate the companies below.'));
            qc.invalidateQueries({ queryKey: ['research', 'companies'] });
            qc.invalidateQueries({ queryKey: ['research', 'credits'] });
        } else if (job?.kind === 'revise') {
            showSuccess(t('research.calibration.reviseDone', 'Revision proposal is ready — review the changes below.'));
        }
        invalidateIcp();
        invalidateFeedback();
        setJob(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [jobStatus]);

    const sampleMut = useMutation({
        // WP8b round 6 P1 fix: captures the generation at the MOMENT `.mutate()` is called —
        // `onMutate` runs synchronously before `mutationFn` — so `onError` below can tell whether
        // a tenant-switch reset happened while this request was in flight, the same way
        // `mutationFn`'s own local capture does for its (different) closure.
        onMutate: () => ({ generation: resetGenerationRef.current }),
        mutationFn: async () => {
            const generationAtStart = resetGenerationRef.current;
            const started = (await api.post(`/research/icps/${icpId}/calibrate`, {
                geography: geography.trim(),
                source,
            })).data as CalibrationJob;
            // A reset happened mid-flight — this response describes the OLD tenant's job; don't
            // let it repopulate `job` for whichever tenant is current now (WP8b round 6 P1 fix).
            if (resetGenerationRef.current === generationAtStart) {
                setJob({ id: started.id, kind: 'sample' });
            }
            return started;
        },
        onError: (err: unknown, _vars, context) => {
            if (context && context.generation !== resetGenerationRef.current) return; // stale — reset mid-flight
            const { status, jobId } = httpInfo(err);
            if (status === 402) {
                showError(t('research.calibration.noCredits', 'No lead quota available for the sample — top up first.'));
                return;
            }
            if (status === 409) {
                // Already in flight → adopt the existing job (CompaniesPanel convention) and say so.
                if (jobId) {
                    setJob({ id: jobId, kind: 'sample' });
                    showWarning(t('research.calibration.alreadyRunning', 'A run is already in progress for this ICP — watching it.'));
                    return;
                }
                showError(t('research.calibration.notApproved', 'The ICP must be approved before sampling.'));
                return;
            }
            showErrorFromApi(err);
        },
    });

    const feedbackMut = useMutation({
        // WP8b round 6 P1 fix — see sampleMut's own comment above for why `onMutate` is the
        // right place to capture this.
        onMutate: () => ({ generation: resetGenerationRef.current }),
        mutationFn: async () => {
            const items = Object.entries(ratings)
                .filter(([, v]) => v.rating !== null)
                .map(([company_id, v]) => ({
                    company_id,
                    rating: v.rating as 'good' | 'bad',
                    ...(v.note.trim() ? { note: v.note.trim().slice(0, 2000) } : {}),
                }));
            // Pinned to the ruleset the ratings were MADE against — not whatever is current at
            // save time. The server 409s if the ICP moved since.
            await api.post(`/research/icps/${icpId}/feedback`, {
                items,
                ruleset_version: ratingsVersion ?? (icpQuery.data ?? icp)?.ruleset_version,
            });
            return items.length;
        },
        onSuccess: (count, _vars, context) => {
            if (context && context.generation !== resetGenerationRef.current) return; // stale — reset mid-flight
            showSuccess(t('research.calibration.feedbackSaved', '{{count}} ratings saved', { count }));
            invalidateFeedback();
            invalidateIcp();
        },
        onError: (err: unknown, _vars, context) => {
            if (context && context.generation !== resetGenerationRef.current) return; // stale — reset mid-flight
            if (httpInfo(err).status === 409) {
                showWarning(t('research.calibration.feedbackStale', 'The ICP changed since you rated these companies — reloaded, review and rate again.'));
                // The drafts describe firms sampled under OLD rules — drop them so a second
                // Save can't resubmit them against the new ruleset (codex verify #1).
                setRatings({});
                setRatingsVersion(null);
                invalidateIcp();
                invalidateFeedback();
                return;
            }
            showErrorFromApi(err);
        },
    });

    const reviseMut = useMutation({
        // WP8b round 6 P1 fix — see sampleMut's own comment above.
        onMutate: () => ({ generation: resetGenerationRef.current }),
        mutationFn: async () => {
            const generationAtStart = resetGenerationRef.current;
            const started = (await api.post(`/research/icps/${icpId}/revise`)).data as CalibrationJob;
            if (resetGenerationRef.current === generationAtStart) {
                setJob({ id: started.id, kind: 'revise' });
            }
            return started;
        },
        onError: (err: unknown, _vars, context) => {
            if (context && context.generation !== resetGenerationRef.current) return; // stale — reset mid-flight
            const { status, jobId } = httpInfo(err);
            if (status === 409) {
                if (jobId) setJob({ id: jobId, kind: 'revise' });
                showWarning(t('research.calibration.reviseConflict', 'A revision is already being generated for this ICP.'));
                return;
            }
            if (status === 400) {
                showError(t('research.calibration.needFeedback', 'Save at least one rating before requesting a revision.'));
                return;
            }
            showErrorFromApi(err);
        },
    });

    // Double CAS on what the customer is LOOKING at: the ruleset (a concurrent edit bumps it)
    // AND the proposal identity (a concurrent re-revise swaps the draft without a bump) — either
    // moving means 409, never a blind apply of an unreviewed diff.
    const applyMut = useMutation({
        // WP8b round 6 P1 fix — see sampleMut's own comment above.
        onMutate: () => ({ generation: resetGenerationRef.current }),
        mutationFn: async (args: { rulesetVersion: number; revisionJobId: string }) =>
            (await api.post(`/research/icps/${icpId}/apply-revision`, {
                ruleset_version: args.rulesetVersion,
                revision_job_id: args.revisionJobId,
            })).data,
        onSuccess: (_data, _vars, context) => {
            if (context && context.generation !== resetGenerationRef.current) return; // stale — reset mid-flight
            showSuccess(t('research.calibration.applied', 'Revision applied — the ICP is back in draft, review and approve it again.'));
            setRatings({});
            setRatingsVersion(null);
            invalidateIcp();
            invalidateFeedback();
            // P1 fix (WP8b round 8): Apply bumps the ICP's ruleset_version server-side (the 062
            // trigger) — invalidateIcp() above correctly refetches the ICP so the customer sees
            // the NEW version, but `companiesQuery` (this hook's own sampled-company list) is
            // ALSO ruleset-aware: rating an already-sampled row attributes that feedback to
            // whatever ruleset_version is captured live at rating time (see `captureRatingsVersion`
            // below), not the ruleset the row was actually evaluated against. Without this, the ICP
            // refetch lands the bumped version while the companies list keeps serving its
            // pre-invalidate cache (OLD-ruleset rows), so rating one of those stale rows silently
            // saves feedback mislabeled as belonging to the NEW ruleset — a real data-integrity bug,
            // reachable both directly in the Drawer and via Back during/after Apply in the wizard.
            // Broad `['research', 'companies']` prefix invalidate (not the narrower
            // `['research','companies',icpId,'calibration',resetKey]` slice) matches the same
            // family useCalibration's own job-succeeded effect already invalidates this exact way
            // above, and also covers CompaniesPanel.tsx's differently-shaped key under the same
            // prefix (verified: no `exact: true` anywhere in this codebase, see this file's own
            // queryKey comments).
            qc.invalidateQueries({ queryKey: ['research', 'companies'] });
        },
        onError: (err: unknown, _vars, context) => {
            if (context && context.generation !== resetGenerationRef.current) return; // stale — reset mid-flight
            if (httpInfo(err).status === 409) {
                showWarning(t('research.calibration.applyStale', 'The ICP changed in the meantime — reloaded the latest version, review again.'));
                invalidateIcp();
                return;
            }
            showErrorFromApi(err);
        },
    });

    const markMut = useMutation({
        mutationFn: async () => (await api.post(`/research/icps/${icpId}/mark-calibrated`)).data,
        onSuccess: () => {
            showSuccess(t('research.calibration.marked', 'ICP marked as calibrated.'));
            invalidateIcp();
        },
        onError: (err: unknown) => {
            const info = httpInfo(err);
            if (info.status === 409) {
                // Finding 3 fix (review): the server returns 409 for two different reasons — not
                // approved, and a pending revision already outstanding (icps.ts POST
                // mark-calibrated). Since the client already gates the direct-mark path on
                // status==='approved' before ever firing this mutation, `pending_revision` is the
                // far more likely 409 in practice — branch on the `reason` the server now sends
                // instead of always showing the not-approved message.
                if (info.reason === 'pending_revision') {
                    showError(t('research.calibration.pendingRevisionBlocksMark', 'A proposed revision is waiting — apply it before marking calibrated.'));
                    return;
                }
                // P3 fix (review): the third 409 site (icps.ts's check-then-act conditional
                // UPDATE matching 0 rows) sends `reason: 'conflict'` specifically because the
                // server deliberately does NOT re-query which precondition moved (approval status,
                // ruleset version, or a concurrent revision) between the read and the write — so
                // it's wrong to collapse this into the generic "must be approved" message, which
                // actively misleads a user whose ICP IS approved and just lost a narrow race.
                // Reload the latest state so the UI reflects whatever actually moved.
                if (info.reason === 'conflict') {
                    showError(t('research.calibration.markConflict', 'The ICP changed in the meantime — reload and try again.'));
                    invalidateIcp();
                    return;
                }
                showError(t('research.calibration.needApprovedFinish', 'The ICP must be approved before you can mark it calibrated.'));
                return;
            }
            if (info.status === 400) {
                showError(t('research.calibration.needFeedbackFinish', 'Rate at least one sampled company at the current ruleset before finishing.'));
                return;
            }
            showErrorFromApi(err);
        },
    });

    // `icpQuery.data` just arrived for the CURRENT resetKey (its queryKey embeds `resetKey`, see
    // its own declaration above) — the `icp` prop fallback below is trustworthy again from here
    // on, until the NEXT resetKey change re-arms `icpPropStaleRef` above. Mutated during render,
    // same idiom as `resetGenerationRef`/`icpPropStaleRef` above.
    if (icpQuery.data) icpPropStaleRef.current = false;
    // `live`/`state`/`revision` are null when `icp` itself is null — callers must guard the
    // same way the pre-extraction Drawer did with its own `if (!icp) return null` (rules-of-
    // hooks: every hook above still runs unconditionally regardless of `icp`). P2 fix (WP8b
    // round 8): also null (rather than falling back to a possibly cross-tenant-stale `icp` prop)
    // whenever `icpPropStaleRef` is still armed — see its own doc comment above. Callers already
    // treat a null `live` as a loading state (CalibrationDrawer.tsx's own `if (!icp || !live)
    // return null`; ResearchFlowPage.tsx's steps 13/14 own `if (!live) return <Loader />`), so
    // this doesn't need new UI — it reuses the existing "not ready yet" path.
    const live: CalibrationIcp | null = icp
        ? (icpQuery.data ?? (icpPropStaleRef.current ? null : { ...icp, revision_draft: null }))
        : null;
    const calibrationState = live?.calibration_state ?? 'none';
    const revision = live?.revision_draft ?? null;
    const sampleRunning = sampleMut.isPending || (job?.kind === 'sample' && JOB_RUNNING(jobStatus));
    const reviseRunning = reviseMut.isPending || (job?.kind === 'revise' && JOB_RUNNING(jobStatus));
    const anyRunning = sampleRunning || reviseRunning;
    const canSample = live?.status === 'approved' && geography.trim().length > 0 && !anyRunning;
    const ratedCount = Object.values(ratings).filter((r) => r.rating !== null).length;

    const captureRatingsVersion = () =>
        setRatingsVersion((v) => v ?? (icpQuery.data ?? icp)?.ruleset_version ?? null);
    const setRating = (id: string, rating: 'good' | 'bad') => {
        captureRatingsVersion();
        setRatings((prev) => {
            const cur = prev[id] ?? { rating: null, note: '' };
            return { ...prev, [id]: { ...cur, rating: cur.rating === rating ? null : rating } };
        });
    };
    const setNote = (id: string, note: string) => {
        captureRatingsVersion();
        setRatings((prev) => ({ ...prev, [id]: { ...(prev[id] ?? { rating: null, note: '' }), note } }));
    };

    return {
        geography, setGeography, source, setSource, ratings, ratingsVersion, job,
        icpQuery, companiesQuery, companies, feedbackQuery, savedCount, jobQuery, jobStatus,
        sampleMut, feedbackMut, reviseMut, applyMut, markMut,
        live, calibrationState, revision, sampleRunning, reviseRunning, anyRunning, canSample, ratedCount,
        setRating, setNote, captureRatingsVersion,
    };
}
