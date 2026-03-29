import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';

dayjs.extend(isoWeek);

export type DatePeriod = 'day' | 'week' | 'month';

export function getDateRange(period: DatePeriod): { dateFrom: string; dateTo: string } {
    const now = dayjs();
    let start: dayjs.Dayjs;

    switch (period) {
        case 'day':
            start = now.startOf('day');
            break;
        case 'week':
            start = now.startOf('isoWeek'); // Monday-start week
            break;
        case 'month':
            start = now.startOf('month');
            break;
    }

    return {
        dateFrom: start.toISOString(),
        dateTo: now.toISOString(),
    };
}

export function getCustomDateRange(from: Date, to: Date): { dateFrom: string; dateTo: string } {
    return {
        dateFrom: dayjs(from).startOf('day').toISOString(),
        dateTo: dayjs(to).endOf('day').toISOString(),
    };
}
