export const CONSENT_STORAGE_KEY = 'tg-core-consent-v1';
export const CONSENT_POLICY_VERSION = '2026-07-16';
export const CONSENT_CHANGED_EVENT = 'privacy:consentChanged';

export interface ConsentPreferences {
    necessary: true;
    analytics: boolean;
    support: boolean;
    policyVersion: string;
    updatedAt: string;
}

function isConsentPreferences(value: unknown): value is ConsentPreferences {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Partial<ConsentPreferences>;
    return candidate.necessary === true
        && typeof candidate.analytics === 'boolean'
        && typeof candidate.support === 'boolean'
        && candidate.policyVersion === CONSENT_POLICY_VERSION
        && typeof candidate.updatedAt === 'string';
}

/**
 * Consent is deliberately device-scoped. Returning null means the current policy
 * version has not been answered on this browser and the banner must be shown.
 */
export function readConsentPreferences(): ConsentPreferences | null {
    try {
        const stored = window.localStorage.getItem(CONSENT_STORAGE_KEY);
        if (!stored) return null;
        const parsed: unknown = JSON.parse(stored);
        return isConsentPreferences(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

export function createConsentPreferences(
    analytics: boolean,
    support: boolean,
): ConsentPreferences {
    return {
        necessary: true,
        analytics,
        support,
        policyVersion: CONSENT_POLICY_VERSION,
        updatedAt: new Date().toISOString(),
    };
}

export function storeConsentPreferences(preferences: ConsentPreferences): void {
    try {
        window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(preferences));
    } catch {
        // A blocked/full storage area must not enable optional processing.
    }
    window.dispatchEvent(new CustomEvent(CONSENT_CHANGED_EVENT, { detail: preferences }));
}
