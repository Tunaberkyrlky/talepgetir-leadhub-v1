import type { DomainCheckStatus } from '../types/campaign';

const STATUS_COLOR: Record<DomainCheckStatus, string> = {
    pass: 'green',
    warn: 'yellow',
    fail: 'red',
    unknown: 'gray',
};

export function statusColor(status: DomainCheckStatus): string {
    return STATUS_COLOR[status] ?? 'gray';
}
