import { useEffect } from 'react';
import { useForm } from '@mantine/form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
    Modal,
    TextInput,
    Textarea,
    Select,
    Button,
    Stack,
    Group,
    SimpleGrid,
    Title,
    Divider
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';

interface Company {
    id: string;
    name: string;
    website: string | null;
    location: string | null;
    industry: string | null;
    employee_size: string | null;
    product_services: string | null;
    description: string | null;
    linkedin: string | null;
    company_phone: string | null;
    stage: string;
    deal_summary: string | null;
    next_step: string | null;
}

interface CompanyFormProps {
    opened: boolean;
    onClose: () => void;
    company: Company | null; // null = create mode
}

const STAGES = [
    'in_queue', 'first_contact', 'connected', 'qualified',
    'in_meeting', 'follow_up', 'proposal_sent', 'negotiation',
    'won', 'lost', 'on_hold',
];

export default function CompanyForm({ opened, onClose, company }: CompanyFormProps) {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const isEdit = !!company;

    const form = useForm({
        initialValues: {
            name: '',
            website: '',
            location: '',
            industry: '',
            employee_size: '',
            product_services: '',
            description: '',
            linkedin: '',
            company_phone: '',
            stage: 'in_queue',
            deal_summary: '',
            next_step: '',
            // Contact fields (only used on create)
            contact_name: '',
            contact_title: '',
            contact_email: '',
            contact_phone_e164: '',
        },
        validate: {
            name: (value: string) => (value.trim().length > 0 ? null : t('company.name') + ' is required'),
        },
    });

    // Set form values when editing
    useEffect(() => {
        if (company) {
            form.setValues({
                name: company.name || '',
                website: company.website || '',
                location: company.location || '',
                industry: company.industry || '',
                employee_size: company.employee_size || '',
                product_services: company.product_services || '',
                description: company.description || '',
                linkedin: company.linkedin || '',
                company_phone: company.company_phone || '',
                stage: company.stage || 'in_queue',
                deal_summary: company.deal_summary || '',
                next_step: company.next_step || '',
                contact_name: '',
                contact_title: '',
                contact_email: '',
                contact_phone_e164: '',
            });
        } else {
            form.reset();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [company, opened]);

    const createMutation = useMutation({
        mutationFn: async (values: typeof form.values) => {
            const res = await api.post('/companies', values);
            return res.data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['companies'] });
            notifications.show({
                title: '✅',
                message: t('company.created'),
                color: 'green',
            });
            onClose();
            form.reset();
        },
        onError: () => {
            notifications.show({
                title: '❌',
                message: t('common.error'),
                color: 'red',
            });
        },
    });

    const updateMutation = useMutation({
        mutationFn: async (values: typeof form.values) => {
            // Strip contact fields on update, as we manage contacts separately
            const { contact_name: _cn, contact_title: _ct, contact_email: _ce, contact_phone_e164: _cp, ...updateValues } = values;
            const res = await api.put(`/companies/${company!.id}`, updateValues);
            return res.data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['companies'] });
            notifications.show({
                title: '✅',
                message: t('company.updated'),
                color: 'green',
            });
            onClose();
        },
        onError: () => {
            notifications.show({
                title: '❌',
                message: t('common.error'),
                color: 'red',
            });
        },
    });

    const handleSubmit = form.onSubmit((values: typeof form.values) => {
        if (isEdit) {
            updateMutation.mutate(values);
        } else {
            createMutation.mutate(values);
        }
    });

    const isSaving = createMutation.isPending || updateMutation.isPending;

    const stageOptions = STAGES.map((s) => ({
        value: s,
        label: t(`stages.${s}`),
    }));

    return (
        <Modal
            opened={opened}
            onClose={onClose}
            title={isEdit ? t('company.editTitle') : t('company.createTitle')}
            size="lg"
            radius="lg"
            centered
            overlayProps={{
                backgroundOpacity: 0.4,
                blur: 4,
            }}
            styles={{
                title: { fontWeight: 700, fontSize: '1.2rem' },
            }}
        >
            <form onSubmit={handleSubmit}>
                <Stack gap="md">
                    {/* Row 1: Name + Website */}
                    <SimpleGrid cols={2}>
                        <TextInput
                            label={t('company.name')}
                            required
                            radius="md"
                            {...form.getInputProps('name')}
                        />
                        <TextInput
                            label={t('company.website')}
                            placeholder="example.com"
                            radius="md"
                            {...form.getInputProps('website')}
                        />
                    </SimpleGrid>

                    {/* Row 2: Industry + Employee Size */}
                    <SimpleGrid cols={2}>
                        <TextInput
                            label={t('company.industry')}
                            placeholder="SaaS"
                            radius="md"
                            {...form.getInputProps('industry')}
                        />
                        <TextInput
                            label={t('company.employeeSize')}
                            placeholder="50-200"
                            radius="md"
                            {...form.getInputProps('employee_size')}
                        />
                    </SimpleGrid>

                    {/* Row 3: LinkedIn + Company Phone */}
                    <SimpleGrid cols={2}>
                        <TextInput
                            label={t('company.linkedin')}
                            placeholder="linkedin.com/company/..."
                            radius="md"
                            {...form.getInputProps('linkedin')}
                        />
                        <TextInput
                            label={t('company.companyPhone')}
                            placeholder="+90 212 000 0000"
                            radius="md"
                            {...form.getInputProps('company_phone')}
                        />
                    </SimpleGrid>

                    {/* Row 4: Stage + Location */}
                    <SimpleGrid cols={2}>
                        <Select
                            label={t('company.stage')}
                            data={stageOptions}
                            radius="md"
                            {...form.getInputProps('stage')}
                        />
                        <TextInput
                            label={t('company.location')}
                            placeholder="Istanbul"
                            radius="md"
                            {...form.getInputProps('location')}
                        />
                    </SimpleGrid>

                    {/* Product / Services */}
                    <TextInput
                        label={t('company.productServices')}
                        placeholder="CRM, ERP, ..."
                        radius="md"
                        {...form.getInputProps('product_services')}
                    />

                    {/* Description */}
                    <Textarea
                        label={t('company.description')}
                        placeholder={t('company.description')}
                        autosize
                        minRows={2}
                        radius="md"
                        {...form.getInputProps('description')}
                    />

                    {/* Deal Summary */}
                    <Textarea
                        label={t('company.dealSummary')}
                        placeholder={t('company.dealSummary')}
                        autosize
                        minRows={2}
                        radius="md"
                        {...form.getInputProps('deal_summary')}
                    />

                    {/* Next Step */}
                    <TextInput
                        label={t('company.nextStep')}
                        placeholder="Follow up on Monday"
                        radius="md"
                        {...form.getInputProps('next_step')}
                    />

                    {/* Contact Option (Create Only) */}
                    {!isEdit && (
                        <>
                            <Divider my="sm" />
                            <Title order={5} style={{ color: '#495057' }}>
                                Add Primary Contact (Optional)
                            </Title>

                            <SimpleGrid cols={2}>
                                <TextInput
                                    label="Contact Full Name"
                                    placeholder="John Doe"
                                    radius="md"
                                    {...form.getInputProps('contact_name')}
                                />
                                <TextInput
                                    label="Job Title"
                                    placeholder="CEO"
                                    radius="md"
                                    {...form.getInputProps('contact_title')}
                                />
                            </SimpleGrid>

                            <SimpleGrid cols={2}>
                                <TextInput
                                    label="Email Address"
                                    placeholder="john@example.com"
                                    radius="md"
                                    {...form.getInputProps('contact_email')}
                                />
                                <TextInput
                                    label="Phone Number"
                                    placeholder="+1234567890"
                                    radius="md"
                                    {...form.getInputProps('contact_phone_e164')}
                                />
                            </SimpleGrid>
                        </>
                    )}

                    {/* Actions */}
                    <Group justify="flex-end" mt="md">
                        <Button variant="default" radius="md" onClick={onClose}>
                            {t('common.cancel')}
                        </Button>
                        <Button
                            type="submit"
                            loading={isSaving}
                            radius="md"
                            gradient={{ from: '#6c63ff', to: '#3b82f6', deg: 135 }}
                            variant="gradient"
                        >
                            {t('common.save')}
                        </Button>
                    </Group>
                </Stack>
            </form>
        </Modal>
    );
}
