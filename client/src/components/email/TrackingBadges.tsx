import { Badge, Tooltip } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import type { MessageTracking } from '../../types/emailReply';

interface TrackingBadgesProps {
    tracking?: MessageTracking | null;
    locale: string;
}

function formatDate(iso: string, locale: string): string {
    return new Date(iso).toLocaleDateString(locale, {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

/** Open/click indicators for an outbound message (renders nothing until tracked). */
export default function TrackingBadges({ tracking, locale }: TrackingBadgesProps) {
    const { t } = useTranslation();
    if (!tracking) return null;

    const openLabel = [
        t('emailReplies.tracking.openedCount', { n: tracking.open_count }),
        tracking.first_opened_at
            ? t('emailReplies.tracking.firstOpened', { date: formatDate(tracking.first_opened_at, locale) })
            : null,
    ].filter(Boolean).join(' • ');

    return (
        <>
            {tracking.open_count > 0 && (
                <Tooltip label={openLabel} withArrow>
                    <Badge size="xs" variant="light" color="teal" style={{ flexShrink: 0 }}>
                        {t('emailReplies.tracking.opened')}
                    </Badge>
                </Tooltip>
            )}
            {tracking.click_count > 0 && (
                <Tooltip label={t('emailReplies.tracking.clickedCount', { n: tracking.click_count })} withArrow>
                    <Badge size="xs" variant="light" color="orange" style={{ flexShrink: 0 }}>
                        {t('emailReplies.tracking.clicked')}
                    </Badge>
                </Tooltip>
            )}
        </>
    );
}
