import axios from 'axios';
import { createLogger } from './logger';

const log = createLogger('api');

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

const api = axios.create({
    baseURL: API_URL,
    headers: {
        'Content-Type': 'application/json',
    },
});

// Request interceptor: attach auth token + active tenant
api.interceptors.request.use((config) => {
    const token = localStorage.getItem('token');
    const activeTenantId = localStorage.getItem('activeTenantId');
    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }
    if (activeTenantId && activeTenantId !== 'null') {
        config.headers['X-Tenant-Id'] = activeTenantId;
    }
    return config;
});

// Response interceptor: handle 401 (expired token)
api.interceptors.response.use(
    (response) => response,
    async (error) => {
        const status = error.response?.status;
        const url = error.config?.url;

        if (status === 401) {
            // Try to refresh token
            const refreshToken = localStorage.getItem('refreshToken');
            if (refreshToken && !error.config._retry) {
                error.config._retry = true;
                try {
                    const { data } = await axios.post(`${API_URL}/auth/refresh`, { refreshToken });
                    localStorage.setItem('token', data.token);
                    localStorage.setItem('refreshToken', data.refreshToken);
                    error.config.headers.Authorization = `Bearer ${data.token}`;
                    return api(error.config);
                } catch (refreshError) {
                    log.warn('Token refresh failed, redirecting to login', { url });
                    localStorage.removeItem('token');
                    localStorage.removeItem('refreshToken');
                    localStorage.removeItem('user');
                    window.location.href = '/login';
                }
            }
        } else {
            log.error('API error', { status, url, message: error.message });
        }
        return Promise.reject(error);
    }
);

export default api;
