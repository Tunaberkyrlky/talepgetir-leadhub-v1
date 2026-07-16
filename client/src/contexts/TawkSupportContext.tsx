import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from 'react';
import { useLocation } from 'react-router-dom';
import api from '../lib/api';
import { captureAnalyticsEvent } from '../lib/analytics';
import { createLogger } from '../lib/logger';
import { useAuth } from './AuthContext';
import { useConsent } from './ConsentContext';

interface TawkApi {
    visitor?: Record<string, string>;
    customStyle?: { zIndex: number };
    onLoad?: () => void;
    onChatMaximized?: () => void;
    onChatMinimized?: () => void;
    onChatStarted?: () => void;
    onChatEnded?: () => void;
    onOfflineSubmit?: (data?: { email?: string }) => void;
    onAgentJoinChat?: (data?: { id?: string }) => void;
    onChatSatisfaction?: (score: number) => void;
    maximize?: () => void;
    shutdown?: () => void;
    setAttributes?: (attributes: Record<string, string>, callback?: (error?: string) => void) => void;
    addTags?: (tags: string[], callback?: (error?: string) => void) => void;
    addEvent?: (event: string, metadata?: Record<string, string>, callback?: (error?: string) => void) => void;
}

declare global {
    interface Window {
        Tawk_API?: TawkApi;
        Tawk_LoadStart?: Date;
    }
}

interface SupportIdentity {
    name: string;
    email: string;
    hash: string;
}

interface SupportContextValue {
    isConfigured: boolean;
    isReady: boolean;
    openSupport: () => void;
}

const SupportContext = createContext<SupportContextValue | null>(null);
const log = createLogger('tawk-support');
const SCRIPT_ID = 'tawk-support-script';

function moduleFromPath(pathname: string): string {
    const segment = pathname.split('/').filter(Boolean)[0] || 'dashboard';
    return segment.replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 40);
}

function clearTawkStorage(): void {
    for (const key of Object.keys(window.localStorage)) {
        if (/^(tawk|twk_)/i.test(key)) window.localStorage.removeItem(key);
    }
    for (const key of Object.keys(window.sessionStorage)) {
        if (/^(tawk|twk_|PreviousNav$)/i.test(key)) window.sessionStorage.removeItem(key);
    }
    for (const cookie of document.cookie.split(';')) {
        const name = cookie.split('=')[0]?.trim();
        if (name && /^(tawk|twk_)/i.test(name)) {
            document.cookie = `${name}=; Max-Age=0; path=/; SameSite=Lax`;
        }
    }
}

export function TawkSupportProvider({ children }: { children: ReactNode }) {
    const { user, activeTenantId, activeTenantName, activeTenantTier } = useAuth();
    const { preferences, openPreferences } = useConsent();
    const location = useLocation();
    const [isReady, setIsReady] = useState(false);
    const mountedRef = useRef(true);
    const supportContextRef = useRef({ activeTenantTier: 'basic' });

    const propertyId = import.meta.env.VITE_TAWK_PROPERTY_ID as string | undefined;
    const widgetId = import.meta.env.VITE_TAWK_WIDGET_ID as string | undefined;
    const isConfigured = Boolean(propertyId && widgetId);
    const supportAllowed = preferences?.support === true;
    const currentModule = moduleFromPath(location.pathname);
    supportContextRef.current = { activeTenantTier };

    useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);

    useEffect(() => {
        if (!supportAllowed || !isConfigured || !user) {
            if (window.Tawk_API) {
                try { window.Tawk_API.shutdown?.(); } catch { /* best-effort vendor cleanup */ }
            }
            document.getElementById(SCRIPT_ID)?.remove();
            clearTawkStorage();
            delete window.Tawk_API;
            delete window.Tawk_LoadStart;
            setIsReady(false);
            return;
        }

        let cancelled = false;
        const setup = async () => {
            let identity: SupportIdentity | null = null;
            try {
                const response = await api.get<{ identity: SupportIdentity | null }>('/support/identity');
                identity = response.data.identity;
            } catch (error) {
                // Live support remains available anonymously if Secure Mode is not
                // configured, but PII is never sent without a server-generated hash.
                log.warn('Secure support identity unavailable; loading anonymous widget', { error });
            }
            if (cancelled || !mountedRef.current) return;

            const context = {
                'tenant-id': activeTenantId || 'unknown',
                'tenant-name': (activeTenantName || 'unknown').slice(0, 255),
                'tenant-tier': activeTenantTier,
                'user-role': user.role,
                'current-module': currentModule,
                'current-path': location.pathname.slice(0, 255),
            };

            const apiObject: TawkApi = {
                customStyle: { zIndex: 9000 },
                onLoad: () => {
                    if (mountedRef.current) setIsReady(true);
                    window.Tawk_API?.setAttributes?.(context, (error) => {
                        if (error) log.warn('Could not attach support context', { error });
                    });
                    captureAnalyticsEvent('support_widget_loaded', {
                        module: currentModule,
                        path: location.pathname,
                    });
                },
                onChatMaximized: () => captureAnalyticsEvent('support_widget_opened', {
                    module: moduleFromPath(window.location.pathname),
                    path: window.location.pathname,
                }),
                onChatMinimized: () => captureAnalyticsEvent('support_widget_minimized'),
                onChatStarted: () => {
                    const module = moduleFromPath(window.location.pathname);
                    const currentTier = supportContextRef.current.activeTenantTier;
                    window.Tawk_API?.addTags?.([
                        `module-${module}`,
                        `tier-${currentTier.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`,
                    ]);
                    window.Tawk_API?.addEvent?.('tg-support-started', {
                        module,
                        path: window.location.pathname.slice(0, 255),
                    });
                    captureAnalyticsEvent('support_chat_started', {
                        module,
                        path: window.location.pathname,
                        tenant_tier: currentTier,
                    });
                },
                onChatEnded: () => captureAnalyticsEvent('support_chat_ended', {
                    module: moduleFromPath(window.location.pathname),
                }),
                onOfflineSubmit: (data) => captureAnalyticsEvent('support_offline_form_submitted', {
                    module: moduleFromPath(window.location.pathname),
                    supplied_email: Boolean(data?.email),
                }),
                onAgentJoinChat: () => captureAnalyticsEvent('support_agent_joined', {
                    module: moduleFromPath(window.location.pathname),
                }),
                onChatSatisfaction: (score) => captureAnalyticsEvent('support_chat_satisfaction', { score }),
            };

            if (identity) {
                apiObject.visitor = {
                    name: identity.name,
                    email: identity.email,
                    hash: identity.hash,
                };
            }

            window.Tawk_API = apiObject;
            window.Tawk_LoadStart = new Date();
            if (!document.getElementById(SCRIPT_ID)) {
                const script = document.createElement('script');
                script.id = SCRIPT_ID;
                script.async = true;
                script.charset = 'UTF-8';
                script.setAttribute('crossorigin', '*');
                script.src = `https://embed.tawk.to/${propertyId}/${widgetId}`;
                document.head.appendChild(script);
            }
        };

        void setup();
        return () => { cancelled = true; };
        // The widget lifecycle is tied to consent/account, not route changes. Route
        // context is updated by the dedicated effect below to avoid reloading chat.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [supportAllowed, isConfigured, user?.id]);

    useEffect(() => {
        if (!isReady || !window.Tawk_API?.setAttributes) return;
        window.Tawk_API.setAttributes({
            'tenant-id': activeTenantId || 'unknown',
            'tenant-name': (activeTenantName || 'unknown').slice(0, 255),
            'tenant-tier': activeTenantTier,
            'user-role': user?.role || 'unknown',
            'current-module': currentModule,
            'current-path': location.pathname.slice(0, 255),
        });
    }, [activeTenantId, activeTenantName, activeTenantTier, currentModule, isReady, location.pathname, user?.role]);

    const openSupport = useCallback(() => {
        if (!supportAllowed) {
            openPreferences();
            return;
        }
        if (window.Tawk_API?.maximize) {
            window.Tawk_API.maximize();
            return;
        }
        captureAnalyticsEvent('support_widget_open_requested', { widget_ready: false });
    }, [openPreferences, supportAllowed]);

    const value = useMemo(() => ({ isConfigured, isReady, openSupport }), [isConfigured, isReady, openSupport]);
    return <SupportContext.Provider value={value}>{children}</SupportContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTawkSupport(): SupportContextValue {
    const context = useContext(SupportContext);
    if (!context) throw new Error('useTawkSupport must be used within TawkSupportProvider');
    return context;
}
