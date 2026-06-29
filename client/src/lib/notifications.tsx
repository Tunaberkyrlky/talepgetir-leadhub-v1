import { notifications } from '@mantine/notifications';
import { AxiosError } from 'axios';
import i18n from '../i18n';
import { openFeedbackForLastError } from './lastError';

function t(key: string): string {
    return i18n.t(key);
}

/** Show a green success notification */
export function showSuccess(message: string) {
    notifications.show({ message, color: 'green' });
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

/** Shape the send endpoints return when some selected attachments didn't make it. */
export interface AttachmentSendWarning {
    failed?: string[];      // files the server could not attach (names)
    missingCount?: number;  // selected templates that no longer exist
}

/**
 * After a SUCCESSFUL send, surface a yellow warning when some selected attachments
 * were left off the message — either the file couldn't be loaded (`failed`) or the
 * template was deleted (`missingCount`). The mail still went out, so we don't show a
 * red error; we tell the user exactly what's missing so they can resend it.
 * Returns true when a warning was shown, so the caller can skip the success toast.
 */
export function notifyAttachmentWarning(data: unknown): boolean {
    const w = (data as { attachmentWarning?: AttachmentSendWarning } | null | undefined)?.attachmentWarning;
    if (!w) return false;
    let message: string;
    if (w.failed?.length) {
        message = i18n.t('emailReplies.attachments.partialFail', { names: w.failed.join(', ') });
    } else if (w.missingCount && w.missingCount > 0) {
        message = i18n.t('emailReplies.attachments.partialMissing', { count: w.missingCount });
    } else {
        return false;
    }
    notifications.show({ message, color: 'yellow', autoClose: 10000, withCloseButton: true });
    return true;
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
