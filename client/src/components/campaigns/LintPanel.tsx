import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Paper, Group, Button, Stack, Text, ThemeIcon, Box } from '@mantine/core';
import {
    IconShieldCheck, IconShieldSearch, IconAlertTriangle, IconInfoCircle, IconRefresh,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';

// Sunucu yalnızca KOD döndürür; kullanıcıya görünen metin burada (i18n) üretilir.
interface LintFinding {
    code: string;
    severity: 'warn' | 'info';
    params?: Record<string, unknown>;
}

interface Props {
    subject: string;
    bodyHtml: string;
    hasAttachment?: boolean;
}

// Denetimin "hangi içeriğe" ait olduğunu bilmek için basit imza (bayat sonuç tespiti).
const signature = (subject: string, bodyHtml: string, hasAttachment: boolean) =>
    `${subject} ${bodyHtml} ${hasAttachment ? '1' : '0'}`;

/**
 * Gönderim-öncesi içerik "spam sinyali" paneli — TAVSİYE amaçlı, HİÇBİR ŞEYİ ENGELLEMEZ.
 * Kullanıcı "Denetle" düğmesine bastığında sunucudaki saf lint fonksiyonuna sorar.
 */
export default function LintPanel({ subject, bodyHtml, hasAttachment = false }: Props) {
    const { t } = useTranslation();
    const [findings, setFindings] = useState<LintFinding[] | null>(null);
    const [checkedSig, setCheckedSig] = useState<string | null>(null);

    const currentSig = signature(subject, bodyHtml, hasAttachment);
    const stale = findings !== null && checkedSig !== null && checkedSig !== currentSig;

    const lintMut = useMutation<LintFinding[], unknown, void>({
        mutationFn: async () => {
            const r = await api.post('/campaigns/lint', {
                subject,
                body_html: bodyHtml,
                has_attachment: hasAttachment,
            });
            return (r.data?.findings || []) as LintFinding[];
        },
        onSuccess: (data) => {
            setFindings(data);
            setCheckedSig(currentSig);
        },
    });

    // Kod + interpolasyon değerlerinden yerelleştirilmiş metni üretir. Diziler
    // (domains/words) i18n'e verilmeden önce virgülle birleştirilir.
    const renderText = (f: LintFinding): string => {
        const p = f.params || {};
        const interp: Record<string, unknown> = { ...p };
        if (Array.isArray(p.domains)) interp.domains = (p.domains as string[]).join(', ');
        if (Array.isArray(p.words)) interp.words = (p.words as string[]).join(', ');
        return t(`campaign.editor.lint.codes.${f.code}`, interp) as string;
    };

    const items = useMemo(() => findings || [], [findings]);
    const empty = findings !== null && items.length === 0 && !stale;

    return (
        <Paper withBorder radius="md" p="sm" bg="var(--mantine-color-gray-0)">
            <Group justify="space-between" align="center" wrap="nowrap">
                <Group gap={6} wrap="nowrap">
                    <IconShieldSearch size={15} color="var(--mantine-color-indigo-6)" />
                    <Text size="xs" fw={600}>{t('campaign.editor.lint.title', 'Deliverability check')}</Text>
                </Group>
                <Button
                    size="compact-xs"
                    variant="light"
                    color="indigo"
                    leftSection={findings === null ? <IconShieldSearch size={13} /> : <IconRefresh size={13} />}
                    loading={lintMut.isPending}
                    onClick={() => lintMut.mutate()}
                >
                    {findings === null
                        ? t('campaign.editor.lint.check', 'Check')
                        : t('campaign.editor.lint.recheck', 'Re-check')}
                </Button>
            </Group>

            <Text size="xs" c="dimmed" mt={6}>
                {t('campaign.editor.lint.description', 'Advisory only — these signals never block saving or sending.')}
            </Text>

            {lintMut.isError && (
                <Text size="xs" c="red" mt="xs">{t('campaign.editor.lint.error', 'Could not run the check. Try again.')}</Text>
            )}

            {stale && (
                <Group gap={6} mt="xs" wrap="nowrap">
                    <IconInfoCircle size={13} color="var(--mantine-color-gray-6)" />
                    <Text size="xs" c="dimmed">{t('campaign.editor.lint.stale', 'Content changed — re-check for fresh results.')}</Text>
                </Group>
            )}

            {empty && (
                <Group gap={6} mt="xs" wrap="nowrap">
                    <ThemeIcon size="sm" radius="xl" variant="light" color="teal"><IconShieldCheck size={13} /></ThemeIcon>
                    <Text size="xs" c="teal.8">{t('campaign.editor.lint.clean', 'No spam signals found.')}</Text>
                </Group>
            )}

            {items.length > 0 && (
                <Stack gap={6} mt="xs">
                    {items.map((f, i) => {
                        const isWarn = f.severity === 'warn';
                        return (
                            <Group key={`${f.code}-${i}`} gap={8} align="flex-start" wrap="nowrap">
                                <ThemeIcon size="sm" radius="xl" variant="light" color={isWarn ? 'orange' : 'blue'}>
                                    {isWarn ? <IconAlertTriangle size={13} /> : <IconInfoCircle size={13} />}
                                </ThemeIcon>
                                <Box>
                                    <Text size="xs" c={isWarn ? 'orange.9' : 'blue.9'}>{renderText(f)}</Text>
                                </Box>
                            </Group>
                        );
                    })}
                </Stack>
            )}
        </Paper>
    );
}
