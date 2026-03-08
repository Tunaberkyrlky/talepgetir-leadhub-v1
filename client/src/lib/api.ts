import axios from 'axios';

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
        if (error.response?.status === 401) {
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
                } catch {
                    // Refresh failed, clear tokens
                    localStorage.removeItem('token');
                    localStorage.removeItem('refreshToken');
                    localStorage.removeItem('user');
                    window.location.href = '/login';
                }
            }
        }
        return Promise.reject(error);
    }
);

export default api;
