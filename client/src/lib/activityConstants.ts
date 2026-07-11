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
    IconPhoneCall,
    IconMailDown,
    IconMailUp,
} from '@tabler/icons-react';
import { createElement } from 'react';
import type { ActivityType } from '../types/activity';
import type { TimelineChannel } from '../types/timeline';

export const ACTIVITY_ICONS: Record<ActivityType, React.ReactNode> = {
    not: createElement(IconNotes, { size: 16 }),
    meeting: createElement(IconCalendar, { size: 16 }),
    follow_up: createElement(IconClock, { size: 16 }),
    sonlandirma_raporu: createElement(IconFileReport, { size: 16 }),
    status_change: createElement(IconArrowsExchange, { size: 16 }),
    campaign_email: createElement(IconMailForward, { size: 16 }),
    call: createElement(IconPhoneCall, { size: 16 }),
};

export const ACTIVITY_COLORS: Record<ActivityType, string> = {
    not: 'blue',
    meeting: 'violet',
    follow_up: 'orange',
    sonlandirma_raporu: 'green',
    status_change: 'gray',
    campaign_email: 'indigo',
    call: 'cyan',
};

export const OUTCOME_COLORS: Record<string, string> = {
    won: 'green',
    lost: 'red',
    on_hold: 'gray',
    cancelled: 'dark',
};

// Unified-timeline channel visuals. Activity channels reuse the ACTIVITY maps;
// the two email directions add their own icon/color so inbound vs. outbound
// contact reads at a glance.
export const CHANNEL_ICONS: Record<TimelineChannel, React.ReactNode> = {
    not: ACTIVITY_ICONS.not,
    meeting: ACTIVITY_ICONS.meeting,
    follow_up: ACTIVITY_ICONS.follow_up,
    call: ACTIVITY_ICONS.call,
    campaign_email: ACTIVITY_ICONS.campaign_email,
    sonlandirma_raporu: ACTIVITY_ICONS.sonlandirma_raporu,
    status_change: ACTIVITY_ICONS.status_change,
    email_in: createElement(IconMailDown, { size: 16 }),
    email_out: createElement(IconMailUp, { size: 16 }),
};

export const CHANNEL_COLORS: Record<TimelineChannel, string> = {
    not: ACTIVITY_COLORS.not,
    meeting: ACTIVITY_COLORS.meeting,
    follow_up: ACTIVITY_COLORS.follow_up,
    call: ACTIVITY_COLORS.call,
    campaign_email: ACTIVITY_COLORS.campaign_email,
    sonlandirma_raporu: ACTIVITY_COLORS.sonlandirma_raporu,
    status_change: ACTIVITY_COLORS.status_change,
    email_in: 'teal',
    email_out: 'grape',
};

export const OUTCOME_ICONS: Record<string, React.ReactNode> = {
    won: createElement(IconTrophy, { size: 12 }),
    lost: createElement(IconXboxX, { size: 12 }),
    on_hold: createElement(IconClock, { size: 12 }),
    cancelled: createElement(IconBan, { size: 12 }),
};
