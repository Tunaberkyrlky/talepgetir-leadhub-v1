import {
    IconNotes,
    IconCalendar,
    IconClock,
    IconFileReport,
    IconArrowsExchange,
    IconTrophy,
    IconXboxX,
    IconBan,
    IconMailForward,
} from '@tabler/icons-react';
import { createElement } from 'react';
import type { ActivityType } from '../types/activity';

export const ACTIVITY_ICONS: Record<ActivityType, React.ReactNode> = {
    not: createElement(IconNotes, { size: 16 }),
    meeting: createElement(IconCalendar, { size: 16 }),
    follow_up: createElement(IconClock, { size: 16 }),
    sonlandirma_raporu: createElement(IconFileReport, { size: 16 }),
    status_change: createElement(IconArrowsExchange, { size: 16 }),
    campaign_email: createElement(IconMailForward, { size: 16 }),
};

export const ACTIVITY_COLORS: Record<ActivityType, string> = {
    not: 'blue',
    meeting: 'violet',
    follow_up: 'orange',
    sonlandirma_raporu: 'green',
    status_change: 'gray',
    campaign_email: 'indigo',
};

export const OUTCOME_COLORS: Record<string, string> = {
    won: 'green',
    lost: 'red',
    on_hold: 'gray',
    cancelled: 'dark',
};

export const OUTCOME_ICONS: Record<string, React.ReactNode> = {
    won: createElement(IconTrophy, { size: 12 }),
    lost: createElement(IconXboxX, { size: 12 }),
    on_hold: createElement(IconClock, { size: 12 }),
    cancelled: createElement(IconBan, { size: 12 }),
};
