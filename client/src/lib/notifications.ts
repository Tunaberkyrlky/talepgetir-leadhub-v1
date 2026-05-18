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

/** Convenience: show an error notification from an Axios/unknown error */
export function showErrorFromApi(error: unknown, fallback?: string) {
    const message = getErrorMessage(error, fallback);

    // For Axios errors with a real response (i.e. the server responded with an error),
    // augment the toast with the request id and a "Report this error" CTA so the user
    // can ship a fully-contextualized bug report in one click.
    if (error instanceof AxiosError && error.response) {
        const requestId = (error.response.headers?.['x-request-id'] as string | undefined) ?? null;
        notifications.show({
            color: 'red',
            autoClose: 8000,
            withCloseButton: true,
            message: (() => {
                const time = new Date().toLocaleTimeString('tr-TR');
                const reportLabel = i18n.t('feedback.reportError', 'Hata Bildir');
                const meta = requestId
                    ? `${time} · ${i18n.t('errors.requestId', 'İstek No')}: ${requestId.slice(0, 8)}`
                    : time;
                // We render plain DOM here to avoid pulling JSX into a .ts file. The host
                // page already uses Mantine notifications, so styling stays consistent.
                const container = document.createElement('div');
                container.style.display = 'flex';
                container.style.flexDirection = 'column';
                container.style.gap = '6px';

                const top = document.createElement('div');
                top.textContent = message;
                container.appendChild(top);

                const bottom = document.createElement('div');
                bottom.style.display = 'flex';
                bottom.style.alignItems = 'center';
                bottom.style.justifyContent = 'space-between';
                bottom.style.fontSize = '11px';
                bottom.style.opacity = '0.8';

                const metaSpan = document.createElement('span');
                metaSpan.textContent = meta;
                bottom.appendChild(metaSpan);

                const reportBtn = document.createElement('button');
                reportBtn.type = 'button';
                reportBtn.textContent = reportLabel;
                reportBtn.style.cssText = 'border:0;background:transparent;color:#fff;text-decoration:underline;cursor:pointer;font-size:11px;padding:0;';
                reportBtn.onclick = () => openFeedbackForLastError();
                bottom.appendChild(reportBtn);

                container.appendChild(bottom);
                return container;
            })(),
        });
        return;
    }

    showError(message);
}
