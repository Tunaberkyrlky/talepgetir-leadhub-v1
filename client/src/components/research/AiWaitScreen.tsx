/**
 * AiWaitScreen — the ONE shared "AI is working" state (Tg-Research-v2/06_WIZARD_TASARIM.md,
 * Karar 4's deferred-to-Stage-2 item + Karar 7's "signature moment"). Every step in
 * ResearchFlowPage.tsx that polls a background job (crawl, icp:generate, geo:analyze,
 * calibration sample/revise, hs:match, market:analyze, offer:generate, orchestrate) used to
 * render its own ad hoc "Loader + dimmed text" combination — inconsistent (a prior UX audit
 * found the calibration resample row nicely echoes the raw server stage string while the
 * revision-wait row next to it was a bare spinner with a single static line, no stage at all).
 *
 * This component renders NOTHING it wasn't given: `stages` must be the job's REAL, already-
 * known server-reported sub-stages (the *_STAGES consts already defined in ResearchFlowPage.tsx,
 * mirroring each worker's own heartbeat stages) translated to plain language by the caller —
 * this file invents no new stage names. A job with no meaningful sub-stages (geo:analyze's
 * count-based progress, calibration sample/revise's single state) simply omits `stages` (or
 * passes 0-1 of them) and gets the same visual treatment minus the stepper — "a single 'in
 * progress' state is fine, just make it visually consistent" (task brief).
 *
 * Two layouts:
 *  - the default (full) layout is the whole body of a step whose ONLY content while a job runs
 *    IS the wait state (steps 2/7/9/15/22/23) — vertically centered, larger mark, an optional
 *    stage stepper.
 *  - `inline` is a compact one-line row for steps where the wait state is only PART of the
 *    screen alongside other controls (step 11's "Run sample" area, step 13's revision review,
 *    step 18's live deep-research counter) — same mark + label, sized to sit next to a Group.
 *
 * Motion: a small violet pulse on the AI mark + (in the full layout) a soft pulse on the active
 * stage dot — subtle, never a bare content-free spinner (every state always carries a plain-
 * language label). Respects prefers-reduced-motion via useReducedMotion() (JS) AND the CSS
 * module's own `@media (prefers-reduced-motion: reduce)` fallback, same belt-and-suspenders
 * convention as WizardShell.module.css's `.cardEnter`.
 */
import { Group, Stack, Text, ThemeIcon } from '@mantine/core';
import { useReducedMotion } from '@mantine/hooks';
import { IconCheck, IconSparkles } from '@tabler/icons-react';
import classes from './AiWaitScreen.module.css';

export interface AiWaitStage {
    /** The raw server-reported stage key (e.g. 'crawling_website') — must match one of the
     *  values the job's own *_STAGES const lists, never invented here. */
    key: string;
    /** Already-translated plain-language label (e.g. t('research.wizard.step2.stage.crawling_website')). */
    label: string;
}

export interface AiWaitScreenProps {
    /** This job's ordered, real sub-stages. Omit, or pass fewer than 2, for a job with no
     *  meaningful sub-stages — renders the single-label fallback instead of a stepper. */
    stages?: AiWaitStage[];
    /** The stage key the job is CURRENTLY reporting (its progress.stage), or null/undefined
     *  before the first heartbeat lands. When it doesn't match any entry in `stages` (not yet
     *  reported, or a value outside the known set), the stepper is skipped and `label` (the
     *  caller's own already-resolved 'default' translation) is shown instead — identical
     *  fallback behavior to every ad hoc screen this replaces. */
    activeKey?: string | null;
    /** Plain-language label used when `stages` has fewer than 2 entries, or `activeKey` doesn't
     *  resolve to one of them. */
    label: string;
    /** Compact one-line variant for a wait state embedded alongside other step controls, instead
     *  of being the step's entire body. `stages`/`activeKey` are ignored in this mode (there's no
     *  room for a stepper next to other controls) — only `label` renders, next to the mark. */
    inline?: boolean;
}

function AiMark({ inline, reduceMotion }: { inline?: boolean; reduceMotion: boolean }) {
    const size = inline ? 22 : 48;
    return (
        <div className={`${classes.mark} ${inline ? classes.markInline : classes.markCard} ${reduceMotion ? '' : classes.markPulse}`}>
            {!reduceMotion && <span className={classes.markRing} />}
            <ThemeIcon variant="light" color="violet" radius="xl" size={size} className={classes.markIcon}>
                <IconSparkles size={inline ? 12 : 22} />
            </ThemeIcon>
        </div>
    );
}

export default function AiWaitScreen({ stages, activeKey, label, inline }: AiWaitScreenProps) {
    const reduceMotion = !!useReducedMotion();
    const knownStages = stages && stages.length > 1 ? stages : undefined;
    const activeIndex = knownStages ? knownStages.findIndex((s) => s.key === activeKey) : -1;
    const showStepper = knownStages !== undefined && activeIndex >= 0;

    if (inline) {
        return (
            <Group gap="xs" wrap="nowrap">
                <AiMark inline reduceMotion={reduceMotion} />
                <Text size="sm" c="dimmed">
                    {label}
                </Text>
            </Group>
        );
    }

    return (
        <Stack align="center" gap="md" py="lg">
            <AiMark reduceMotion={reduceMotion} />
            {showStepper ? (
                <Stack gap={6} className={classes.stageList} maw={300}>
                    {knownStages!.map((s, i) => {
                        const done = i < activeIndex;
                        const active = i === activeIndex;
                        return (
                            <div key={s.key} className={classes.stageRow}>
                                <span className={classes.stageIconSlot}>
                                    {done ? (
                                        <IconCheck size={12} className={classes.stageCheck} />
                                    ) : (
                                        <span className={`${classes.stageDot} ${active ? classes.stageDotActive : ''}`} />
                                    )}
                                </span>
                                <Text
                                    size="sm"
                                    className={`${classes.stageLabel} ${done ? classes.stageLabelDone : ''} ${active ? classes.stageLabelActive : ''}`}
                                >
                                    {s.label}
                                </Text>
                            </div>
                        );
                    })}
                </Stack>
            ) : (
                <Text c="dimmed" size="sm" ta="center">
                    {label}
                </Text>
            )}
        </Stack>
    );
}
