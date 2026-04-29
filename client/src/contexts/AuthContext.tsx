import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import posthog from 'posthog-js';
import api from '../lib/api';
import { createLogger } from '../lib/logger';

const log = createLogger('auth');

interface Tenant {
    id: string;
    name: string;
    slug: string;
    role: string;
    tier: string;
}

interface User {
    id: string;
    email: string;
    tenantId: string;
    tenantName?: string;
    role: string;
    accessibleTenants?: Tenant[];
    tenantSettings?: Record<string, any>;
}

interface AuthContextType {
    user: User | null;
    isLoading: boolean;
    login: (email: string, password: string) => Promise<void>;
    logout: () => void;
    isAuthenticated: boolean;
    activeTenantId: string | null;
    activeTenantName: string | null;
    activeTenantTier: string;
    accessibleTenants: Tenant[];
    switchTenant: (tenantId: string) => void;
    canSwitchTenants: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<User | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [activeTenantId, setActiveTenantId] = useState<string | null>(
        localStorage.getItem('activeTenantId')
    );
    const queryClient = useQueryClient();
    const navigate = useNavigate();

    // Derive accessible tenants + active tenant name/tier from user
    const accessibleTenants = user?.accessibleTenants || [];
    const activeTenant = accessibleTenants.find((t) => t.id === activeTenantId)
        ?? (accessibleTenants.length === 1 ? accessibleTenants[0] : undefined);
    const activeTenantName = activeTenant?.name || user?.tenantName || null;
    const activeTenantTier = activeTenant?.tier || 'basic';
    const canSwitchTenants = accessibleTenants.length > 1;

    // Check auth on mount — cookies are sent automatically
    useEffect(() => {
        const checkAuth = async () => {
            try {
                const { data } = await api.get('/auth/me');
                setUser(data.user);

                if (import.meta.env.VITE_POSTHOG_KEY) {
                    posthog.identify(data.user.id, {
                        email: data.user.email,
                        tenant_id: data.user.tenantId,
                        role: data.user.role,
                    });
                }

                // Validate saved tenant against accessible tenants — clears stale IDs
                // (e.g. seed tenant deleted from DB but still in app_metadata / localStorage).
                const savedTenantId = localStorage.getItem('activeTenantId');
                const accessibleIds: string[] = (data.user.accessibleTenants || []).map((t: any) => t.id);
                const savedIsValid = !!savedTenantId && accessibleIds.includes(savedTenantId);

                if (!savedIsValid) {
                    const fallback = data.user.tenantId || accessibleIds[0] || null;
                    setActiveTenantId(fallback);
                    if (fallback) localStorage.setItem('activeTenantId', fallback);
                    else localStorage.removeItem('activeTenantId');
                }
            } catch (err) {
                // Token invalid — cookies will be cleared by server on next refresh attempt
                log.warn('Auth check failed, clearing session', { err });
                localStorage.removeItem('activeTenantId');
                setUser(null);
                setActiveTenantId(null);
            } finally {
                setIsLoading(false);
            }
        };

        checkAuth();
    }, []);

    // Listen for token refresh failures dispatched from the api interceptor.
    // Using a custom event avoids window.location.href which would do a full-page reload
    // and destroy unsaved React state (forms, import progress, etc.).
    useEffect(() => {
        const handleSessionExpired = () => {
            log.warn('Session expired, redirecting to login');
            setUser(null);
            setActiveTenantId(null);
            queryClient.clear();
            navigate('/login', { replace: true });
        };
        window.addEventListener('auth:sessionExpired', handleSessionExpired);
        return () => window.removeEventListener('auth:sessionExpired', handleSessionExpired);
    }, [navigate, queryClient]);

    const login = useCallback(async (email: string, password: string) => {
        const { data } = await api.post('/auth/login', { email, password });
        log.info('Login successful', { userId: data.user?.id, role: data.user?.role });
        // Tokens are now stored in httpOnly cookies by the server
        setUser(data.user);

        // Set the default active tenant.
        // Prefer the server-resolved tenantId; if it's null (e.g. superadmin with no
        // default tenant due to a stale/deleted app_metadata value), fall back to the
        // first accessible tenant so the UI always has a valid context to work with.
        const defaultTenantId = data.user.tenantId
            || data.user.accessibleTenants?.[0]?.id
            || null;
        setActiveTenantId(defaultTenantId);
        if (defaultTenantId) {
            localStorage.setItem('activeTenantId', defaultTenantId);
        }

        if (import.meta.env.VITE_POSTHOG_KEY) {
            posthog.identify(data.user.id, {
                email: data.user.email,
                tenant_id: defaultTenantId,
                role: data.user.role,
            });
        }
    }, []);

    const logout = useCallback(async () => {
        try {
            await api.post('/auth/logout');
        } catch (err) {
            log.warn('Logout request failed (best-effort)', { err });
        }
        log.info('User logged out');
        if (import.meta.env.VITE_POSTHOG_KEY) {
            posthog.reset();
        }
        localStorage.removeItem('activeTenantId');
        setUser(null);
        setActiveTenantId(null);
        queryClient.clear();
    }, [queryClient]);

    const switchTenant = useCallback((tenantId: string) => {
        setActiveTenantId(tenantId);
        localStorage.setItem('activeTenantId', tenantId);
        // Invalidate all queries so they refetch with new X-Tenant-Id header
        queryClient.invalidateQueries();
    }, [queryClient]);

    return (
        <AuthContext.Provider
            value={{
                user,
                isLoading,
                login,
                logout,
                isAuthenticated: !!user,
                activeTenantId,
                activeTenantName,
                activeTenantTier,
                accessibleTenants,
                switchTenant,
                canSwitchTenants,
            }}
        >
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return context;
}
