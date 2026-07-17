import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { requireRole, getTokenExp } from './auth';

// Minimal Express res double that records status/json without a real server.
function mockRes() {
    const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
    res.status = ((code: number) => { res.statusCode = code; return res; }) as Response['status'];
    res.json = ((body: unknown) => { res.body = body; return res; }) as Response['json'];
    return res as Response & { statusCode?: number; body?: unknown };
}

// base64url-encode a JWT segment
const seg = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const makeToken = (payload: object) => `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg(payload)}.sig`;

describe('requireRole', () => {
    it('401s when there is no authenticated user', () => {
        const req = {} as Request;
        const res = mockRes();
        const next = vi.fn() as unknown as NextFunction;

        requireRole('superadmin')(req, res, next);

        expect(res.statusCode).toBe(401);
        expect(next).not.toHaveBeenCalled();
    });

    it('403s when the user role is not in the allowed set', () => {
        const req = { user: { id: 'u', email: 'e', tenantId: 't', role: 'client_viewer' } } as Request;
        const res = mockRes();
        const next = vi.fn() as unknown as NextFunction;

        requireRole('superadmin', 'ops_agent')(req, res, next);

        expect(res.statusCode).toBe(403);
        expect(next).not.toHaveBeenCalled();
    });

    it('calls next() and sets no status when the role is allowed', () => {
        const req = { user: { id: 'u', email: 'e', tenantId: 't', role: 'ops_agent' } } as Request;
        const res = mockRes();
        const next = vi.fn() as unknown as NextFunction;

        requireRole('superadmin', 'ops_agent')(req, res, next);

        expect(next).toHaveBeenCalledOnce();
        expect(res.statusCode).toBeUndefined();
    });
});

describe('getTokenExp', () => {
    it('returns the exp claim in ms since epoch', () => {
        const expSeconds = 1_800_000_000;
        expect(getTokenExp(makeToken({ sub: 'u', exp: expSeconds }))).toBe(expSeconds * 1000);
    });

    it('returns null when there is no exp claim', () => {
        expect(getTokenExp(makeToken({ sub: 'u' }))).toBeNull();
    });

    it('returns null for a non-numeric exp', () => {
        expect(getTokenExp(makeToken({ sub: 'u', exp: 'soon' }))).toBeNull();
    });

    it('returns null for a malformed token (no payload segment)', () => {
        expect(getTokenExp('not-a-jwt')).toBeNull();
        expect(getTokenExp('')).toBeNull();
        expect(getTokenExp('a..c')).toBeNull();
    });
});
