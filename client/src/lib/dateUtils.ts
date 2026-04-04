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
