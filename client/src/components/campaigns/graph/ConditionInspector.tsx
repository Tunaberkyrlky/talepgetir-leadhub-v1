// Koşul (condition) node düzenleyicisi — sağ panelde açılır.
// Kullanıcı: koşul tipini, (açılma/tıklama için) hangi mailin kontrol edileceğini,
// kaç saat bekleneceğini ve Evet/Hayır dallarının nereye gideceğini seçer.
// Yönlendirme adım id'leriyle saklanır (true/false pointer); "Diziyi bitir" = null.
import { Stack, Group, Text, ThemeIcon, Select, NumberInput, Divider } from '@mantine/core';
import { IconGitBranch, IconCheck, IconX } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { CampaignStep } from '../../../types/campaign';

const END = '__end__'; // Select sentinel'i — null (dal burada biter) yerine.

interface Props {
    step: CampaignStep;
    steps: CampaignStep[];
    selectedIdx: number;
    onChange: (patch: Partial<CampaignStep>) => void;
    readOnly?: boolean;
}

export default function ConditionInspector({ step, steps, selectedIdx, onChange, readOnly }: Props) {
    const { t } = useTranslation();
    const ct = step.condition_type || 'opened';
    const isEventType = ct.includes('open') || ct.includes('click'); // replied → enrollment seviyesi, mail seçimi yok
    const config = (step.config as Record<string, unknown> | null) || {};
    const evalStepId = (config.eval_step_id as string | undefined) || null;

    const typeOptions = ['opened', 'not_opened', 'clicked', 'not_clicked', 'replied', 'not_replied'].map((v) => ({
        value: v, label: t(`campaign.editor.graph.ct.${v}`, v),
    }));

    // Değerlendirilecek mail adayları — yalnız e-posta adımları.
    const emailOptions = steps
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => s.step_type === 'email' && !!s.id)
        .map(({ s, i }) => ({
            value: s.id as string,
            label: `${i + 1}. ${(s.subject || '').trim() || t('campaign.editor.graph.untitled', '(no subject)')}`,
        }));

    // Dal hedefi adayları — koşulun kendisi hariç tüm adımlar + "Diziyi bitir".
    const targetOptions = [
        { value: END, label: t('campaign.editor.graph.targetEnd', 'End sequence') },
        ...steps
            .map((s, i) => ({ s, i }))
            .filter(({ i, s }) => i !== selectedIdx && !!s.id)
            .map(({ s, i }) => ({ value: s.id as string, label: stepLabel(s, i, t) })),
    ];

    const patchConfig = (extra: Record<string, unknown>) => onChange({ config: { ...config, ...extra } });

    return (
        <Stack gap="sm">
            <Group gap="xs" mb={2}>
                <ThemeIcon size="sm" radius="md" variant="light" color="yellow"><IconGitBranch size={14} /></ThemeIcon>
                <Text size="sm" fw={600}>{t('campaign.editor.graph.conditionTitle', 'Condition')}</Text>
            </Group>
            <Text size="xs" c="dimmed">{t('campaign.editor.graph.conditionNote', 'Waits, then checks the contact and splits into Yes / No branches.')}</Text>

            <Select label={t('campaign.editor.graph.conditionType', 'When')} data={typeOptions} value={ct} allowDeselect={false}
                radius="md" size="sm" disabled={readOnly}
                onChange={(v) => onChange({ condition_type: v || 'opened' })} />

            {isEventType && (
                <Select label={t('campaign.editor.graph.evalEmail', 'Which email?')} data={emailOptions} value={evalStepId}
                    placeholder={t('campaign.editor.graph.evalEmailPlaceholder', 'Any email')} clearable
                    radius="md" size="sm" disabled={readOnly}
                    onChange={(v) => patchConfig({ eval_step_id: v || undefined })} />
            )}

            <NumberInput label={t('campaign.editor.graph.waitHoursLabel', 'Wait before checking (hours)')} min={0} max={8760}
                radius="md" size="sm" disabled={readOnly}
                value={step.condition_wait_hours ?? 72} onChange={(v) => onChange({ condition_wait_hours: Number(v) || 0 })} />

            <Divider my={4} />

            <Select label={<Group gap={4} wrap="nowrap"><IconCheck size={13} color="var(--mantine-color-teal-6)" />{t('campaign.editor.graph.branchTrueTarget', 'Yes → go to')}</Group>}
                data={targetOptions} value={step.condition_true_step_id || END} allowDeselect={false}
                radius="md" size="sm" disabled={readOnly}
                onChange={(v) => onChange({ condition_true_step_id: v === END ? null : v })} />

            <Select label={<Group gap={4} wrap="nowrap"><IconX size={13} color="var(--mantine-color-red-6)" />{t('campaign.editor.graph.branchFalseTarget', 'No → go to')}</Group>}
                data={targetOptions} value={step.condition_false_step_id || END} allowDeselect={false}
                radius="md" size="sm" disabled={readOnly}
                onChange={(v) => onChange({ condition_false_step_id: v === END ? null : v })} />
        </Stack>
    );
}

function stepLabel(s: CampaignStep, i: number, t: TFunction): string {
    const kind = s.step_type === 'email'
        ? ((s.subject || '').trim() || t('campaign.editor.graph.untitled', '(no subject)'))
        : s.step_type === 'condition'
            ? t('campaign.editor.graph.condition', 'Condition')
            : t('campaign.editor.graph.wait', 'Wait');
    return `${i + 1}. ${kind}`;
}
