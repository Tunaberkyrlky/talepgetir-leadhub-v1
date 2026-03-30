import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
    Stack, Alert, Select, Button, Group,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showSuccess, showErrorFromApi } from '../../lib/notifications';

interface AssignCompanyFormProps {
    replyId: string;
    onAssigned: () => void;
}

interface CompanyOption {
    id: string;
    name: string;
}

interface ContactOption {
    id: string;
    first_name: string;
    last_name: string | null;
}

export default function AssignCompanyForm({ replyId, onAssigned }: AssignCompanyFormProps) {
    const { t } = useTranslation();
    const queryClient = useQueryClient();

    const [companySearch, setCompanySearch] = useState('');
    const [debouncedCompanySearch] = useDebouncedValue(companySearch, 300);
    const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);

    const [contactSearch, setContactSearch] = useState('');
    const [debouncedContactSearch] = useDebouncedValue(contactSearch, 300);
    const [selectedContactId, setSelectedContactId] = useState<string | null>(null);

    // ── Company search query ──
    const { data: companies, isLoading: companiesLoading } = useQuery<CompanyOption[]>({
        queryKey: ['companies-search', debouncedCompanySearch],
        queryFn: async () => {
            const res = await api.get('/companies', {
                params: { search: debouncedCompanySearch, limit: 10 },
            });
            return res.data.data || res.data;
        },
        enabled: debouncedCompanySearch.length >= 2,
    });

    // ── Contact search query (only when company selected) ──
    const { data: contacts, isLoading: contactsLoading } = useQuery<ContactOption[]>({
        queryKey: ['contacts-search', selectedCompanyId, debouncedContactSearch],
        queryFn: async () => {
            const res = await api.get('/contacts', {
                params: { company_id: selectedCompanyId, limit: 10 },
            });
            return res.data.data || res.data;
        },
        enabled: !!selectedCompanyId,
    });

    // ── Assign mutation ──
    const assignMutation = useMutation({
        mutationFn: async () => {
            return (await api.patch(`/email-replies/${replyId}/assign`, {
                company_id: selectedCompanyId,
                contact_id: selectedContactId || null,
            })).data;
        },
        onSuccess: () => {
            showSuccess(t('emailReplies.assigned'));
            queryClient.invalidateQueries({ queryKey: ['email-replies'] });
            queryClient.invalidateQueries({ queryKey: ['email-replies-stats'] });
            onAssigned();
        },
        onError: (err) => {
            showErrorFromApi(err);
        },
    });

    // ── Select data ──
    const companySelectData = (companies || []).map((c) => ({
        value: c.id,
        label: c.name,
    }));

    const contactSelectData = (contacts || []).map((c) => ({
        value: c.id,
        label: [c.first_name, c.last_name].filter(Boolean).join(' '),
    }));

    return (
        <Stack gap="md">
            <Alert icon={<IconAlertTriangle size={16} />} color="yellow" variant="light">
                {t('emailReplies.assign.warning')}
            </Alert>

            <Select
                label={t('emailReplies.assign.title')}
                placeholder={t('emailReplies.assign.searchCompany')}
                searchable
                clearable
                data={companySelectData}
                value={selectedCompanyId}
                onChange={(v) => {
                    setSelectedCompanyId(v);
                    setSelectedContactId(null);
                }}
                onSearchChange={setCompanySearch}
                searchValue={companySearch}
                nothingFoundMessage={companiesLoading ? '...' : undefined}
            />

            <Select
                label={t('emailReplies.detail.contact')}
                placeholder={t('emailReplies.assign.searchContact')}
                searchable
                clearable
                disabled={!selectedCompanyId}
                data={contactSelectData}
                value={selectedContactId}
                onChange={setSelectedContactId}
                onSearchChange={setContactSearch}
                searchValue={contactSearch}
                nothingFoundMessage={contactsLoading ? '...' : undefined}
            />

            <Group justify="flex-end">
                <Button
                    onClick={() => assignMutation.mutate()}
                    loading={assignMutation.isPending}
                    disabled={!selectedCompanyId}
                    gradient={{ from: '#6c63ff', to: '#3b82f6', deg: 135 }}
                    variant="gradient"
                    radius="md"
                >
                    {t('emailReplies.assign.assignButton')}
                </Button>
            </Group>
        </Stack>
    );
}
