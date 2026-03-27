import axios from 'axios';
import { createLogger } from './logger';

const log = createLogger('api');

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

const api = axios.create({
    baseURL: API_URL,
    headers: {
        'Content-Type': 'application/json',
    },
    withCredentials: true, // Send httpOnly cookies with every request
    timeout: 60000,        // 60 second timeout
});

// Request interceptor: attach active tenant header
api.interceptors.request.use((config) => {
    const activeTenantId = localStorage.getItem('activeTenantId');
    if (activeTenantId && activeTenantId !== 'null') {
        config.headers['X-Tenant-Id'] = activeTenantId;
    }
    return config;
});

// Mutex for token refresh to prevent race conditions
let refreshPromise: Promise<void> | null = null;

// Response interceptor: handle 401 (expired token)
api.interceptors.response.use(
    (response) => response,
    async (error) => {
        const status = error.response?.status;
        const url = error.config?.url;

        // Skip token refresh for auth-check endpoints — they are expected to fail when not logged in
        const skipRefreshUrls = ['/auth/me', '/auth/refresh', '/auth/login'];
        const shouldSkipRefresh = skipRefreshUrls.some((u) => url?.includes(u));

        if (status === 401 && !error.config._retry && !shouldSkipRefresh) {
            error.config._retry = true;

            // If already refreshing, wait for it
            if (refreshPromise) {
                try {
                    await refreshPromise;
                    return api(error.config);
                } catch {
                    return Promise.reject(error);
                }
            }

            // Start a new refresh (cookies are sent automatically)
            refreshPromise = axios.post(`${API_URL}/auth/refresh`, {}, { withCredentials: true })
                .then(() => {
                    // Cookies are set by server automatically
                })
                .catch((refreshError) => {
                    log.warn('Token refresh failed, dispatching session expiry event', { url });
                    localStorage.removeItem('activeTenantId');
                    // Dispatch a custom event so AuthContext can handle navigation via React Router
                    // (avoids full-page reload that would destroy React state and unsaved data)
                    window.dispatchEvent(new CustomEvent('auth:sessionExpired'));
                    throw refreshError;
                })
                .finally(() => {
                    refreshPromise = null;
                });

            try {
                await refreshPromise;
                return api(error.config);
            } catch {
                return Promise.reject(error);
            }
        } else if (status !== 401) {
            log.error('API error', { status, url, message: error.message });
        }
        return Promise.reject(error);
    }
);

export default api;
