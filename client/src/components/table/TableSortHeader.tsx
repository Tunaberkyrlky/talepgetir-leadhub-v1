import { Text, UnstyledButton } from '@mantine/core';
import { IconChevronUp, IconChevronDown, IconSelector } from '@tabler/icons-react';

interface TableSortHeaderProps<S extends string> {
    label: string;
    /** When set, the header is sortable and clicking calls onSort(sortKey). */
    sortKey?: S;
    sortBy: S;
    sortOrder: 'asc' | 'desc';
    onSort: (key: S) => void;
}

/**
 * Column header cell content shared by the CRM list tables. Renders a sortable
 * button (with the asc/desc/idle indicator) when sortKey is given, otherwise a
 * plain uppercase label. Module-scoped so it stays a stable component type across
 * parent re-renders (the previous inline version remounted on every render).
 */
export function TableSortHeader<S extends string>({
    label, sortKey, sortBy, sortOrder, onSort,
}: TableSortHeaderProps<S>) {
    if (!sortKey) {
        return (
            <Text size="xs" fw={600} tt="uppercase" c="white" style={{ letterSpacing: '0.5px' }}>
                {label}
            </Text>
        );
    }

    const isSorted = sortBy === sortKey;
    const Icon = isSorted ? (sortOrder === 'asc' ? IconChevronUp : IconChevronDown) : IconSelector;

    return (
        <UnstyledButton onClick={() => onSort(sortKey)} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Text size="xs" fw={600} tt="uppercase" style={{ letterSpacing: '0.5px', color: 'white' }}>
                {label}
            </Text>
            <Icon size={14} color={isSorted ? '#a78bfa' : 'rgba(255,255,255,0.5)'} />
        </UnstyledButton>
    );
}
