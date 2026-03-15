import { Paper, Group, Text, ThemeIcon, Stack } from '@mantine/core';
import type { ReactNode } from 'react';

interface StatCardProps {
    title: string;
    value: string | number;
    icon: ReactNode;
    color: string;
    description?: string;
}

export default function StatCard({ title, value, icon, color, description }: StatCardProps) {
    return (
        <Paper shadow="sm" radius="lg" p="lg" withBorder>
            <Group justify="space-between" align="flex-start">
                <Stack gap={4}>
                    <Text size="xs" tt="uppercase" fw={700} c="dimmed" style={{ letterSpacing: '0.5px' }}>
                        {title}
                    </Text>
                    <Text size="xl" fw={800} style={{ fontSize: '2rem', lineHeight: 1.1 }}>
                        {value}
                    </Text>
                    {description && (
                        <Text size="xs" c="dimmed">{description}</Text>
                    )}
                </Stack>
                <ThemeIcon color={color} variant="light" size="xl" radius="md">
                    {icon}
                </ThemeIcon>
            </Group>
        </Paper>
    );
}
