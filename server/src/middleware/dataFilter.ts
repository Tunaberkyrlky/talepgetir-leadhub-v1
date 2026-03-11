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
 * Strip internal_notes from company objects for client roles.
 * Removes the field entirely so it never reaches the client.
 */
export function stripInternalNotes(req: Request, _res: Response, next: NextFunction): void {
    if (isInternalUser(req)) {
        next();
        return;
    }

    // Override res.json to filter internal_notes from response
    const originalJson = _res.json.bind(_res);
    _res.json = function (body: any) {
        if (body?.data) {
            if (Array.isArray(body.data)) {
                body.data = body.data.map(stripInternalFields);
            } else {
                body.data = stripInternalFields(body.data);
            }
        }
        return originalJson(body);
    };
    next();
}

/**
 * Filter activities with visibility='internal' for client roles.
 */
export function filterInternalActivities(req: Request, _res: Response, next: NextFunction): void {
    if (isInternalUser(req)) {
        next();
        return;
    }

    const originalJson = _res.json.bind(_res);
    _res.json = function (body: any) {
        if (body?.data && Array.isArray(body.data)) {
            body.data = body.data.filter(
                (item: any) => item.visibility !== 'internal'
            );
        }
        return originalJson(body);
    };
    next();
}

/**
 * Mask sensitive contact info (email, phone) for client_viewer role.
 */
export function maskSensitiveData(req: Request, _res: Response, next: NextFunction): void {
    if (!isViewerUser(req)) {
        next();
        return;
    }

    const originalJson = _res.json.bind(_res);
    _res.json = function (body: any) {
        if (body?.data) {
            if (Array.isArray(body.data)) {
                body.data = body.data.map(maskContactFields);
            } else {
                body.data = maskContactFields(body.data);
            }
        }
        return originalJson(body);
    };
    next();
}

// --- Helper functions ---

function stripInternalFields(obj: any): any {
    if (!obj || typeof obj !== 'object') return obj;
    const { internal_notes, ...rest } = obj;
    // Also strip internal_notes from nested contacts
    if (rest.contacts && Array.isArray(rest.contacts)) {
        rest.contacts = rest.contacts.map(stripInternalFields);
    }
    return rest;
}

function maskContactFields(obj: any): any {
    if (!obj || typeof obj !== 'object') return obj;
    const result = { ...obj };

    if (result.email && typeof result.email === 'string') {
        result.email = maskEmail(result.email);
    }
    if (result.phone_e164 && typeof result.phone_e164 === 'string') {
        result.phone_e164 = maskPhone(result.phone_e164);
    }
    if (result.company_phone && typeof result.company_phone === 'string') {
        result.company_phone = maskPhone(result.company_phone);
    }

    // Also mask nested contacts
    if (result.contacts && Array.isArray(result.contacts)) {
        result.contacts = result.contacts.map(maskContactFields);
    }

    return result;
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
