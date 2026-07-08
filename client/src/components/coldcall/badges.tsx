/** Cold Call — ortak rozetler: tarife kategorisi, çağrı durumu, duygu. */
import { Badge, Tooltip } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import type { CallStatus, CountryInfo } from './types';

export function TierBadge({ country }: { country: CountryInfo }) {
    const { t } = useTranslation();
    if (!country.callable) {
        const reason =
            country.blocked_reason === 'sanctioned'
                ? t('coldcall.blockedSanctioned', 'Sanctioned destination')
                : country.blocked_reason === 'provider_unsupported'
                    ? t('coldcall.blockedProvider', 'Not supported by carrier')
                    : t('coldcall.blockedPremium', 'Premium-rate / fraud risk');
        return (
            <Tooltip label={reason} withArrow>
                <Badge color="red" variant="filled">{t('coldcall.notCallable', 'Not callable')}</Badge>
            </Tooltip>
        );
    }
    const colors: Record<number, string> = { 1: 'green', 2: 'yellow', 4: 'orange' };
    const labels: Record<number, string> = {
        1: t('coldcall.tierStandard', 'Standard'),
        2: t('coldcall.tierExpensive', 'Expensive'),
        4: t('coldcall.tierVeryExpensive', 'Very expensive'),
    };
    return (
        <Tooltip label={t('coldcall.multiplierHint', '1 talk minute uses {{m}} quota minutes', { m: country.multiplier })} withArrow>
            <Badge color={colors[country.multiplier] ?? 'gray'} variant="light">
                {labels[country.multiplier] ?? '?'} · {country.multiplier}x
            </Badge>
        </Tooltip>
    );
}

export function CallStatusBadge({ status }: { status: CallStatus }) {
    const { t } = useTranslation();
    const map: Record<CallStatus, { color: string; label: string }> = {
        queued: { color: 'gray', label: t('coldcall.statusQueued', 'Queued') },
        ringing: { color: 'blue', label: t('coldcall.statusRinging', 'Ringing') },
        in_progress: { color: 'teal', label: t('coldcall.statusInProgress', 'In call') },
        completed: { color: 'green', label: t('coldcall.statusCompleted', 'Completed') },
        busy: { color: 'yellow', label: t('coldcall.statusBusy', 'Busy') },
        no_answer: { color: 'orange', label: t('coldcall.statusNoAnswer', 'No answer') },
        failed: { color: 'red', label: t('coldcall.statusFailed', 'Failed') },
        canceled: { color: 'gray', label: t('coldcall.statusCanceled', 'Canceled') },
    };
    const item = map[status] ?? { color: 'gray', label: status };
    return <Badge color={item.color} variant="light">{item.label}</Badge>;
}

export function NumberHealthBadge({ health, answerRate }: { health?: string; answerRate?: number | null }) {
    const { t } = useTranslation();
    if (!health) return null;
    const map: Record<string, { color: string; label: string }> = {
        warming: { color: 'blue', label: t('coldcall.healthWarming', 'Warming up') },
        good: { color: 'green', label: t('coldcall.healthGood', 'Healthy') },
        watch: { color: 'yellow', label: t('coldcall.healthWatch', 'Watch') },
        risk: { color: 'red', label: t('coldcall.healthRisk', 'At risk') },
        insufficient_data: { color: 'gray', label: t('coldcall.healthNoData', 'Not enough data') },
    };
    const item = map[health];
    if (!item) return null;
    const hint =
        health === 'warming'
            ? t('coldcall.healthWarmingHint', 'New number — daily cap ramps up over 14 days to protect reputation')
            : answerRate != null
                ? t('coldcall.healthHint', '7-day answer rate: {{r}}%', { r: Math.round(answerRate * 100) })
                : t('coldcall.healthNoDataHint', 'Fewer than 10 connected attempts in the last 7 days');
    return (
        <Tooltip label={hint} withArrow>
            <Badge color={item.color} variant="light">{item.label}</Badge>
        </Tooltip>
    );
}

export function SentimentBadge({ sentiment }: { sentiment: string | null | undefined }) {
    const { t } = useTranslation();
    if (!sentiment) return null;
    const map: Record<string, { color: string; label: string }> = {
        positive: { color: 'green', label: t('coldcall.sentimentPositive', 'Positive') },
        neutral: { color: 'gray', label: t('coldcall.sentimentNeutral', 'Neutral') },
        negative: { color: 'red', label: t('coldcall.sentimentNegative', 'Negative') },
    };
    const item = map[sentiment];
    if (!item) return null;
    return <Badge color={item.color} variant="dot">{item.label}</Badge>;
}

