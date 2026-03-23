import { notifications } from '@mantine/notifications';
import { AxiosError } from 'axios';
import i18n from '../i18n';

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
            case 422:
                // Validation — show the server's specific message if available
                return serverMessage || t('errors.validationFailed');
            case 401:
                // Auth errors are handled by the interceptor, but just in case
                return t('errors.unauthorized');
            case 403:
                return t('errors.forbidden');
            case 404:
                return t('errors.notFound');
            case 409:
                return serverMessage || t('errors.conflict');
            default:
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
    showError(getErrorMessage(error, fallback));
}
