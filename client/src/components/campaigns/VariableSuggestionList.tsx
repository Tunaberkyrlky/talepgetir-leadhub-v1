import { forwardRef, useImperativeHandle, useState } from 'react';
import { Paper, Text, Badge, Group, Box } from '@mantine/core';

export interface SuggestionItem {
    key: string;
    label: string;
    insert: string;
    spintax?: boolean;
}

interface Props {
    items: SuggestionItem[];
    command: (item: SuggestionItem) => void;
}

export interface SuggestionListRef {
    onKeyDown: (p: { event: KeyboardEvent }) => boolean;
}

// {{ yazınca açılan değişken/spintax otomatik tamamlama listesi.
const VariableSuggestionList = forwardRef<SuggestionListRef, Props>(({ items, command }, ref) => {
    const [selected, setSelected] = useState(0);
    // Filtre değişince (yeni items dizisi) seçimi başa al — effect yerine render-anı reset.
    const [prevItems, setPrevItems] = useState(items);
    if (items !== prevItems) { setPrevItems(items); setSelected(0); }

    const pick = (i: number) => { const it = items[i]; if (it) command(it); };

    useImperativeHandle(ref, () => ({
        onKeyDown: ({ event }) => {
            if (!items.length) return false;
            if (event.key === 'ArrowUp') { setSelected((s) => (s + items.length - 1) % items.length); return true; }
            if (event.key === 'ArrowDown') { setSelected((s) => (s + 1) % items.length); return true; }
            if (event.key === 'Enter' || event.key === 'Tab') { const it = items[selected]; if (it) command(it); return true; }
            return false;
        },
    }), [items, selected, command]);

    if (!items.length) return null;

    return (
        <Paper shadow="md" radius="md" withBorder p={4} style={{ minWidth: 220, maxHeight: 260, overflowY: 'auto' }}>
            {items.map((it, i) => (
                <Box
                    key={it.key}
                    px={8} py={6}
                    style={{
                        borderRadius: 6, cursor: 'pointer',
                        background: i === selected ? 'var(--mantine-color-violet-0)' : undefined,
                    }}
                    onMouseEnter={() => setSelected(i)}
                    // mousedown + preventDefault: editör focus'unu kaybetmeden seç
                    onMouseDown={(e) => { e.preventDefault(); pick(i); }}
                >
                    <Group justify="space-between" gap="xs" wrap="nowrap">
                        <Text size="sm" fw={500}>{it.label}</Text>
                        <Badge size="xs" variant="light" color={it.spintax ? 'orange' : 'violet'}>{it.insert}</Badge>
                    </Group>
                </Box>
            ))}
        </Paper>
    );
});

VariableSuggestionList.displayName = 'VariableSuggestionList';
export default VariableSuggestionList;
