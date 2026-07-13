/**
 * WizardShell — reusable Typeform-style chrome (WP6, redesigned).
 * One screen, one task (tg-research-ana-akis.md ilke 0.1): a phase-based progress indicator,
 * a single primary CTA, a "Geri" (back) button, and a children slot for the step content.
 * Purely presentational — no business logic, no data fetching — so WP7-WP10 steps can all
 * mount inside it without re-deriving the chrome. Renders full-viewport (Layout.tsx bypasses
 * the CRM AppShell entirely for the exact `/research` route) and owns its own minimal header
 * (logo mark, phase progress, quiet way back to the dashboard) in place of the CRM
 * sidebar+topbar — `/research/full` (the advanced tabbed view) is untouched and keeps
 * rendering inside the normal Layout.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Box, Container, Paper, Stack, Group, Title, Text, Button, Progress, ThemeIcon, ActionIcon, Tooltip, Transition } from '@mantine/core';
import { useReducedMotion } from '@mantine/hooks';
import { IconArrowLeft, IconTargetArrow, IconLayoutDashboard, IconCheck } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import classes from './WizardShell.module.css';

export interface WizardShellProps {
    /** 1-indexed current step. */
    step: number;
    /** Total steps in the flow (used for the phase indicator's sub-progress). */
    totalSteps: number;
    title: string;
    subtitle?: string;
    /** Omit to hide the back button (e.g. on the very first step). */
    onBack?: () => void;
    /** Omit to hide the primary CTA (e.g. a pure informational screen). */
    primaryLabel?: string;
    onPrimary?: () => void;
    /** Also drives the header's quiet "saving…" indicator — most primary clicks in this flow
     *  ARE a save (saveStepMut), so this existing signal doubles as the save state instead of
     *  inventing a new prop the shell would have to be threaded with. */
    primaryLoading?: boolean;
    primaryDisabled?: boolean;
    /** Extra controls next to the primary CTA (e.g. a secondary "advanced view" link). */
    secondaryActions?: ReactNode;
    /** WP10: steps that embed an existing full-page panel (a data table + its own launcher
     *  chrome, e.g. CompaniesPanel/EnrichmentPanel) need more than the default single-column
     *  "sm" width — those panels were built for a full page, not a Typeform card, and crowd
     *  badly at ~510px. Every other step (a form, one card, one wait screen) keeps the default
     *  narrow width, which is the whole point of the one-screen-one-task chrome. */
    wide?: boolean;
    children: ReactNode;
}

// Customer-facing 7-phase breakdown (distinct from tg-research-ana-akis.md's own FAZ 1-7
// headers, which are collapsed/merged here for a wizard progress indicator — see the doc's
// "Adım → motor eşlemesi" table + ResearchFlowPage.tsx's STEP_ORDER/displayStep for the raw
// step → display-step mapping this mirrors). `steps` is each phase's share of the total flow
// in display-step terms; kept relative (not absolute step numbers) so the indicator degrades
// gracefully if KNOWN_STEPS ever grows without this file being touched.
const PHASES = [
    { key: 'setup', label: 'Kurulum', steps: 2 }, // kickoff form, "firmanızı araştırıyoruz"
    { key: 'profile', label: 'Profil', steps: 4 }, // özet onayı, ürünler, farklılaştırıcılar, ipuçları
    { key: 'product', label: 'Ürün/HS', steps: 2 }, // HS kod eşleme + pazar analizi
    { key: 'icp', label: 'ICP', steps: 4 }, // sub-ICP kartları + ülke uyarlama
    { key: 'calibration', label: 'Kalibrasyon', steps: 6 }, // örneklem→geri bildirim→revizyon döngüsü + mesaj açıları
    { key: 'scale', label: 'Coğrafya/Ölçek', steps: 2 }, // ölçek hedefi + derin araştırma başlatma
    { key: 'results', label: 'Sonuçlar', steps: 3 }, // sonuç listesi, kişiler, CRM devri
] as const;
const PHASE_TOTAL_STEPS = PHASES.reduce((sum, p) => sum + p.steps, 0);

// Fade + small slide, composed with (not stacked on top of) this shell's own per-step remount:
// the Paper below is keyed by `step`, so this inner component gets a genuinely FRESH mount
// every time the step changes (React tears down the old instance and creates a new one — this
// local `mounted` state can never carry over from a previous step) — the effect below flips it
// from its fresh `false` to `true` one paint after that mount, giving Mantine's own Transition
// component a real false->true edge to animate on every single step swap, the only edge it ever
// animates (see @mantine/core's useTransition: the transition only fires on an UPDATE to
// `mounted`, never on an already-`true` initial render). Replaces the earlier CSS-keyframe-on-
// mount approach 1:1 (same trigger, same visual shape, same duration ballpark) rather than
// layering a second animation on top of it — WizardShell owns per-step remounting, so this is
// the one place in the wizard the swap can be wrapped without touching ResearchFlowPage.tsx's
// step-branch rendering at all (Tg-Research-v2/06_WIZARD_TASARIM.md, Karar 4).
function StepTransition({ reduceMotion, children }: { reduceMotion: boolean; children: ReactNode }) {
    const [mounted, setMounted] = useState(false);
    // requestAnimationFrame (not a bare setState-in-effect) so this stays outside the
    // react-hooks/set-state-in-effect rule's synchronous-update check while still flipping
    // false->true one paint after mount — same trigger as OfferCard.tsx's own entrance effect.
    useEffect(() => {
        const frame = requestAnimationFrame(() => setMounted(true));
        return () => cancelAnimationFrame(frame);
    }, []);
    if (reduceMotion) return <>{children}</>;
    return (
        <Transition
            mounted={mounted}
            duration={220}
            exitDuration={0}
            timingFunction="cubic-bezier(0.16, 1, 0.3, 1)"
            transition={{
                in: { opacity: 1, transform: 'translateY(0)' },
                out: { opacity: 0, transform: 'translateY(10px)' },
                transitionProperty: 'opacity, transform',
            }}
        >
            {(styles) => <div style={styles}>{children}</div>}
        </Transition>
    );
}

function getPhaseInfo(step: number, totalSteps: number) {
    const denom = totalSteps > 0 ? totalSteps : PHASE_TOTAL_STEPS;
    const scale = denom / PHASE_TOTAL_STEPS;
    let cumulative = 0;
    for (let i = 0; i < PHASES.length; i++) {
        const phaseStart = cumulative * scale;
        const phaseEnd = (cumulative + PHASES[i].steps) * scale;
        if (step <= phaseEnd || i === PHASES.length - 1) {
            const span = Math.max(phaseEnd - phaseStart, 1);
            const progress = Math.min(100, Math.max(0, ((step - phaseStart) / span) * 100));
            return { index: i, progress };
        }
        cumulative += PHASES[i].steps;
    }
    return { index: PHASES.length - 1, progress: 100 };
}

export default function WizardShell({
    step,
    totalSteps,
    title,
    subtitle,
    onBack,
    primaryLabel,
    onPrimary,
    primaryLoading,
    primaryDisabled,
    secondaryActions,
    wide,
    children,
}: WizardShellProps) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const reduceMotion = useReducedMotion();
    const { index: phaseIndex, progress: phaseProgress } = getPhaseInfo(step, totalSteps);
    const currentPhase = PHASES[phaseIndex];

    return (
        <Box className={classes.page}>
            <Box component="header" className={classes.header}>
                <Container size={wide ? 'lg' : 'sm'} py="sm">
                    <Group justify="space-between" mb="xs">
                        <Group
                            gap={8}
                            className={classes.logo}
                            onClick={() => navigate('/dashboard')}
                            role="button"
                            tabIndex={0}
                            aria-label={t('research.wizard.backToDashboard', "Dashboard'a dön")}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    navigate('/dashboard');
                                }
                            }}
                        >
                            <ThemeIcon variant="light" color="violet" radius="xl" size={28}>
                                <IconTargetArrow size={16} />
                            </ThemeIcon>
                            <Text fw={700} size="sm">
                                {t('research.wizard.brand', 'TG Research')}
                            </Text>
                        </Group>
                        <Group gap="sm">
                            {primaryLoading && (
                                <Text size="xs" c="dimmed">
                                    {t('research.wizard.saving', 'Kaydediliyor…')}
                                </Text>
                            )}
                            <Tooltip label={t('research.wizard.backToDashboard', "Dashboard'a dön")} position="bottom" withArrow>
                                <ActionIcon
                                    variant="subtle"
                                    color="gray"
                                    radius="xl"
                                    className={classes.backLink}
                                    onClick={() => navigate('/dashboard')}
                                    aria-label={t('research.wizard.backToDashboard', "Dashboard'a dön")}
                                >
                                    <IconLayoutDashboard size={16} />
                                </ActionIcon>
                            </Tooltip>
                        </Group>
                    </Group>

                    <Text size="xs" fw={700} c="violet" tt="uppercase" style={{ letterSpacing: 0.4 }}>
                        {t('research.wizard.phaseOf', 'Faz {{index}}/{{total}}', { index: phaseIndex + 1, total: PHASES.length })}
                        {' · '}
                        {t(`research.wizard.phase.${currentPhase.key}`, currentPhase.label)}
                    </Text>
                    <Group gap={4} mt={6} wrap="wrap">
                        {PHASES.map((phase, i) => {
                            const isDone = i < phaseIndex;
                            const isCurrent = i === phaseIndex;
                            return (
                                <Group key={phase.key} gap={4} wrap="nowrap">
                                    <Tooltip label={t(`research.wizard.phase.${phase.key}`, phase.label)} position="bottom" withArrow>
                                        <ThemeIcon
                                            size={18}
                                            radius="xl"
                                            variant={isDone ? 'filled' : isCurrent ? 'filled' : 'light'}
                                            color={isDone || isCurrent ? 'violet' : 'gray'}
                                        >
                                            {isDone ? (
                                                <IconCheck size={11} />
                                            ) : (
                                                <Text size="9px" fw={700}>
                                                    {i + 1}
                                                </Text>
                                            )}
                                        </ThemeIcon>
                                    </Tooltip>
                                    {i < PHASES.length - 1 && <Box className={classes.connector} data-done={isDone} />}
                                </Group>
                            );
                        })}
                    </Group>
                    <Progress value={phaseProgress} size={3} radius="xl" color="violet" mt={8} />
                </Container>
            </Box>

            <Box component="main" className={classes.main}>
                <Container size={wide ? 'lg' : 'sm'} w="100%" px={0}>
                    <Stack gap="lg">
                        <Paper key={step} withBorder radius="md" p="xl">
                            <StepTransition reduceMotion={!!reduceMotion}>
                                <Stack gap="md">
                                    <div>
                                        <Title order={3}>{title}</Title>
                                        {subtitle && (
                                            <Text c="dimmed" size="sm" mt={4}>
                                                {subtitle}
                                            </Text>
                                        )}
                                    </div>
                                    {children}
                                </Stack>
                            </StepTransition>
                        </Paper>

                        <Group justify="space-between">
                            <div>
                                {onBack && (
                                    <Button variant="subtle" color="gray" leftSection={<IconArrowLeft size={16} />} onClick={onBack}>
                                        {t('research.wizard.back', 'Back')}
                                    </Button>
                                )}
                            </div>
                            <Group gap="sm">
                                {secondaryActions}
                                {primaryLabel && onPrimary && (
                                    <Button
                                        className={classes.primaryButton}
                                        onClick={onPrimary}
                                        loading={primaryLoading}
                                        disabled={primaryDisabled}
                                    >
                                        {primaryLabel}
                                    </Button>
                                )}
                            </Group>
                        </Group>
                    </Stack>
                </Container>
            </Box>
        </Box>
    );
}
