export type TaskStatus = 'pending' | 'completed' | 'cancelled';
export type TaskPriority = 'low' | 'normal' | 'high';

export interface CrmTask {
    id: string;
    tenant_id: string;
    company_id: string;
    contact_id: string | null;
    title: string;
    detail: string | null;
    status: TaskStatus;
    priority: TaskPriority;
    due_at: string;
    assigned_to: string | null;
    assigned_user: {
        id: string;
        email: string;
        name: string | null;
    } | null;
    company_name: string | null;
    company_stage: string | null;
    contact_name: string | null;
    completed_at: string | null;
    completed_by: string | null;
    created_by: string | null;
    created_at: string;
    updated_at: string;
}

export interface TasksResponse {
    data: CrmTask[];
    pagination: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
        hasNext: boolean;
        hasPrev: boolean;
    };
}

