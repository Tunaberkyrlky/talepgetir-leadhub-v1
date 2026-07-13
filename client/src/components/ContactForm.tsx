import { useEffect } from 'react';
import { useForm } from '@mantine/form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
    Modal,
    TextInput,
    Select,
    Checkbox,
    Button,
    Stack,
    Group,
    SimpleGrid,
} from '@mantine/core';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import { showSuccess, showErrorFromApi } from '../lib/notifications';
import { useAuth } from '../contexts/AuthContext';

interface Contact {
    id: string;
    company_id: string;
    first_name: string;
    last_name: string | null;
    title: string | null;
    seniority: string | null;
    country: string | null;
    email: string | null;
    phone_e164: string | null;
    linkedin: string | null;
    // Optional so callers that pass a partial contact (e.g. PersonDetailPage, which
    // does not project these) still satisfy the type; the form falls back to '' below.
    buying_role?: string | null;
    relationship_status?: string | null;
    preferred_channel?: string | null;
    is_primary: boolean;
    companies?: { id?: string; name: string } | null;
}

interface ContactFormProps {
    opened: boolean;
    onClose: () => void;
    contact: Contact | null; // null = create mode
    /** Pre-fill company_id (used when opening from CompanyDetailPage) */
    defaultCompanyId?: string;
}

const SENIORITY_OPTIONS = [
    'C-Suite', 'VP', 'Director', 'Manager', 'Senior', 'Mid-Level', 'Junior', 'Intern', 'Other',
];

// Contact-intelligence enum values (migration 134). Labels are resolved via i18n
// (contactIntel.*) at render time so the raw enum value is what gets persisted.
const BUYING_ROLE_VALUES = ['decision_maker', 'influencer', 'champion', 'user', 'blocker'];
const RELATIONSHIP_STATUS_VALUES = ['active', 'passive', 'left_company'];
const PREFERRED_CHANNEL_VALUES = ['email', 'phone', 'whatsapp', 'linkedin', 'other'];

export default function ContactForm({ opened, onClose, contact, defaultCompanyId }: ContactFormProps) {
    const { t } = useTranslation();
    const { activeTenantId } = useAuth();
    const queryClient = useQueryClient();
    const isEdit = !!contact;

    // Fetch company list for the selector. Tenant pinned to the query KEY (not the mutable
    // closure) so switching tenants refetches and never leaks a previous tenant's companies.
    const { data: companiesData } = useQuery({
        queryKey: ['companies-list-simple', activeTenantId],
        queryFn: async ({ queryKey, signal }) => {
            const tid = queryKey[1] as string;
            return (await api.get('/companies?limit=100&sortBy=name&sortOrder=asc', {
                headers: { 'X-Tenant-Id': tid },
                signal,
            })).data;
        },
        enabled: opened && !!activeTenantId,
    });

    const companyOptions = (() => {
        const list = (companiesData?.data || []).map((c: any) => ({ value: c.id, label: c.name }));
        // Seed the contact's current company so Select shows it before the list loads
        if (contact?.company_id && contact?.companies?.name) {
            const already = list.some((o: any) => o.value === contact.company_id);
            if (!already) list.unshift({ value: contact.company_id, label: contact.companies.name });
        }
        return list;
    })();

    const form = useForm({
        initialValues: {
            company_id: defaultCompanyId || '',
            first_name: '',
            last_name: '',
            title: '',
            seniority: '',
            country: '',
            email: '',
            phone_e164: '',
            linkedin: '',
            buying_role: '',
            relationship_status: '',
            preferred_channel: '',
            is_primary: false,
        },
        validate: {
            first_name: (v) => v.trim() ? null : t('contact.firstName') + ' required',
            company_id: (v) => v ? null : t('people.company') + ' required',
        },
    });

    useEffect(() => {
        if (opened) {
            if (contact) {
                form.setValues({
                    company_id: contact.company_id || '',
                    first_name: contact.first_name || '',
                    last_name: contact.last_name || '',
                    title: contact.title || '',
                    seniority: contact.seniority || '',
                    country: contact.country || '',
                    email: contact.email || '',
                    phone_e164: contact.phone_e164 || '',
                    linkedin: contact.linkedin || '',
                    buying_role: contact.buying_role || '',
                    relationship_status: contact.relationship_status || '',
                    preferred_channel: contact.preferred_channel || '',
                    is_primary: contact.is_primary || false,
                });
            } else {
                form.reset();
                if (defaultCompanyId) {
                    form.setFieldValue('company_id', defaultCompanyId);
                }
            }
        }
    }, [opened, contact, defaultCompanyId]);

    const mutation = useMutation({
        mutationFn: (values: typeof form.values) => {
            // Intel fields are handled explicitly below, so keep them out of the spread.
            const { buying_role, relationship_status, preferred_channel, ...rest } = values;
            void buying_role; void relationship_status; void preferred_channel;
            const payload: Record<string, unknown> = {
                ...rest,
                last_name: values.last_name || null,
                title: values.title || null,
                seniority: values.seniority || null,
                country: values.country || null,
                email: values.email || null,
                phone_e164: values.phone_e164 || null,
                linkedin: values.linkedin || null,
            };
            // Contact-intelligence fields (migration 134): when editing a contact whose
            // prop did NOT carry a field (e.g. opened from search_contacts / a partial
            // caller — `undefined`) and the user left the (blank) input untouched, OMIT
            // the field entirely so the PUT does not overwrite the existing DB value with
            // null. Otherwise send the value (a defined prop, or an explicit user edit).
            const intelFields = ['buying_role', 'relationship_status', 'preferred_channel'] as const;
            for (const f of intelFields) {
                if (isEdit && contact?.[f] === undefined && values[f] === '') continue;
                payload[f] = values[f] || null;
            }
            if (isEdit) {
                return api.put(`/contacts/${contact!.id}`, payload);
            }
            return api.post('/contacts', payload);
        },
        onSuccess: () => {
            showSuccess(isEdit ? t('contact.updated') : t('contact.created'));
            queryClient.invalidateQueries({ queryKey: ['contacts'] });
            queryClient.invalidateQueries({ queryKey: ['people'] });
            onClose();
        },
        onError: (err) => {
            showErrorFromApi(err);
        },
    });

    return (
        <Modal
            opened={opened}
            onClose={onClose}
            title={isEdit ? t('contact.editContact') : t('contact.addContact')}
            size="lg"
        >
            <form onSubmit={form.onSubmit((values) => mutation.mutate(values))}>
                <Stack>
                    <Select
                        label={t('people.company')}
                        data={companyOptions}
                        searchable
                        required
                        {...form.getInputProps('company_id')}
                        disabled={!!defaultCompanyId && !isEdit}
                    />

                    <SimpleGrid cols={2}>
                        <TextInput
                            label={t('contact.firstName')}
                            required
                            {...form.getInputProps('first_name')}
                        />
                        <TextInput
                            label={t('contact.lastName')}
                            {...form.getInputProps('last_name')}
                        />
                    </SimpleGrid>

                    <SimpleGrid cols={2}>
                        <TextInput
                            label={t('contact.title')}
                            {...form.getInputProps('title')}
                        />
                        <Select
                            label={t('contact.seniority')}
                            data={SENIORITY_OPTIONS}
                            clearable
                            {...form.getInputProps('seniority')}
                        />
                    </SimpleGrid>

                    <SimpleGrid cols={2}>
                        <TextInput
                            label={t('contact.country')}
                            {...form.getInputProps('country')}
                        />
                        <Select
                            label={t('contactIntel.buyingRole')}
                            data={BUYING_ROLE_VALUES.map((v) => ({ value: v, label: t(`contactIntel.buyingRoles.${v}`) }))}
                            clearable
                            {...form.getInputProps('buying_role')}
                        />
                    </SimpleGrid>

                    <SimpleGrid cols={2}>
                        <Select
                            label={t('contactIntel.relationshipStatus')}
                            data={RELATIONSHIP_STATUS_VALUES.map((v) => ({ value: v, label: t(`contactIntel.relationshipStatuses.${v}`) }))}
                            clearable
                            {...form.getInputProps('relationship_status')}
                        />
                        <Select
                            label={t('contactIntel.preferredChannel')}
                            data={PREFERRED_CHANNEL_VALUES.map((v) => ({ value: v, label: t(`contactIntel.preferredChannels.${v}`) }))}
                            clearable
                            {...form.getInputProps('preferred_channel')}
                        />
                    </SimpleGrid>

                    <SimpleGrid cols={2}>
                        <TextInput
                            label={t('contact.email')}
                            type="email"
                            {...form.getInputProps('email')}
                        />
                        <TextInput
                            label={t('contact.phone')}
                            placeholder="+90 555 123 4567"
                            {...form.getInputProps('phone_e164')}
                        />
                    </SimpleGrid>

                    <TextInput
                        label={t('contact.linkedin')}
                        placeholder="https://linkedin.com/in/..."
                        {...form.getInputProps('linkedin')}
                    />

                    <Checkbox
                        label={t('contact.isPrimary')}
                        {...form.getInputProps('is_primary', { type: 'checkbox' })}
                    />

                    <Group justify="flex-end">
                        <Button variant="default" onClick={onClose}>
                            {t('common.cancel')}
                        </Button>
                        <Button type="submit" loading={mutation.isPending}>
                            {t('common.save')}
                        </Button>
                    </Group>
                </Stack>
            </form>
        </Modal>
    );
}
