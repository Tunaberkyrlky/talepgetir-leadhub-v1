import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';

dayjs.extend(isoWeek);

export type DatePeriod = 'day' | 'week' | 'month';

export function getDateRange(period: DatePeriod, anchor?: Date): { dateFrom: string; dateTo: string } {
    const base = anchor ? dayjs(anchor) : dayjs();
    let start: dayjs.Dayjs;
    let end: dayjs.Dayjs;

    switch (period) {
        case 'day':
            start = base.startOf('day');
            end = base.endOf('day');
            break;
        case 'week':
            start = base.startOf('isoWeek');
            end = base.endOf('isoWeek');
            break;
        case 'month':
            start = base.startOf('month');
            end = base.endOf('month');
            break;
    }

    return {
        dateFrom: start.toISOString(),
        dateTo: end.toISOString(),
    };
}

export function shiftPeriod(period: DatePeriod, anchor: Date, direction: 1 | -1): Date {
    const base = dayjs(anchor);
    switch (period) {
        case 'day': return base.add(direction, 'day').toDate();
        case 'week': return base.add(direction * 7, 'day').toDate();
        case 'month': return base.add(direction, 'month').toDate();
    }
}

export function formatPeriodLabel(period: DatePeriod, anchor: Date, locale: string): string {
    const base = dayjs(anchor);
    if (period === 'day') {
        return base.toDate().toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' });
    }
    if (period === 'week') {
        const start = base.startOf('isoWeek').toDate();
        const end = base.endOf('isoWeek').toDate();
        return `${start.toLocaleDateString(locale, { day: 'numeric', month: 'short' })} – ${end.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })}`;
    }
    return base.toDate().toLocaleDateString(locale, { month: 'long', year: 'numeric' });
}

export function getCustomDateRange(from: Date | string, to: Date | string): { dateFrom: string; dateTo: string } {
    return {
        dateFrom: dayjs(from).startOf('day').toISOString(),
        dateTo: dayjs(to).endOf('day').toISOString(),
    };
}

// ─── Agenda View Helpers ─────────────────────────────────────────────────────

export type Urgency = 'overdue' | 'urgent' | 'soon' | 'ok';

export function getUrgency(occurredAt: string): Urgency {
    const hours = (new Date(occurredAt).getTime() - Date.now()) / 3600000;
    if (hours < 0) return 'overdue';
    if (hours < 24) return 'urgent';
    if (hours < 72) return 'soon';
    return 'ok';
}

export const URGENCY_COLORS: Record<Urgency, string> = {
    overdue: 'red',
    urgent: 'red',
    soon: 'orange',
    ok: 'green',
};

export function formatCountdown(occurredAt: string, locale: string): string {
    const diff = new Date(occurredAt).getTime() - Date.now();
    const hours = diff / 3600000;
    const isTr = locale.startsWith('tr');

    if (hours < -24) {
        const days = Math.abs(Math.ceil(hours / 24));
        return isTr ? `${days} gün geçti` : `${days}d overdue`;
    }
    if (hours < 0) {
        const h = Math.abs(Math.round(hours));
        return isTr ? `${h} saat geçti` : `${h}h overdue`;
    }
    if (hours < 1) {
        const mins = Math.max(1, Math.round(diff / 60000));
        return isTr ? `${mins} dk` : `${mins}m`;
    }
    if (hours < 24) {
        return isTr ? `${Math.round(hours)} saat` : `${Math.round(hours)}h`;
    }
    const days = Math.ceil(hours / 24);
    return isTr ? `${days} gün` : `${days}d`;
}

export function toLocalDateStr(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

export function formatAgendaDayLabel(
    dateKey: string,
    todayStr: string,
    locale: string,
    t: (key: string, fallback?: string) => string,
): string {
    const d = new Date(dateKey + 'T00:00:00');
    const diffDays = Math.round((d.getTime() - new Date(todayStr + 'T00:00:00').getTime()) / 86400000);

    if (diffDays === 0) return t('activities.today', 'Bugün');
    if (diffDays === 1) return t('activities.tomorrow', 'Yarın');
    if (diffDays === -1) return t('activities.yesterday', 'Dün');
    // Day name: Perşembe, Cuma, ...
    const dayName = d.toLocaleDateString(locale, { weekday: 'long' });
    return dayName.charAt(0).toUpperCase() + dayName.slice(1);
}

export function getDateUrgencyColor(dateKey: string, todayStr: string): string {
    if (dateKey < todayStr) return 'red';
    if (dateKey === todayStr) return 'blue';
    const diff = (new Date(dateKey + 'T00:00:00').getTime() - new Date(todayStr + 'T00:00:00').getTime()) / 86400000;
    if (diff <= 1) return 'orange';
    if (diff <= 3) return 'yellow';
    return 'green';
}
