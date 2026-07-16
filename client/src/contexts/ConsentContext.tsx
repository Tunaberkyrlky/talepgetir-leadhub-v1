import {
    createContext,
    useCallback,
    useContext,
    useMemo,
    useState,
    type ReactNode,
} from 'react';
import {
    createConsentPreferences,
    readConsentPreferences,
    storeConsentPreferences,
    type ConsentPreferences,
} from '../lib/consent';
import { setAnalyticsConsent } from '../lib/analytics';

interface ConsentContextValue {
    preferences: ConsentPreferences | null;
    preferencesOpened: boolean;
    acceptAll: () => void;
    rejectOptional: () => void;
    savePreferences: (analytics: boolean, support: boolean) => void;
    openPreferences: () => void;
    closePreferences: () => void;
}

const ConsentContext = createContext<ConsentContextValue | null>(null);

export function ConsentProvider({ children }: { children: ReactNode }) {
    const [preferences, setPreferences] = useState<ConsentPreferences | null>(readConsentPreferences);
    const [preferencesOpened, setPreferencesOpened] = useState(false);

    const savePreferences = useCallback((analytics: boolean, support: boolean) => {
        const next = createConsentPreferences(analytics, support);
        storeConsentPreferences(next);
        setAnalyticsConsent(analytics);
        setPreferences(next);
        setPreferencesOpened(false);
    }, []);

    const value = useMemo<ConsentContextValue>(() => ({
        preferences,
        preferencesOpened,
        acceptAll: () => savePreferences(true, true),
        rejectOptional: () => savePreferences(false, false),
        savePreferences,
        openPreferences: () => setPreferencesOpened(true),
        closePreferences: () => setPreferencesOpened(false),
    }), [preferences, preferencesOpened, savePreferences]);

    return <ConsentContext.Provider value={value}>{children}</ConsentContext.Provider>;
}

// Context hooks intentionally share the provider module (same pattern as the
// existing app contexts); they do not hold Fast Refresh state themselves.
// eslint-disable-next-line react-refresh/only-export-components
export function useConsent(): ConsentContextValue {
    const context = useContext(ConsentContext);
    if (!context) throw new Error('useConsent must be used within ConsentProvider');
    return context;
}
