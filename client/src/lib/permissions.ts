// Tier = tenant-level package (Basic or Pro)
export type Tier = 'basic' | 'pro';

// Roles
export type Role = 'superadmin' | 'ops_agent' | 'client_admin' | 'client_viewer';

// Role-based features (tier-independent)
export type RoleFeature =
    | 'import'
    | 'delete_records'
    | 'crud'
    | 'internal_notes'
    | 'activity_write'
    | 'pipeline_dragdrop'
    | 'invite_members'
    | 'export_full'
    | 'export_masked'
    | 'admin_panel';

// Tier-based features (only affect client roles; internal roles are exempt)
export type TierFeature =
    | 'pipeline_view'
    | 'advanced_stats'
    | 'activity_timeline'
    | 'person_detail_full'
    | 'advanced_filters';

const ROLE_PERMISSIONS: Record<RoleFeature, Role[]> = {
    import: ['superadmin', 'ops_agent', 'client_admin'],
    delete_records: ['superadmin'],
    crud: ['superadmin', 'ops_agent'],
    internal_notes: ['superadmin', 'ops_agent'],
    activity_write: ['superadmin', 'ops_agent'],
    pipeline_dragdrop: ['superadmin', 'ops_agent'],
    invite_members: ['superadmin', 'client_admin'],
    export_full: ['superadmin', 'ops_agent', 'client_admin'],
    export_masked: ['superadmin', 'ops_agent', 'client_admin', 'client_viewer'],
    admin_panel: ['superadmin'],
};

const TIER_FEATURES: Record<TierFeature, Tier[]> = {
    pipeline_view: ['pro'],
    advanced_stats: ['pro'],
    activity_timeline: ['pro'],
    person_detail_full: ['pro'],
    advanced_filters: ['pro'],
};

const INTERNAL_ROLES: Role[] = ['superadmin', 'ops_agent'];

/** Check if a role is internal (our team) — tier-exempt */
export function isInternal(role: string): boolean {
    return INTERNAL_ROLES.includes(role as Role);
}

/** Check if a role can delete records (superadmin only) */
export function canDelete(role: string): boolean {
    return role === 'superadmin';
}

/** Check if a role can create/edit data */
export function canWrite(role: string): boolean {
    return ['superadmin', 'ops_agent'].includes(role);
}

/** Check if a role is read-only */
export function isReadOnly(role: string): boolean {
    return role === 'client_viewer';
}

/** Check role-based permission (tier-independent) */
export function hasRolePermission(role: string, feature: RoleFeature): boolean {
    const allowed = ROLE_PERMISSIONS[feature];
    return allowed ? allowed.includes(role as Role) : false;
}

/** Check tier-based feature access. Internal roles always have access. */
export function hasTierAccess(role: string, tier: Tier, feature: TierFeature): boolean {
    if (isInternal(role)) return true;
    const allowedTiers = TIER_FEATURES[feature];
    return allowedTiers ? allowedTiers.includes(tier) : false;
}

/** Combined check: role permission AND tier access */
export function canAccessFeature(
    role: string,
    tier: Tier,
    feature: RoleFeature | TierFeature
): boolean {
    // Check if it's a role-based feature
    if (feature in ROLE_PERMISSIONS) {
        return hasRolePermission(role, feature as RoleFeature);
    }
    // Check if it's a tier-based feature
    if (feature in TIER_FEATURES) {
        return hasTierAccess(role, tier, feature as TierFeature);
    }
    return false;
}
