/** Faz 5 — shared types/helpers for the LinkedIn campaign UI (kept out of component files
 *  so react-refresh sees pure-component modules). */

export type CampaignStatus = 'draft' | 'active' | 'paused' | 'archived';

export interface LinkedInCampaign {
    id: string;
    name: string;
    status: CampaignStatus;
    sender_account_ids: string[];
    settings: Record<string, unknown>;
    dry_run: boolean;
    created_at: string;
}

export interface AccountOption { id: string; name: string | null; public_id: string | null; status: string }

export const CAMPAIGN_STATUS_COLOR: Record<CampaignStatus, string> = {
    draft: 'gray', active: 'green', paused: 'yellow', archived: 'dark',
};

export function accountLabel(a: AccountOption): string {
    return a.name ?? a.public_id ?? a.id.slice(0, 8);
}

/** One lead per line: profile URL / public id / URN — optionally `, First, Last, Company, Title`. */
export function parseLeadLine(line: string): Record<string, string> | null {
    const parts = line.split(',').map((s) => s.trim());
    const idPart = parts[0] ?? '';
    if (!idPart) return null;
    const lead: Record<string, string> = {};
    const urlMatch = idPart.match(/linkedin\.com\/in\/([^/?#]+)/i);
    if (urlMatch) lead.public_id = decodeURIComponent(urlMatch[1]);
    else if (idPart.toLowerCase().startsWith('urn:li:')) lead.profile_urn = idPart;
    else lead.public_id = idPart;
    if (parts[1]) lead.first_name = parts[1];
    if (parts[2]) lead.last_name = parts[2];
    if (parts[3]) lead.company = parts[3];
    if (parts[4]) lead.title = parts[4];
    return lead;
}
