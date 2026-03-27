import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import api from '../lib/api';

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
    const activeTenant = accessibleTenants.find((t) => t.id === activeTenantId);
    const activeTenantName = activeTenant?.name || user?.tenantName || null;
    const activeTenantTier = activeTenant?.tier || 'basic';
    const canSwitchTenants = accessibleTenants.length > 1;

    // Check auth on mount — cookies are sent automatically
    useEffect(() => {
        const checkAuth = async () => {
            try {
                const { data } = await api.get('/auth/me');
                setUser(data.user);

                // Set active tenant if not already set
                const savedTenantId = localStorage.getItem('activeTenantId');
                if (!savedTenantId && data.user.tenantId) {
                    setActiveTenantId(data.user.tenantId);
                    localStorage.setItem('activeTenantId', data.user.tenantId);
                }
            } catch {
                // Token invalid — cookies will be cleared by server on next refresh attempt
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
        // Tokens are now stored in httpOnly cookies by the server
        setUser(data.user);

        // Set the default active tenant
        const defaultTenantId = data.user.tenantId;
        setActiveTenantId(defaultTenantId);
        if (defaultTenantId) {
            localStorage.setItem('activeTenantId', defaultTenantId);
        }
    }, []);

    const logout = useCallback(async () => {
        try {
            await api.post('/auth/logout');
        } catch {
            // Best-effort logout
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
