import type { ReactNode } from 'react';
import { Select, Avatar, Group, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { useMembers } from '../lib/useMembers';

interface OwnerSelectProps {
    // The owner UUID, or null for unassigned. The UUID is NEVER shown to the user —
    // options are labelled by member name only.
    value: string | null;
    onChange: (value: string | null) => void;
    label?: string;
    placeholder?: string;
    // When true, clearing the field means "unassigned".
    clearable?: boolean;
    disabled?: boolean;
    size?: string;
    radius?: string;
    error?: ReactNode;
}

/** Two-letter initials for the avatar (first + last word, or first two letters). */
function initials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Tenant member picker. Sourced from useMembers(); shows names (with an initials avatar),
 * never a raw UUID. Used by the company form, the company detail header inline edit, and the
 * task form / reassign flow.
 */
export default function OwnerSelect({
    value,
    onChange,
    label,
    placeholder,
    clearable,
    disabled,
    size,
    radius = 'md',
    error,
}: OwnerSelectProps) {
    const { t } = useTranslation();
    const { data, isLoading, isError } = useMembers();
    const members = data?.members ?? [];
    const options = members.map((m) => ({ value: m.id, label: m.name || m.email }));

    return (
        <Select
            label={label}
            placeholder={isLoading ? t('common.loading') : (placeholder ?? t('owner.select'))}
            data={options}
            value={value}
            onChange={onChange}
            searchable
            clearable={clearable}
            disabled={disabled || isLoading}
            size={size}
            radius={radius}
            error={error ?? (isError ? t('owner.loadError') : undefined)}
            nothingFoundMessage={t('owner.noMembers')}
            renderOption={({ option }) => (
                <Group gap="xs" wrap="nowrap">
                    <Avatar size={22} radius="xl" color="violet">
                        {initials(option.label)}
                    </Avatar>
                    <Text size="sm">{option.label}</Text>
                </Group>
            )}
        />
    );
}
