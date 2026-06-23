import { useRef, useCallback, useState } from 'react';
import {
    Stack, TextInput, Textarea, Group, NumberInput, Text, Paper, Badge, Tooltip,
    SegmentedControl, Box, Button, Modal,
} from '@mantine/core';
import { RichTextEditor, Link } from '@mantine/tiptap';
import { useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { VariableSuggestion } from './variableSuggestion';
import { Spintax } from './spintaxNode';
import { spintaxTextToHtml, spintaxHtmlToText } from './spintaxSerialize';
import SubjectEditor, { type SubjectEditorRef } from './SubjectEditor';
import { IconMail, IconPencil, IconEye, IconSend, IconCode } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { CampaignStep } from '../../types/campaign';

interface Props {
    step: CampaignStep;
    onChange: (patch: Partial<CampaignStep>) => void;
    readOnly?: boolean;
    isFirst?: boolean;
    onSendTest?: (p: { to: string; subject: string; body_html: string }) => Promise<void>;
    defaultTestEmail?: string;
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

// Önizlemede spintax'ın ilk seçeneğini gösterir (rastgele değil — stabil önizleme).
function resolveSpintaxFirst(template: string): string {
    return template.replace(/\{\{\s*random\s*\|((?:[^{}]|\{\{[^{}]*\}\})*)\}\}/gi, (_m, group: string) => (group.split('|')[0] || '').trim());
}

function applySample(template: string): string {
    let result = resolveSpintaxFirst(template);
    for (const key of Object.keys(SAMPLE)) {
        result = result.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'gi'), SAMPLE[key]);
    }
    return result;
}

type ActiveField = 'subject' | 'body';
type Mode = 'write' | 'html' | 'preview';

// İmlece ham metin ekler (subject TextInput / html Textarea için ortak).
function insertAtRef(el: HTMLInputElement | HTMLTextAreaElement | null, val: string, setVal: (v: string) => void, text: string) {
    if (!el) { setVal(val + text); return; }
    const start = el.selectionStart ?? val.length;
    const end = el.selectionEnd ?? start;
    setVal(val.slice(0, start) + text + val.slice(end));
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + text.length, start + text.length); });
}

export default function StepEditor({ step, onChange, readOnly, isFirst, onSendTest, defaultTestEmail }: Props) {
    const { t } = useTranslation();
    const subjectEditorRef = useRef<SubjectEditorRef>(null);
    const bodyRef = useRef<HTMLTextAreaElement>(null);
    const lastFocused = useRef<ActiveField>('body');
    const [mode, setMode] = useState<Mode>('write');
    const [testOpen, setTestOpen] = useState(false);
    const [testEmail, setTestEmail] = useState(defaultTestEmail || '');
    const [sending, setSending] = useState(false);

    // Zengin editör — gövdenin kaynağı. Boşsa body_html '' yapılır ki "boş adım"
    // uyarısı ve doğrulama çalışsın (Tiptap boşken '<p></p>' döndürür).
    const editor = useEditor({
        extensions: [StarterKit, Link.configure({ openOnClick: false }), VariableSuggestion, Spintax],
        content: spintaxTextToHtml(step.body_html || ''),
        editable: !readOnly,
        // Kaydederken spintax pill'leri kanonik {{random|...}} metnine geri çevrilir.
        onUpdate: ({ editor }) => onChange({ body_html: editor.isEmpty ? '' : spintaxHtmlToText(editor.getHTML()) }),
        onFocus: () => { lastFocused.current = 'body'; },
    });

    const handleSendTest = async () => {
        if (!onSendTest || !testEmail.trim()) return;
        setSending(true);
        try {
            await onSendTest({ to: testEmail.trim(), subject: step.subject || '', body_html: step.body_html || '' });
            setTestOpen(false);
        } catch {
            /* bildirim çağıran tarafta gösteriliyor */
        } finally {
            setSending(false);
        }
    };

    // Değişken/spintax ekleme — odaktaki alana göre (konu / zengin gövde / html).
    const insertText = useCallback((text: string) => {
        if (readOnly) return;
        if (lastFocused.current === 'subject') {
            subjectEditorRef.current?.insertVariable(text);
        } else if (mode === 'html') {
            insertAtRef(bodyRef.current, step.body_html || '', (v) => onChange({ body_html: v }), text);
        } else {
            editor?.chain().focus().insertContent(text).run();
        }
    }, [readOnly, mode, step.body_html, onChange, editor]);

    // Spintax: konu + zengin modda pill (node); HTML kaynağında düz {{random|...}} metni.
    const insertSpintax = useCallback(() => {
        if (readOnly) return;
        if (lastFocused.current === 'subject') {
            subjectEditorRef.current?.insertSpintax();
        } else if (mode === 'html') {
            insertAtRef(bodyRef.current, step.body_html || '', (v) => onChange({ body_html: v }), '{{random|A|B|C}}');
        } else {
            editor?.chain().focus().insertContent({ type: 'spintax', attrs: { options: ['A', 'B', 'C'] } }).run();
        }
    }, [readOnly, mode, step.body_html, onChange, editor]);

    // Mod değişimi — zengin moda her girişte içeriği kaynaktan (step.body_html)
    // tazele; böylece HTML kaynağında yapılan elle düzenlemeler editöre yansır.
    const changeMode = (m: Mode) => {
        if (m === 'write' && editor) {
            editor.commands.setContent(spintaxTextToHtml(step.body_html || ''), false);
        }
        setMode(m);
    };

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
                            value={step.delay_days || 0} onChange={(v) => onChange({ delay_days: Number(v) || 0 })} disabled={readOnly} />
                        <NumberInput label={t('campaign.editor.hours', 'Hours')} min={0} max={23} radius="md" size="sm"
                            value={step.delay_hours || 0} onChange={(v) => onChange({ delay_hours: Number(v) || 0 })} disabled={readOnly} />
                    </Group>
                </Paper>
            )}

            <SubjectEditor
                ref={subjectEditorRef}
                label={t('campaign.subject', 'Subject')}
                placeholder={t('campaign.editor.subjectPlaceholder', 'Email subject — use {{first_name}} for personalization')}
                required
                value={step.subject || ''}
                onChange={(v) => onChange({ subject: v })}
                onFocus={() => { lastFocused.current = 'subject'; }}
                disabled={readOnly}
            />

            <Group gap={4}>
                <Text size="xs" c="dimmed" fw={500}>{t('campaign.editor.variables', 'Variables')}:</Text>
                {VARS.map(({ key, label, color }) => (
                    <Tooltip key={key} label={`{{${key}}}`} withArrow>
                        <Badge component="button" type="button" size="xs" variant="light" color={color}
                            disabled={readOnly}
                            aria-label={t('campaign.editor.insertVariable', { label, defaultValue: `Insert variable: ${label}` })}
                            style={{ cursor: readOnly ? 'default' : 'pointer' }}
                            onClick={() => insertText(`{{${key}}}`)}>
                            {label}
                        </Badge>
                    </Tooltip>
                ))}
                <Tooltip label="{{random|A|B|C}}" withArrow>
                    <Badge component="button" type="button" size="xs" variant="light" color="violet"
                        disabled={readOnly}
                        aria-label={t('campaign.editor.insertSpintax', 'Insert spintax')}
                        style={{ cursor: readOnly ? 'default' : 'pointer' }}
                        onClick={insertSpintax}>
                        {t('campaign.editor.spintax', 'Spintax')}
                    </Badge>
                </Tooltip>
            </Group>
            <Text size="xs" c="dimmed">{t('campaign.editor.typeHint', 'Tip: you can also type variables and spintax by hand.')}</Text>

            <Group justify="space-between" align="center">
                <Text size="sm" fw={500}>{t('campaign.body', 'Email Body')}</Text>
                <Group gap="xs">
                    {onSendTest && (
                        <Button size="xs" variant="light" color="violet" leftSection={<IconSend size={13} />}
                            onClick={() => { setTestEmail((e) => e || defaultTestEmail || ''); setTestOpen(true); }}>
                            {t('campaign.editor.testSend', 'Send test')}
                        </Button>
                    )}
                    <SegmentedControl size="xs" value={mode} onChange={(v) => changeMode(v as Mode)}
                        data={[
                            { value: 'write', label: <Group gap={4} wrap="nowrap"><IconPencil size={12} />{t('campaign.editor.write', 'Write')}</Group> },
                            { value: 'html', label: <Group gap={4} wrap="nowrap"><IconCode size={12} />HTML</Group> },
                            { value: 'preview', label: <Group gap={4} wrap="nowrap"><IconEye size={12} />{t('campaign.editor.preview', 'Preview')}</Group> },
                        ]} />
                </Group>
            </Group>

            {mode === 'write' && (
                <RichTextEditor editor={editor} style={{ minHeight: 220 }}>
                    {!readOnly && (
                        <RichTextEditor.Toolbar sticky>
                            <RichTextEditor.ControlsGroup>
                                <RichTextEditor.Bold />
                                <RichTextEditor.Italic />
                                <RichTextEditor.Strikethrough />
                                <RichTextEditor.ClearFormatting />
                            </RichTextEditor.ControlsGroup>
                            <RichTextEditor.ControlsGroup>
                                <RichTextEditor.H2 />
                                <RichTextEditor.H3 />
                                <RichTextEditor.BulletList />
                                <RichTextEditor.OrderedList />
                            </RichTextEditor.ControlsGroup>
                            <RichTextEditor.ControlsGroup>
                                <RichTextEditor.Link />
                                <RichTextEditor.Unlink />
                            </RichTextEditor.ControlsGroup>
                            <RichTextEditor.ControlsGroup>
                                <RichTextEditor.Undo />
                                <RichTextEditor.Redo />
                            </RichTextEditor.ControlsGroup>
                        </RichTextEditor.Toolbar>
                    )}
                    <RichTextEditor.Content />
                </RichTextEditor>
            )}

            {mode === 'html' && (
                <Textarea
                    ref={bodyRef}
                    placeholder={t('campaign.editor.bodyPlaceholder', 'Write your email content... HTML supported.')}
                    radius="md" autosize minRows={8} maxRows={20}
                    styles={{ input: { fontFamily: 'monospace', fontSize: 13 } }}
                    value={step.body_html || ''}
                    onChange={(e) => onChange({ body_html: e.currentTarget.value })}
                    onFocus={() => { lastFocused.current = 'body'; }}
                    disabled={readOnly}
                />
            )}

            {mode === 'preview' && (
                <Paper withBorder radius="md" p="md" mih={200}>
                    <Text size="xs" c="dimmed" mb={4}>{t('campaign.editor.previewSubject', 'Subject')}: <Text span fw={600} c="dark">{applySample(step.subject || '') || '—'}</Text></Text>
                    <Box style={{ borderTop: '1px solid var(--mantine-color-gray-2)', paddingTop: 12 }}
                        dangerouslySetInnerHTML={{ __html: applySample(step.body_html || '') || `<span style="color:#aaa">${t('campaign.editor.previewEmpty', 'Nothing to preview yet.')}</span>` }} />
                    <Text size="xs" c="dimmed" mt="sm">{t('campaign.editor.previewNote', 'Preview uses sample data (e.g. Ahmet, Acme A.Ş.).')}</Text>
                </Paper>
            )}

            <Modal opened={testOpen} onClose={() => setTestOpen(false)} radius="lg" centered size="sm"
                title={t('campaign.editor.testSendTitle', 'Send test email')}
                overlayProps={{ backgroundOpacity: 0.4, blur: 4 }}>
                <Stack gap="sm">
                    <TextInput type="email" label={t('campaign.editor.testTo', 'Send to')}
                        value={testEmail} onChange={(e) => setTestEmail(e.currentTarget.value)} radius="md" size="sm" />
                    <Text size="xs" c="dimmed">{t('campaign.editor.testNote', 'Spintax and variables are filled with sample data (e.g. Ahmet, Acme).')}</Text>
                    <Group justify="flex-end" gap="xs">
                        <Button variant="default" radius="md" size="sm" onClick={() => setTestOpen(false)}>
                            {t('common.cancel', 'Cancel')}
                        </Button>
                        <Button color="violet" radius="md" size="sm" leftSection={<IconSend size={14} />}
                            loading={sending} disabled={!testEmail.trim()} onClick={handleSendTest}>
                            {t('campaign.editor.testSend', 'Send test')}
                        </Button>
                    </Group>
                </Stack>
            </Modal>
        </Stack>
    );
}
