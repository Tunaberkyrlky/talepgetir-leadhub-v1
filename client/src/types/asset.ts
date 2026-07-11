// Asset foundation (v3 WP3) — Asset Studio read models.
export type AssetOutputKind = 'html' | 'pdf' | 'json';
export type ApprovalPolicy = 'manual' | 'sampled' | 'automatic';
export type AssetDeliveryMode = 'public' | 'gated';
export type GeneratedAssetStatus = 'queued' | 'generating' | 'generated' | 'failed';
export type AssetEventType =
    | 'viewed' | 'unique_viewed' | 'section_reached'
    | 'cta_clicked' | 'pdf_downloaded' | 'booking_opened' | 'booking_completed';

// Recipe theme tokens. fontFamily is a CLOSED enum (never a free string) — the
// server maps it to a fixed CSS stack, so untrusted values can't inject CSS.
export type AssetFontFamily = 'system' | 'serif' | 'mono';
export interface AssetTheme {
    primary?: string;
    accent?: string;
    fontFamily?: AssetFontFamily;
}

export interface AssetRecipe {
    id: string;
    key: string;
    name: string;
    description: string | null;
    output_kind: AssetOutputKind;
    approval_policy: ApprovalPolicy;
    status: 'active' | 'inactive' | 'draft';
    created_at: string;
}

export interface AssetRecipesResponse {
    data: AssetRecipe[];
}

// A row in the generated-asset list (metadata only; rendered_html comes from detail).
export interface GeneratedAssetListItem {
    id: string;
    recipe_id: string;
    recipe_name: string | null;
    recipe_version: number;
    status: GeneratedAssetStatus;
    delivery_mode: AssetDeliveryMode;
    published_at: string | null;
    approved_at: string | null;
    created_at: string;
    error_reason: string | null;
    lead_id: string | null;
    company_id: string | null;
    contact_id: string | null;
    company_name: string | null;
    contact_name: string | null;
}

export interface GeneratedAssetsResponse {
    data: GeneratedAssetListItem[];
    pagination: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
        hasNext: boolean;
        hasPrev: boolean;
    };
}

export interface AssetSection {
    heading: string;
    body: string;
}

export interface AssetStructuredContent {
    title: string;
    subtitle?: string | null;
    summary: string;
    sections: AssetSection[];
    cta?: { label: string; url?: string | null } | null;
}

// Full asset detail (adds rendered_html + structured_content to the list item).
export interface GeneratedAssetDetail extends GeneratedAssetListItem {
    recipe_version: number;
    structured_content: AssetStructuredContent | null;
    rendered_html: string | null;
    rendered_html_key: string | null;
    access_slug: string | null;
    cta_url: string | null;
    booking_url: string | null;
    source_evidence_snapshot: Record<string, unknown>;
}

export interface GeneratedAssetDetailResponse {
    data: GeneratedAssetDetail;
}
