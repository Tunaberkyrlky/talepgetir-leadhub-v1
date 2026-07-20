import { useState } from 'react';
import { arrayMove } from '@dnd-kit/sortable';

export interface ColumnDef<K extends string = string> {
    key: K;
    visible: boolean;
}

function loadColumns<K extends string>(storageKey: string, defaults: ColumnDef<K>[]): ColumnDef<K>[] {
    const validKeys = new Set(defaults.map(c => c.key));
    try {
        const stored = localStorage.getItem(storageKey);
        if (stored) {
            const parsed = JSON.parse(stored) as ColumnDef<K>[];
            // Drop unknown keys left over from an older release (a renamed/removed
            // column would otherwise render a blank header/cell), then append any
            // new default columns the stored config doesn't have yet.
            const valid = parsed.filter(c => validKeys.has(c.key));
            const keys = valid.map(c => c.key);
            const missing = defaults.filter(c => !keys.includes(c.key));
            return [...valid, ...missing];
        }
    } catch { /* corrupt storage — fall through to defaults */ }
    return defaults;
}

/**
 * Shared column show/hide/reorder state with localStorage persistence, used by
 * the CRM list pages (Companies, Contacts). Enforces a minimum of one visible
 * column: toggle() returns false (and changes nothing) when hiding the last
 * visible column, so the caller can surface a message.
 */
export function useColumnConfig<K extends string>(storageKey: string, defaults: ColumnDef<K>[]) {
    const [columns, setColumns] = useState<ColumnDef<K>[]>(() => loadColumns(storageKey, defaults));

    const save = (cols: ColumnDef<K>[]) => {
        setColumns(cols);
        try { localStorage.setItem(storageKey, JSON.stringify(cols)); } catch { /* ignore quota errors */ }
    };

    /** Returns false (no-op) when it would hide the last visible column. */
    const toggle = (key: K): boolean => {
        const col = columns.find(c => c.key === key);
        const visibleCount = columns.filter(c => c.visible).length;
        if (col?.visible && visibleCount <= 1) return false;
        save(columns.map(c => c.key === key ? { ...c, visible: !c.visible } : c));
        return true;
    };

    const reorder = (activeId: string, overId: string) => {
        if (activeId === overId) return;
        const oldIndex = columns.findIndex(c => c.key === activeId);
        const newIndex = columns.findIndex(c => c.key === overId);
        if (oldIndex < 0 || newIndex < 0) return;
        save(arrayMove(columns, oldIndex, newIndex));
    };

    const reset = () => save(defaults);

    const visibleColumns = columns.filter(c => c.visible);

    return { columns, visibleColumns, toggle, reorder, reset };
}
