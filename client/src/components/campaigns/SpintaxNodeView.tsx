import { useState } from 'react';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { Popover, Stack, TextInput, ActionIcon, Button, Group, Text } from '@mantine/core';
import { IconX, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';

// {{random|...}} bloğunu temsil eden inline pill. Tıklayınca seçenekler düzenlenir.
export default function SpintaxNodeView({ node, updateAttributes, deleteNode, editor }: NodeViewProps) {
    const { t } = useTranslation();
    const attrOpts: string[] = node.attrs.options || [];
    const [opts, setOpts] = useState<string[]>(attrOpts.length ? attrOpts : ['']);
    const [opened, setOpened] = useState(false);

    // Dış değişimi (undo/redo) yansıt — effect yerine render-anı senkron.
    const [prevAttr, setPrevAttr] = useState(node.attrs.options);
    if (node.attrs.options !== prevAttr) {
        setPrevAttr(node.attrs.options);
        setOpts(attrOpts.length ? attrOpts : ['']);
    }

    // Yazarken yalnız yerel state güncellenir; node'a yazma (transaction) blur ve
    // popover kapanışında olur — böylece her tuşta ProseMirror focus'u çalmaz.
    const sync = (next: string[]) => { setOpts(next); updateAttributes({ options: next }); };
    const setAt = (i: number, v: string) => setOpts(opts.map((o, idx) => (idx === i ? v : o)));
    const commitCurrent = () => updateAttributes({ options: opts });
    const removeAt = (i: number) => { const next = opts.filter((_, idx) => idx !== i); sync(next.length ? next : ['']); };
    const add = () => sync([...opts, '']);

    const editable = editor.isEditable;
    const label = (opts[0] || '').trim() || t('campaign.editor.spintaxEmpty', 'spintax');
    const extra = opts.length - 1;

    return (
        <NodeViewWrapper as="span" style={{ display: 'inline-block', verticalAlign: 'baseline' }} contentEditable={false}>
            <Popover opened={opened} onChange={(o) => { setOpened(o); if (!o) commitCurrent(); }} position="bottom-start" withArrow shadow="md" width={280} disabled={!editable} trapFocus>
                <Popover.Target>
                    <span
                        onClick={() => editable && setOpened((o) => !o)}
                        style={{
                            // Gövde fontuyla aynı boyut/satır yüksekliği — metne uyumlu akar.
                            fontSize: 'inherit',
                            lineHeight: 'inherit',
                            fontWeight: 500,
                            padding: '0 5px',
                            borderRadius: 5,
                            background: 'var(--mantine-color-violet-0)',
                            color: 'var(--mantine-color-violet-8)',
                            border: '1px solid var(--mantine-color-violet-2)',
                            cursor: editable ? 'pointer' : 'default',
                            whiteSpace: 'nowrap',
                        }}
                    >
                        {label}{extra > 0 ? ` +${extra}` : ''}
                    </span>
                </Popover.Target>
                <Popover.Dropdown>
                    <Stack gap={6}>
                        <Text size="xs" fw={600} c="dimmed">{t('campaign.editor.spintaxTitle', 'Spintax — one is picked at random')}</Text>
                        {opts.map((o, i) => (
                            <Group key={i} gap={4} wrap="nowrap">
                                <TextInput
                                    value={o}
                                    onChange={(e) => setAt(i, e.currentTarget.value)}
                                    onBlur={commitCurrent}
                                    size="xs" radius="md" style={{ flex: 1 }}
                                    placeholder={`${t('campaign.editor.spintaxOption', 'Option')} ${i + 1}`}
                                />
                                <ActionIcon variant="subtle" color="red" size="sm" onClick={() => removeAt(i)} disabled={opts.length <= 1}>
                                    <IconX size={14} />
                                </ActionIcon>
                            </Group>
                        ))}
                        <Group justify="space-between" mt={2}>
                            <Button variant="subtle" size="xs" leftSection={<IconPlus size={14} />} onClick={add}>
                                {t('campaign.editor.spintaxAdd', 'Add option')}
                            </Button>
                            <Button variant="subtle" color="red" size="xs" leftSection={<IconTrash size={14} />} onClick={() => deleteNode()}>
                                {t('campaign.editor.spintaxRemove', 'Remove')}
                            </Button>
                        </Group>
                    </Stack>
                </Popover.Dropdown>
            </Popover>
        </NodeViewWrapper>
    );
}
