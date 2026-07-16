import { notifications } from '@mantine/notifications';
import { AxiosError } from 'axios';
import i18n from '../i18n';
import { openFeedbackForLastError } from './lastError';

function t(key: string): string {
    return i18n.t(key);
}

/** Show a green success notification.
 *  Pass `options.id` for actions that can legitimately repeat in quick succession (e.g.
 *  approving several cards in a row) — Mantine's notifications store no-ops a `show()` call
 *  whose id already has a notification on screen, so a stable id replaces re-stacking with a
 *  single toast instead of piling up N identical ones. */
export function showSuccess(message: string, options?: { id?: string }) {
    notifications.show({ message, color: 'green', ...options });
}

/** Show a blue info notification */
export function showInfo(message: string) {
    notifications.show({ message, color: 'blue' });
}

export function showWarning(message: string) {
    notifications.show({ message, color: 'yellow' });
}

/** Show a red error notification with a user-friendly message */
export function showError(message: string) {
    notifications.show({ message, color: 'red' });
}

/**
 * Extract a user-friendly error message from an Axios error or unknown error.
 * Maps HTTP status codes to translated, non-technical messages.
 */
export function getErrorMessage(error: unknown, fallback?: string): string {
    const defaultMsg = fallback || t('errors.generic');

    if (error instanceof AxiosError) {
        // Network / timeout errors (no response from server)
        if (!error.response) {
            if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
                return t('errors.timeout');
            }
            return t('errors.network');
        }

        const status = error.response.status;
        const serverMessage = error.response.data?.error;
        const code = error.response.data?.code as string | undefined;

        // Coded app errors get a specific translated message regardless of status.
        // Unknown codes fall through to the status-based handling below (unchanged).
        switch (code) {
            case 'closing_report_required':
                return i18n.t('stages.closingReportRequired', 'A closing report is required to move this company to the selected stage.');
            case 'reopen_reason_required':
                return i18n.t('stages.reopenReasonRequired', 'A reason is required to reopen a closed company.');
            case 'stage_conflict':
                return i18n.t('stages.conflictRetry', 'The stage changed while you were editing. Please try again.');
        }

        switch (status) {
            case 400:
            case 422: {
                // Validation — show the server's specific message if available
                const details: string[] | undefined = error.response.data?.details;
                if (details?.length) return `${serverMessage || t('errors.validationFailed')}: ${details.join(', ')}`;
                return serverMessage || t('errors.validationFailed');
            }
            case 401:
                // Auth errors are handled by the interceptor, but just in case
                return t('errors.unauthorized');
            case 403:
                // Show server message when available (e.g. "This feature requires a higher plan")
                return serverMessage || t('errors.forbidden');
            case 404:
                // Show server message when available (e.g. "Company not found")
                return serverMessage || t('errors.notFound');
            case 409:
                return serverMessage || t('errors.conflict');
            default:
                // Never expose raw server error details for 5xx errors
                if (status >= 500) return defaultMsg;
                return serverMessage || defaultMsg;
        }
    }

    if (error instanceof Error) {
        return error.message || defaultMsg;
    }

    return defaultMsg;
}

export interface AttachmentSendWarning {
    failed?: string[];
    missingCount?: number;
}

/** Show a warning when the message was sent but one or more files were omitted. */
export function notifyAttachmentWarning(data: unknown): boolean {
    const warning = (data as { attachmentWarning?: AttachmentSendWarning } | null | undefined)?.attachmentWarning;
    if (!warning) return false;

    const messages: string[] = [];
    if (warning.failed?.length) {
        messages.push(i18n.t('emailReplies.attachments.partialFail', { names: warning.failed.join(', ') }));
    }
    if (warning.missingCount && warning.missingCount > 0) {
        messages.push(i18n.t('emailReplies.attachments.partialMissing', { count: warning.missingCount }));
    }
    if (!messages.length) return false;

    notifications.show({ message: messages.join(' '), color: 'yellow', autoClose: 10000, withCloseButton: true });
    return true;
}

export interface MailboxNotice {
    previous: string;
    current: string;
}

export function notifyMailboxNotice(data: unknown): void {
    const notice = (data as { mailboxNotice?: MailboxNotice } | null | undefined)?.mailboxNotice;
    if (!notice?.current) return;
    notifications.show({
        message: i18n.t('emailReplies.mailbox.substituted', {
            previous: notice.previous,
            current: notice.current,
        }),
        color: 'blue',
        autoClose: 12000,
        withCloseButton: true,
    });
}

/** Convenience: show an error notification from an Axios/unknown error */
export function showErrorFromApi(error: unknown, fallback?: string) {
    const message = getErrorMessage(error, fallback);

    // For Axios errors with a real response (i.e. the server responded with an error),
    // augment the toast with the request id and a "Report this error" CTA so the user
    // can ship a fully-contextualized bug report in one click.
    if (error instanceof AxiosError && error.response) {
        const requestId = (error.response.headers?.['x-request-id'] as string | undefined) ?? null;
        const time = new Date().toLocaleTimeString('tr-TR');
        const reportLabel = i18n.t('feedback.reportError', 'Hata Bildir');
        const meta = requestId
            ? `${time} · ${i18n.t('errors.requestId', 'İstek No')}: ${requestId.slice(0, 8)}`
            : time;

        notifications.show({
            color: 'red',
            autoClose: 8000,
            withCloseButton: true,
            message: (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div>{message}</div>
                    <div
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            fontSize: 11,
                            opacity: 0.8,
                        }}
                    >
                        <span>{meta}</span>
                        <button
                            type="button"
                            onClick={() => openFeedbackForLastError()}
                            style={{
                                border: 0,
                                background: 'transparent',
                                color: 'inherit',
                                textDecoration: 'underline',
                                cursor: 'pointer',
                                fontSize: 11,
                                padding: 0,
                            }}
                        >
                            {reportLabel}
                        </button>
                    </div>
                </div>
            ),
        });
        return;
    }

    showError(message);
}
