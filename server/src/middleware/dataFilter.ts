import { Request, Response, NextFunction } from 'express';

const INTERNAL_ROLES = ['superadmin', 'ops_agent'];

/** Check if the current user is internal (superadmin or ops_agent) */
function isInternalUser(req: Request): boolean {
    return INTERNAL_ROLES.includes((req as any).user?.role);
}

/** Check if the current user is a client_viewer */
function isViewerUser(req: Request): boolean {
    return (req as any).user?.role === 'client_viewer';
}

/**
 * Single composed data filter middleware.
 * Applies all role-based transformations in one res.json override:
 * - Strips internal_notes for client roles
 * - Masks sensitive contact fields for client_viewer
 * - Filters internal-visibility activities for client roles
 */
export function dataFilter(req: Request, _res: Response, next: NextFunction): void {
    const internal = isInternalUser(req);
    const viewer = isViewerUser(req);

    // Internal users see everything unfiltered
    if (internal) {
        next();
        return;
    }

    const originalJson = _res.json.bind(_res);
    _res.json = function (body: any) {
        if (body?.data) {
            if (Array.isArray(body.data)) {
                body.data = body.data
                    .filter((item: any) => item.visibility !== 'internal')
                    .map((item: any) => transformItem(item, viewer));
            } else {
                body.data = transformItem(body.data, viewer);
            }
        }
        return originalJson(body);
    };
    next();
}

/** Apply all transformations to a single data item */
function transformItem(obj: any, maskSensitive: boolean): any {
    if (!obj || typeof obj !== 'object') return obj;

    // Strip internal_notes
    const { internal_notes, ...rest } = obj;

    // Mask sensitive fields for client_viewer
    if (maskSensitive) {
        if (rest.email && typeof rest.email === 'string') {
            rest.email = maskEmail(rest.email);
        }
        if (rest.phone_e164 && typeof rest.phone_e164 === 'string') {
            rest.phone_e164 = maskPhone(rest.phone_e164);
        }
        if (rest.company_phone && typeof rest.company_phone === 'string') {
            rest.company_phone = maskPhone(rest.company_phone);
        }
        if (rest.company_email && typeof rest.company_email === 'string') {
            rest.company_email = maskEmail(rest.company_email);
        }
    }

    // Transform nested contacts
    if (rest.contacts && Array.isArray(rest.contacts)) {
        rest.contacts = rest.contacts.map((c: any) => transformItem(c, maskSensitive));
    }

    return rest;
}

/** Mask email: "john.doe@example.com" → "john@ex..." */
export function maskEmail(email: string): string {
    const [local, domain] = email.split('@');
    if (!domain) return '***';
    const localPart = local.length > 4 ? local.slice(0, 4) : local;
    const domainPart = domain.length > 2 ? domain.slice(0, 2) : domain;
    return `${localPart}@${domainPart}...`;
}

/** Mask phone: "+905551234567" → "+90 5** *** **67" */
export function maskPhone(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 4) return '***';
    const last2 = digits.slice(-2);
    const first2 = digits.slice(0, 2);
    return `+${first2} ${'*'.repeat(digits.length - 4)}${last2}`;
}
