import { useRef, useCallback, useState } from 'react';
import {
    Stack, TextInput, Textarea, Group, NumberInput, Text, Paper, Badge, Tooltip,
    SegmentedControl, Box,
} from '@mantine/core';
import { IconMail, IconClock, IconPencil, IconEye } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { CampaignStep } from '../../types/campaign';

interface Props {
    step: CampaignStep;
    onChange: (updated: CampaignStep) => void;
    readOnly?: boolean;
    isFirst?: boolean;
}

const VARS = [
    { key: 'first_name', label: 'First Name', color: 'blue' },
    { key: 'last_name', label: 'Last Name', color: 'blue' },
    { key: 'email', label: 'Email', color: 'blue' },
    { key: 'company_name', label: 'Company', color: 'grape' },
    { key: 'title', label: 'Title', color: 'teal' },
    { key: 'website', label: 'Website', color: 'grape' },
    { key: 'industry', label: 'Industry', color: 'grape' },
] as const;

// Önizleme için örnek değişken değerleri.
const SAMPLE: Record<string, string> = {
    first_name: 'Ahmet', last_name: 'Yılmaz', email: 'ahmet@ornek.com',
    title: 'Satın Alma Müdürü', company_name: 'Acme A.Ş.', website: 'acme.com', industry: 'Teknoloji',
};

function applySample(template: string): string {
    let result = template;
    for (const key of Object.keys(SAMPLE)) {
        result = result.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'gi'), SAMPLE[key]);
    }
    return result;
}

type ActiveField = 'subject' | 'body';

export default function StepEditor({ step, onChange, readOnly, isFirst }: Props) {
    const { t } = useTranslation();
    const subjectRef = useRef<HTMLInputElement>(null);
    const bodyRef = useRef<HTMLTextAreaElement>(null);
    const lastFocused = useRef<ActiveField>('body');
    const [mode, setMode] = useState<'write' | 'preview'>('write');

    const insertVariable = useCallback((varKey: string) => {
        if (readOnly) return;
        const text = `{{${varKey}}}`;
        const field = lastFocused.current;

        if (field === 'subject') {
            const el = subjectRef.current;
            if (!el) { onChange({ ...step, subject: (step.subject || '') + text }); return; }
            const start = el.selectionStart ?? (step.subject || '').length;
            const end = el.selectionEnd ?? start;
            const val = step.subject || '';
            const newVal = val.slice(0, start) + text + val.slice(end);
            onChange({ ...step, subject: newVal });
            requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + text.length, start + text.length); });
        } else {
            const el = bodyRef.current;
            if (!el) { onChange({ ...step, body_html: (step.body_html || '') + text }); return; }
            const start = el.selectionStart ?? (step.body_html || '').length;
            const end = el.selectionEnd ?? start;
            const val = step.body_html || '';
            const newVal = val.slice(0, start) + text + val.slice(end);
            onChange({ ...step, body_html: newVal });
            requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + text.length, start + text.length); });
        }
    }, [step, onChange, readOnly]);

    // Legacy 'delay' düğümü (yeni model üretmez) — güvenli geri dönüş.
    if (step.step_type === 'delay') {
        return (
            <Stack gap="sm">
                <Group gap="xs" mb={4}>
                    <IconClock size={16} color="var(--mantine-color-orange-6)" />
                    <Text size="sm" fw={600}>{t('campaign.editor.delayStep', 'Delay Step')}</Text>
                </Group>
                <Group grow>
                    <NumberInput label={t('campaign.editor.days', 'Days')} min={0} max={90} radius="md" size="sm"
                        value={step.delay_days || 0} onChange={(v) => onChange({ ...step, delay_days: Number(v) || 0 })} disabled={readOnly} />
                    <NumberInput label={t('campaign.editor.hours', 'Hours')} min={0} max={23} radius="md" size="sm"
                        value={step.delay_hours || 0} onChange={(v) => onChange({ ...step, delay_hours: Number(v) || 0 })} disabled={readOnly} />
                </Group>
            </Stack>
        );
    }

    return (
        <Stack gap="sm">
            <Group gap="xs" mb={4}>
                <IconMail size={16} color="var(--mantine-color-indigo-6)" />
                <Text size="sm" fw={600}>{t('campaign.editor.emailStep', 'Email Step')}</Text>
            </Group>

            {/* ── Bekleme (önceki adımdan sonra) — ilk adımda gizli ── */}
            {isFirst ? (
                <Paper p="xs" radius="md" bg="teal.0">
                    <Text size="xs" c="teal.8">{t('campaign.editor.firstStepNote', 'Sent as soon as the contact is enrolled.')}</Text>
                </Paper>
            ) : (
                <Paper p="sm" radius="md" withBorder>
                    <Text size="xs" fw={600} c="dimmed" mb="xs">{t('campaign.editor.waitBefore', 'Wait before sending (after previous step)')}</Text>
                    <Group grow>
                        <NumberInput label={t('campaign.editor.days', 'Days')} min={0} max={90} radius="md" size="sm"
                            value={step.delay_days || 0} onChange={(v) => onChange({ ...step, delay_days: Number(v) || 0 })} disabled={readOnly} />
                        <NumberInput label={t('campaign.editor.hours', 'Hours')} min={0} max={23} radius="md" size="sm"
                            value={step.delay_hours || 0} onChange={(v) => onChange({ ...step, delay_hours: Number(v) || 0 })} disabled={readOnly} />
                    </Group>
                </Paper>
            )}

            <TextInput
                ref={subjectRef}
                label={t('campaign.subject', 'Subject')}
                placeholder="Email subject — use {{first_name}} for personalization"
                required radius="md" size="sm"
                value={step.subject || ''}
                onChange={(e) => onChange({ ...step, subject: e.currentTarget.value })}
                onFocus={() => { lastFocused.current = 'subject'; }}
                disabled={readOnly}
            />

            <Group gap={4}>
                <Text size="xs" c="dimmed" fw={500}>{t('campaign.editor.variables', 'Variables')}:</Text>
                {VARS.map(({ key, label, color }) => (
                    <Tooltip key={key} label={`{{${key}}}`} withArrow>
                        <Badge size="xs" variant="light" color={color}
                            style={{ cursor: readOnly ? 'default' : 'pointer' }}
                            onClick={() => insertVariable(key)}>
                            {label}
                        </Badge>
                    </Tooltip>
                ))}
            </Group>

            <Group justify="space-between" align="center">
                <Text size="sm" fw={500}>{t('campaign.body', 'Email Body (HTML)')}</Text>
                <SegmentedControl size="xs" value={mode} onChange={(v) => setMode(v as 'write' | 'preview')}
                    data={[
                        { value: 'write', label: <Group gap={4} wrap="nowrap"><IconPencil size={12} />{t('campaign.editor.write', 'Write')}</Group> },
                        { value: 'preview', label: <Group gap={4} wrap="nowrap"><IconEye size={12} />{t('campaign.editor.preview', 'Preview')}</Group> },
                    ]} />
            </Group>

            {mode === 'write' ? (
                <Textarea
                    ref={bodyRef}
                    placeholder="Write your email content... HTML supported."
                    required radius="md" autosize minRows={8} maxRows={20}
                    styles={{ input: { fontFamily: 'monospace', fontSize: 13 } }}
                    value={step.body_html || ''}
                    onChange={(e) => onChange({ ...step, body_html: e.currentTarget.value })}
                    onFocus={() => { lastFocused.current = 'body'; }}
                    disabled={readOnly}
                />
            ) : (
                <Paper withBorder radius="md" p="md" mih={200}>
                    <Text size="xs" c="dimmed" mb={4}>{t('campaign.editor.previewSubject', 'Subject')}: <Text span fw={600} c="dark">{applySample(step.subject || '') || '—'}</Text></Text>
                    <Box style={{ borderTop: '1px solid var(--mantine-color-gray-2)', paddingTop: 12 }}
                        dangerouslySetInnerHTML={{ __html: applySample(step.body_html || '') || `<span style="color:#aaa">${t('campaign.editor.previewEmpty', 'Nothing to preview yet.')}</span>` }} />
                    <Text size="xs" c="dimmed" mt="sm">{t('campaign.editor.previewNote', 'Preview uses sample data (e.g. Ahmet, Acme A.Ş.).')}</Text>
                </Paper>
            )}
        </Stack>
    );
}
