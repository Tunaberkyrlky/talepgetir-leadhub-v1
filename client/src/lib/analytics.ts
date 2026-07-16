import posthog from 'posthog-js';
import { readConsentPreferences } from './consent';

interface AnalyticsIdentity {
    id: string;
    properties: Record<string, string | null | undefined>;
}

let initialized = false;
let pendingIdentity: AnalyticsIdentity | null = null;

function applyPendingIdentity(): void {
    if (!pendingIdentity) return;
    posthog.identify(pendingIdentity.id, pendingIdentity.properties);
    const tenantId = pendingIdentity.properties.tenant_id;
    if (typeof tenantId === 'string' && tenantId) {
        posthog.group('tenant', tenantId, {
            name: pendingIdentity.properties.tenant_name,
            tier: pendingIdentity.properties.tenant_tier,
        });
    }
}

function isAllowed(): boolean {
    return readConsentPreferences()?.analytics === true;
}

/** Initializes the SDK in a fail-closed state before React begins capturing events. */
export function initializeAnalytics(): void {
    const key = import.meta.env.VITE_POSTHOG_KEY;
    if (!key || initialized) return;

    posthog.init(key, {
        api_host: import.meta.env.VITE_POSTHOG_HOST || 'https://eu.i.posthog.com',
        autocapture: {
            element_allowlist: ['button', 'a'],
        },
        capture_pageview: false,
        capture_pageleave: true,
        opt_out_capturing_by_default: true,
        opt_out_capturing_persistence_type: 'localStorage',
        session_recording: {
            maskAllInputs: true,
            // CRM screens contain commercial and personal data. Keep recordings useful
            // for layout/navigation analysis without recording customer-facing text.
            maskTextSelector: '*',
        },
    });
    initialized = true;

    if (isAllowed()) posthog.opt_in_capturing();
    else posthog.opt_out_capturing();
}

export function setAnalyticsConsent(allowed: boolean): void {
    if (!initialized) return;
    if (!allowed) {
        posthog.opt_out_capturing();
        return;
    }

    posthog.opt_in_capturing();
    applyPendingIdentity();
}

export function identifyAnalyticsUser(
    id: string,
    properties: Record<string, string | null | undefined>,
): void {
    pendingIdentity = { id, properties };
    if (initialized && isAllowed()) applyPendingIdentity();
}

export function resetAnalyticsUser(): void {
    pendingIdentity = null;
    if (initialized) posthog.reset();
}

export function captureAnalyticsEvent(
    event: string,
    properties?: Record<string, unknown>,
): void {
    if (!initialized || !isAllowed()) return;
    posthog.capture(event, {
        app_version: __APP_VERSION__,
        environment: import.meta.env.MODE,
        ...properties,
    });
}
