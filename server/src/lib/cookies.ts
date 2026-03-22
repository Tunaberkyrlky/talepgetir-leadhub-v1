import { Response } from 'express';

const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;

const COOKIE_OPTIONS = {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: IS_PROD ? 'strict' as const : 'lax' as const,
    path: '/',
};

const ACCESS_TOKEN_MAX_AGE = 60 * 60 * 1000;          // 1 hour
const REFRESH_TOKEN_MAX_AGE = 60 * 60 * 24 * 30 * 1000; // 30 days

export function setAuthCookies(res: Response, accessToken: string, refreshToken: string) {
    res.cookie('access_token', accessToken, {
        ...COOKIE_OPTIONS,
        maxAge: ACCESS_TOKEN_MAX_AGE,
    });
    res.cookie('refresh_token', refreshToken, {
        ...COOKIE_OPTIONS,
        maxAge: REFRESH_TOKEN_MAX_AGE,
    });
}

export function clearAuthCookies(res: Response) {
    res.clearCookie('access_token', { ...COOKIE_OPTIONS });
    res.clearCookie('refresh_token', { ...COOKIE_OPTIONS });
}
