import type { ReactNode } from 'react';
import { useAuth } from '../contexts/AuthContext';
import {
    hasRolePermission,
    hasTierAccess,
    type RoleFeature,
    type TierFeature,
    type Tier,
} from '../lib/permissions';

interface FeatureGateProps {
    /** Role-based feature to check */
    feature: RoleFeature;
    /** Fallback UI when access is denied */
    fallback?: ReactNode;
    children: ReactNode;
}

/**
 * Role-based feature gate.
 * Renders children only if the user's role has permission for the feature.
 */
export function FeatureGate({ feature, fallback = null, children }: FeatureGateProps) {
    const { user } = useAuth();
    const role = user?.role || '';

    if (!hasRolePermission(role, feature)) {
        return <>{fallback}</>;
    }

    return <>{children}</>;
}

interface TierGateProps {
    /** Tier-based feature to check */
    feature: TierFeature;
    /** Fallback UI when tier doesn't support this feature */
    fallback?: ReactNode;
    children: ReactNode;
}

/**
 * Tier-based feature gate.
 * Renders children only if the tenant's tier supports the feature.
 * Internal roles (superadmin, ops_agent) always pass.
 */
export function TierGate({ feature, fallback = null, children }: TierGateProps) {
    const { user, activeTenantTier } = useAuth();
    const role = user?.role || '';
    const tier = (activeTenantTier || 'basic') as Tier;

    if (!hasTierAccess(role, tier, feature)) {
        return <>{fallback}</>;
    }

    return <>{children}</>;
}
