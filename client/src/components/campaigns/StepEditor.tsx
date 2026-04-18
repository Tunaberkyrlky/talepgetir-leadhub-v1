import { useRef, useCallback } from 'react';
import { Stack, TextInput, Textarea, Group, NumberInput, Text, Paper, Badge, Tooltip } from '@mantine/core';
import { IconMail, IconClock } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { CampaignStep } from '../../types/campaign';

interface Props {
    step: CampaignStep;
    onChange: (updated: CampaignStep) => void;
    readOnly?: boolean;
}

const VARS = [
    { key: 'first_name', label: 'First Name', color: 'blue' },
    { key: 'last_name', label: 'Last Name', color: 'blue' },
    { key: 'company_name', label: 'Company', color: 'grape' },
    { key: 'title', label: 'Title', color: 'teal' },
    { key: 'website', label: 'Website', color: 'grape' },
    { key: 'industry', label: 'Industry', color: 'grape' },
] as const;

// Track which field was last focused so variable chips insert there
type ActiveField = 'subject' | 'body';

export default function StepEditor({ step, onChange, readOnly }: Props) {
    const { t } = useTranslation();
    const subjectRef = useRef<HTMLInputElement>(null);
    const bodyRef = useRef<HTMLTextAreaElement>(null);
    const lastFocused = useRef<ActiveField>('body');

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
            // Restore cursor after React re-render
            requestAnimationFrame(() => {
                el.focus();
                el.setSelectionRange(start + text.length, start + text.length);
            });
        } else {
            const el = bodyRef.current;
            if (!el) { onChange({ ...step, body_html: (step.body_html || '') + text }); return; }
            const start = el.selectionStart ?? (step.body_html || '').length;
            const end = el.selectionEnd ?? start;
            const val = step.body_html || '';
            const newVal = val.slice(0, start) + text + val.slice(end);
            onChange({ ...step, body_html: newVal });
            requestAnimationFrame(() => {
                el.focus();
                el.setSelectionRange(start + text.length, start + text.length);
            });
        }
    }, [step, onChange, readOnly]);

    if (step.step_type === 'email') {
        return (
            <Stack gap="sm">
                <Group gap="xs" mb={4}>
                    <IconMail size={16} color="var(--mantine-color-indigo-6)" />
                    <Text size="sm" fw={600}>Email Step</Text>
                </Group>
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
                    <Text size="xs" c="dimmed" fw={500}>Variables:</Text>
                    {VARS.map(({ key, label, color }) => (
                        <Tooltip key={key} label={`{{${key}}} → ${lastFocused.current === 'subject' ? 'subject' : 'body'}`} withArrow>
                            <Badge size="xs" variant="light" color={color}
                                style={{ cursor: readOnly ? 'default' : 'pointer' }}
                                onClick={() => insertVariable(key)}
                            >
                                {label}
                            </Badge>
                        </Tooltip>
                    ))}
                </Group>
                <Textarea
                    ref={bodyRef}
                    label={t('campaign.body', 'Email Body (HTML)')}
                    placeholder="Write your email content..."
                    required radius="md" autosize minRows={8} maxRows={20}
                    styles={{ input: { fontFamily: 'monospace', fontSize: 13 } }}
                    value={step.body_html || ''}
                    onChange={(e) => onChange({ ...step, body_html: e.currentTarget.value })}
                    onFocus={() => { lastFocused.current = 'body'; }}
                    disabled={readOnly}
                />
            </Stack>
        );
    }

    return (
        <Stack gap="sm">
            <Group gap="xs" mb={4}>
                <IconClock size={16} color="var(--mantine-color-orange-6)" />
                <Text size="sm" fw={600}>Delay Step</Text>
            </Group>
            <Group grow>
                <NumberInput label="Days" min={0} max={90} radius="md" size="sm"
                    value={step.delay_days || 0}
                    onChange={(v) => onChange({ ...step, delay_days: Number(v) || 0 })}
                    disabled={readOnly}
                />
                <NumberInput label="Hours" min={0} max={23} radius="md" size="sm"
                    value={step.delay_hours || 0}
                    onChange={(v) => onChange({ ...step, delay_hours: Number(v) || 0 })}
                    disabled={readOnly}
                />
            </Group>
            <Paper p="sm" radius="md" bg="orange.0">
                <Text size="xs" c="orange.8">
                    Total wait: {step.delay_days || 0} day{(step.delay_days || 0) !== 1 ? 's' : ''}
                    {(step.delay_hours || 0) > 0 ? ` ${step.delay_hours}h` : ''} before the next step.
                </Text>
            </Paper>
        </Stack>
    );
}
