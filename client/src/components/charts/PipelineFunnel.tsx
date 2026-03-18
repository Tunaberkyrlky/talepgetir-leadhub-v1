import { Paper, Text } from '@mantine/core';
import {
    BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';
import { useTranslation } from 'react-i18next';
import { stageColors } from '../../lib/stages';

const MANTINE_COLORS: Record<string, string> = {
    blue: '#339af0',
    cyan: '#22b8cf',
    indigo: '#5c7cfa',
    yellow: '#fcc419',
    orange: '#ff922b',
    grape: '#cc5de8',
    green: '#51cf66',
    red: '#ff6b6b',
    gray: '#868e96',
};

interface FunnelItem {
    stage: string;
    count: number;
}

interface PipelineFunnelProps {
    data: FunnelItem[];
    title: string;
}

export default function PipelineFunnel({ data, title }: PipelineFunnelProps) {
    const { t } = useTranslation();

    const chartData = data.map((item) => ({
        ...item,
        label: t(`stages.${item.stage}`),
    }));

    return (
        <Paper shadow="sm" radius="lg" p="lg" withBorder>
            <Text size="sm" fw={700} mb="md" tt="uppercase" c="dimmed" style={{ letterSpacing: '0.5px' }}>
                {title}
            </Text>
            <ResponsiveContainer width="100%" height={300}>
                <BarChart data={chartData} layout="vertical" margin={{ left: 20, right: 20 }}>
                    <XAxis type="number" allowDecimals={false} />
                    <YAxis type="category" dataKey="label" width={120} tick={{ fontSize: 12 }} />
                    <Tooltip
                        formatter={(value) => [value as number, t('dashboard.companies', 'Companies')]}
                        contentStyle={{ borderRadius: 8, border: '1px solid #e9ecef' }}
                    />
                    <Bar dataKey="count" radius={[0, 6, 6, 0]} maxBarSize={32}>
                        {chartData.map((entry) => (
                            <Cell
                                key={entry.stage}
                                fill={MANTINE_COLORS[stageColors[entry.stage as keyof typeof stageColors]] || '#868e96'}
                            />
                        ))}
                    </Bar>
                </BarChart>
            </ResponsiveContainer>
        </Paper>
    );
}
