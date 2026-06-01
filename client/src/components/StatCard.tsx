import { Paper, Group, Text, ThemeIcon, Stack, Tooltip } from '@mantine/core';
import type { ReactNode } from 'react';

interface StatCardProps {
    title: string;
    value: string | number;
    icon: ReactNode;
    color: string;
    description?: string;
    /** When provided, the card becomes clickable (pointer + hover) */
    onClick?: () => void;
    /** Visually marks the card as currently active (used when card doubles as a filter) */
    selected?: boolean;
    /** Tighter spacing + smaller text. Use when the card is one of many on a dense page. */
    compact?: boolean;
}

export default function StatCard({ title, value, icon, color, description, onClick, selected, compact }: StatCardProps) {
    const interactive = typeof onClick === 'function';
    return (
        <Tooltip label={description} disabled={!description} withArrow position="bottom" multiline maw={260} styles={{ tooltip: { fontSize: 11 } }}>
            <div
                style={{ height: '100%', cursor: interactive ? 'pointer' : 'default' }}
                onClick={onClick}
                role={interactive ? 'button' : undefined}
                tabIndex={interactive ? 0 : undefined}
                onKeyDown={interactive ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick!(); } } : undefined}
            >
                <Paper
                    shadow={selected ? 'md' : 'sm'}
                    radius={compact ? 'md' : 'lg'}
                    p={compact ? 'sm' : 'lg'}
                    withBorder
                    h="100%"
                    style={
                        selected
                            ? { borderColor: `var(--mantine-color-${color}-5)`, borderWidth: 2, background: `var(--mantine-color-${color}-0)` }
                            : undefined
                    }
                >
                    <Group justify="space-between" align="center" wrap="nowrap" gap="xs">
                        <Stack gap={compact ? 0 : 4}>
                            <Text
                                size={compact ? '10px' : 'xs'}
                                tt="uppercase"
                                fw={700}
                                c="dimmed"
                                style={{ letterSpacing: '0.5px' }}
                            >
                                {title}
                            </Text>
                            <Text
                                fw={800}
                                style={{ fontSize: compact ? '1.4rem' : '2rem', lineHeight: 1.1 }}
                            >
                                {value}
                            </Text>
                        </Stack>
                        <ThemeIcon
                            color={color}
                            variant={selected ? 'filled' : 'light'}
                            size={compact ? 'md' : 'xl'}
                            radius="md"
                        >
                            {icon}
                        </ThemeIcon>
                    </Group>
                </Paper>
            </div>
        </Tooltip>
    );
}
