import { Paper, Text, Group, Badge, Stack } from '@mantine/core';
import { IconUsers } from '@tabler/icons-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';

export interface PipelineCompany {
    id: string;
    name: string;
    industry: string | null;
    stage: string;
    next_step: string | null;
    deal_summary: string | null;
    updated_at: string;
    stage_changed_at: string | null;
    contact_count: number;
}

interface PipelineCardProps {
    company: PipelineCompany;
    isDragEnabled: boolean;
}

function getDaysInStage(stageChangedAt: string | null): number | null {
    if (!stageChangedAt) return null;
    const diff = Date.now() - new Date(stageChangedAt).getTime();
    return Math.floor(diff / (1000 * 60 * 60 * 24));
}

export default function PipelineCard({ company, isDragEnabled }: PipelineCardProps) {
    const { t } = useTranslation();
    const navigate = useNavigate();

    const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
        id: company.id,
        data: { company },
        disabled: !isDragEnabled,
    });

    const style = {
        transform: CSS.Translate.toString(transform),
        opacity: isDragging ? 0.5 : 1,
        cursor: isDragEnabled ? 'grab' : 'pointer',
    };

    const daysInStage = getDaysInStage(company.stage_changed_at);

    return (
        <Paper
            ref={setNodeRef}
            style={style}
            {...(isDragEnabled ? { ...listeners, ...attributes } : {})}
            shadow="xs"
            radius="md"
            p="sm"
            withBorder
            onClick={() => {
                if (!isDragging) navigate(`/companies/${company.id}`);
            }}
            styles={{
                root: {
                    transition: 'box-shadow 150ms ease',
                    '&:hover': { boxShadow: 'var(--mantine-shadow-md)' },
                    touchAction: isDragEnabled ? 'none' : 'auto',
                },
            }}
        >
            <Stack gap={6}>
                <Group justify="space-between" wrap="nowrap" gap={4}>
                    <Text size="sm" fw={600} lineClamp={1} style={{ flex: 1 }}>
                        {company.name}
                    </Text>
                    <Badge size="xs" variant="light" color={company.contact_count > 0 ? 'violet' : 'gray'} leftSection={<IconUsers size={10} />}>
                        {company.contact_count ?? 0}
                    </Badge>
                </Group>

                {company.industry && (
                    <Text size="xs" c="dimmed" lineClamp={1}>
                        {company.industry}
                    </Text>
                )}

                {company.next_step && (
                    <Text size="xs" lineClamp={2} c="dark.3">
                        {company.next_step}
                    </Text>
                )}

                <Group justify="space-between" gap={4}>
                    {daysInStage !== null && (
                        <Badge
                            size="xs"
                            variant="light"
                            color={daysInStage > 14 ? 'red' : daysInStage > 7 ? 'orange' : 'gray'}
                        >
                            {daysInStage}{t('pipeline.days', 'd')}
                        </Badge>
                    )}
                    {company.deal_summary && (
                        <Text size="xs" c="dimmed" lineClamp={1} style={{ flex: 1, textAlign: 'right' }}>
                            {company.deal_summary}
                        </Text>
                    )}
                </Group>
            </Stack>
        </Paper>
    );
}
