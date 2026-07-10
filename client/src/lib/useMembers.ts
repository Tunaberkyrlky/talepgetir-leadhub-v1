import { useQuery } from '@tanstack/react-query';
import api from './api';
import { useAuth } from '../contexts/AuthContext';

export interface Member {
    id: string;
    name: string;
    email: string;
    role: string;
}

interface MembersResponse {
    members: Member[];
}

// Active members of the current tenant — the source of truth for every owner picker.
// Keyed by tenant so a tenant switch never shows the previous workspace's members.
export function useMembers() {
    const { activeTenantId } = useAuth();
    return useQuery<MembersResponse>({
        queryKey: ['tenant-members', activeTenantId],
        queryFn: async () => (await api.get('/tenants/members')).data,
        staleTime: 5 * 60_000,
    });
}
