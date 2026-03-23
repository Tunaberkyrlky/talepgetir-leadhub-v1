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
    is_primary: boolean;
    notes: import('../types/contact').ContactNote[] | null;
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

export default function ContactForm({ opened, onClose, contact, defaultCompanyId }: ContactFormProps) {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const isEdit = !!contact;

    // Fetch company list for the selector
    const { data: companiesData } = useQuery({
        queryKey: ['companies-list-simple'],
        queryFn: () => api.get('/companies?limit=100&sortBy=name&sortOrder=asc').then((r) => r.data),
        enabled: opened,
    });

    const companyOptions = (companiesData?.data || []).map((c: any) => ({
        value: c.id,
        label: c.name,
    }));

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
            const payload = {
                ...values,
                last_name: values.last_name || null,
                title: values.title || null,
                seniority: values.seniority || null,
                country: values.country || null,
                email: values.email || null,
                phone_e164: values.phone_e164 || null,
                linkedin: values.linkedin || null,
            };
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
