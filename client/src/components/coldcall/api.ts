/** Cold Call modülü — API çağrıları (paylaşılan axios instance'ı üzerinden). */
import api from '../../lib/api';
import type {
    AvailableNumber, CallDetail, CallRow, ColdcallConfig, CountryInfo, Disposition, PhoneNumber,
} from './types';

export const coldcallApi = {
    config: async (): Promise<ColdcallConfig> => (await api.get('/coldcall/calls/config')).data,

    countries: async (): Promise<CountryInfo[]> =>
        (await api.get('/coldcall/numbers/countries')).data.countries,

    numbers: async (): Promise<PhoneNumber[]> => (await api.get('/coldcall/numbers')).data.numbers,

    searchNumbers: async (country: string, contains?: string): Promise<{ numbers: AvailableNumber[]; requires_docs: boolean }> =>
        (await api.get('/coldcall/numbers/search', { params: { country, contains: contains || undefined } })).data,

    purchaseNumber: async (country: string, e164: string): Promise<PhoneNumber> =>
        (await api.post('/coldcall/numbers', { country, e164 })).data,

    releaseNumber: async (id: string): Promise<void> => {
        await api.delete(`/coldcall/numbers/${id}`);
    },

    startCall: async (input: {
        to_e164: string;
        phone_number_id?: string;
        company_id?: string;
        contact_id?: string;
    }): Promise<{ call: CallRow; mode: 'simulated' | 'webrtc' }> =>
        (await api.post('/coldcall/calls', input)).data,

    listCalls: async (params: { company_id?: string; limit?: number; offset?: number } = {}): Promise<{ calls: CallRow[]; total: number }> =>
        (await api.get('/coldcall/calls', { params })).data,

    callDetail: async (id: string): Promise<CallDetail> => (await api.get(`/coldcall/calls/${id}`)).data,

    hangup: async (id: string): Promise<void> => {
        await api.post(`/coldcall/calls/${id}/hangup`);
    },

    setDisposition: async (id: string, disposition: Disposition, notes?: string): Promise<void> => {
        await api.patch(`/coldcall/calls/${id}/disposition`, { disposition, notes: notes || undefined });
    },

    retrySummary: async (id: string): Promise<void> => {
        await api.post(`/coldcall/calls/${id}/retry-summary`);
    },

    voiceToken: async (): Promise<{ token: string; identity: string }> =>
        (await api.get('/coldcall/calls/token')).data,
};

/** E.164 girdisinden ülke bul — en uzun dial code eşleşmesi (server ile aynı kural). */
export function matchCountry(e164: string, countries: CountryInfo[]): CountryInfo | undefined {
    if (!e164.startsWith('+')) return undefined;
    if (/^\+7\d/.test(e164)) return countries.find((c) => c.code === 'RU');
    return [...countries]
        .sort((a, b) => b.dial_code.length - a.dial_code.length)
        .find((c) => e164.startsWith(c.dial_code));
}
