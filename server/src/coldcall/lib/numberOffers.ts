import { createHmac, timingSafeEqual } from 'crypto';

export interface NumberOffer {
    tenantId: string;
    provider: 'mock' | 'twilio';
    e164: string;
    country: string;
    numberType: string;
    monthlyCogsUsd: number;
    expiresAt: number;
}

function secret(): string {
    const value = process.env.COLDCALL_OFFER_SECRET;
    if (!value || value.length < 32) throw new Error('COLDCALL_OFFER_SECRET must be at least 32 characters');
    return value;
}

export function signNumberOffer(offer: NumberOffer): string {
    const payload = Buffer.from(JSON.stringify(offer)).toString('base64url');
    const signature = createHmac('sha256', secret()).update(payload).digest('base64url');
    return `${payload}.${signature}`;
}

export function verifyNumberOffer(token: string, tenantId: string): NumberOffer {
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra) throw new Error('invalid_offer');
    const expected = createHmac('sha256', secret()).update(payload).digest();
    const supplied = Buffer.from(signature, 'base64url');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('invalid_offer');
    const offer = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as NumberOffer;
    if (offer.tenantId !== tenantId || offer.expiresAt <= Date.now()) throw new Error('expired_or_wrong_tenant_offer');
    if (!/^\+\d{7,15}$/.test(offer.e164) || !/^[A-Z]{2}$/.test(offer.country)) throw new Error('invalid_offer');
    return offer;
}
