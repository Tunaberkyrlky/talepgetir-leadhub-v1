export type DealStatus = 'open' | 'won' | 'lost';
export type DealContactRole = 'decision_maker' | 'influencer' | 'champion' | 'user' | 'blocker';

export interface DealOwnerUser {
    id: string;
    email: string;
    name: string | null;
}

export interface Deal {
    id: string;
    tenant_id: string;
    company_id: string;
    contact_id: string | null;
    title: string;
    description: string | null;
    amount: number | null;
    currency: string;
    // Canonical pipeline reference (uuid). `stage` is the denormalized slug the
    // server keeps in sync; prefer stage_id in the client.
    stage_id: string | null;
    stage: string;
    status: DealStatus;
    expected_close: string | null;
    loss_reason: string | null;
    // Qualification (v2 Phase 6, migration 139). lead_source/priority carry the same
    // taxonomy as companies; loss_reason_code is the standardized code alongside the
    // free-text loss_reason.
    lead_source: string | null;
    priority: 'low' | 'normal' | 'high' | null;
    loss_reason_code: string | null;
    owner: string | null;
    created_by: string | null;
    closed_at: string | null;
    created_at: string;
    updated_at: string;
    // Mapped display fields (list + detail responses)
    company_name: string | null;
    contact_name: string | null;
    owner_user: DealOwnerUser | null;
}

export interface DealContact {
    id: string;
    contact_id: string;
    role: DealContactRole | null;
    created_at: string;
    contact_name: string | null;
    contact_email: string | null;
    contact_title: string | null;
}

// GET /deals/:id — a deal plus its related contacts and open task count.
export interface DealDetail extends Deal {
    contacts: DealContact[];
    open_task_count: number;
}

export interface DealsResponse {
    data: Deal[];
    pagination: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
        hasNext: boolean;
        hasPrev: boolean;
    };
}

// POST /deals — create input (owner omitted => creator; null => unassigned).
export interface DealCreateInput {
    company_id: string;
    contact_id?: string | null;
    stage_id: string;
    title: string;
    description?: string | null;
    amount?: number | null;
    currency?: string;
    expected_close?: string | null;
    owner?: string | null;
    lead_source?: string | null;
    priority?: 'low' | 'normal' | 'high' | null;
}

// PUT /deals/:id — every field optional; status changes go through close/reopen.
export interface DealUpdateInput {
    contact_id?: string | null;
    stage_id?: string;
    title?: string;
    description?: string | null;
    amount?: number | null;
    currency?: string;
    expected_close?: string | null;
    owner?: string | null;
    lead_source?: string | null;
    priority?: 'low' | 'normal' | 'high' | null;
}

// POST /deals/:id/close — loss_reason is required when closing as lost.
export interface DealCloseInput {
    status: 'won' | 'lost';
    loss_reason?: string | null;
    loss_reason_code?: string | null;
}

// POST /deals/:id/reopen — optional rationale.
export interface DealReopenInput {
    reason?: string | null;
}

// POST /deals/:id/contacts — link a contact with an optional role.
export interface DealContactInput {
    contact_id: string;
    role?: DealContactRole | null;
}
