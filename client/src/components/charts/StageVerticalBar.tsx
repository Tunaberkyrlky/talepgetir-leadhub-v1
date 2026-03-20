import { useMemo, useState } from 'react';
import { Box, Text, Tooltip, useMantineTheme } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { useStages } from '../../contexts/StagesContext';

interface StageVerticalBarProps {
    data: Record<string, number>;
}

const BAR_MAX_H = 120;
const BAR_MIN_H = 18;

/**
 * Logarithmic scale so that 1 vs 100 doesn't look 1:100.
 * log(1+1)=0.69, log(1+100)=4.62 → ratio ~1:6.7 instead of 1:100.
 */
function scaleHeight(value: number, maxValue: number): number {
    if (maxValue <= 0 || value <= 0) return 0;
    const scaled = Math.log(1 + value) / Math.log(1 + maxValue);
    return BAR_MIN_H + scaled * (BAR_MAX_H - BAR_MIN_H);
}

export default function StageVerticalBar({ data }: StageVerticalBarProps) {
    const { t } = useTranslation();
    const theme = useMantineTheme();
    const { pipelineStageSlugs, terminalStageSlugs, getStageColor } = useStages();
    const [hovered, setHovered] = useState<string | null>(null);

    const { bars, maxCount } = useMemo(() => {
        // Show pipeline stages in order, then terminal
        const order = [...pipelineStageSlugs, ...terminalStageSlugs];
        const bars = order
            .filter((stage) => (data[stage] || 0) > 0)
            .map((stage) => ({
                stage,
                count: data[stage] || 0,
                color: theme.colors[getStageColor(stage) || 'gray'][6],
                isTerminal: terminalStageSlugs.includes(stage),
                isWon: stage === 'won',
            }));

        const maxCount = Math.max(...bars.map((b) => b.count), 1);
        return { bars, maxCount };
    }, [data, theme.colors, pipelineStageSlugs, terminalStageSlugs, getStageColor]);

    if (bars.length === 0) return null;

    return (
        <Box
            style={{
                display: 'flex',
                alignItems: 'flex-end',
                gap: 6,
                overflowX: 'auto',
                paddingBottom: 4,
            }}
        >
            {bars.map(({ stage, count, color, isTerminal, isWon }) => {
                const h = scaleHeight(count, maxCount);
                const active = hovered === stage;
                const dimmed = hovered !== null && !active;

                return (
                    <Tooltip
                        key={stage}
                        label={`${t(`stages.${stage}`)}: ${count}`}
                        withArrow
                        position="top"
                    >
                        <Box
                            onMouseEnter={() => setHovered(stage)}
                            onMouseLeave={() => setHovered(null)}
                            style={{
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                flex: '1 1 0',
                                minWidth: 40,
                                maxWidth: 72,
                                cursor: 'default',
                                opacity: dimmed ? 0.35 : 1,
                                transition: 'opacity 150ms ease',
                            }}
                        >
                            {/* Count label */}
                            <Text
                                size="xs"
                                fw={isWon ? 800 : 700}
                                mb={4}
                                c={isWon ? 'green' : undefined}
                            >
                                {count}
                            </Text>

                            {/* Bar */}
                            <Box
                                style={{
                                    width: '100%',
                                    height: h,
                                    borderRadius: 6,
                                    backgroundColor: color,
                                    transition: 'transform 150ms ease, box-shadow 150ms ease',
                                    transform: active ? 'scaleX(1.12)' : 'scaleX(1)',
                                    boxShadow: isWon
                                        ? `0 0 12px ${color}80`
                                        : active
                                          ? `0 2px 8px ${color}60`
                                          : 'none',
                                    ...(isTerminal && !isWon
                                        ? {
                                              backgroundImage: `repeating-linear-gradient(
                                                  135deg,
                                                  transparent,
                                                  transparent 3px,
                                                  rgba(255,255,255,0.15) 3px,
                                                  rgba(255,255,255,0.15) 6px
                                              )`,
                                          }
                                        : {}),
                                }}
                            />

                            {/* Stage label */}
                            <Text
                                size="10px"
                                c="dimmed"
                                ta="center"
                                mt={6}
                                fw={isWon ? 700 : 500}
                                lineClamp={1}
                                style={{ lineHeight: 1.2 }}
                            >
                                {t(`stages.${stage}`)}
                            </Text>
                        </Box>
                    </Tooltip>
                );
            })}
        </Box>
    );
}
