/**
 * Date formatting for the CRM list tables: short month/day + time, with the year
 * shown only when it isn't the current year (so a row from a prior year is
 * distinguishable from a recent one). Uses the app locale (i18n.language) rather
 * than the browser locale so TR/EN users see consistent formatting.
 */
export function formatListDate(dateStr: string, locale: string): string {
    const date = new Date(dateStr);
    const isCurrentYear = date.getFullYear() === new Date().getFullYear();
    return date.toLocaleDateString(locale, {
        year: isCurrentYear ? undefined : 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}
