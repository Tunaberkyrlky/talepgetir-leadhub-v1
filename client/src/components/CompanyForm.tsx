import { useEffect, useState } from 'react';
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
    Divider,
    Alert,
} from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import { showSuccess, showErrorFromApi } from '../lib/notifications';
import { useStages } from '../contexts/StagesContext';
import EmailStatusIcon from './EmailStatusIcon';
import { useAuth } from '../contexts/AuthContext';
import { TERMINAL_STAGES } from '../lib/stages';

interface Company {
    id: string;
    name: string;
    website: string | null;
    location: string | null;
    industry: string | null;
    employee_size: string | null;
    product_services: string | null;
    product_portfolio: string | null;
    linkedin: string | null;
    company_phone: string | null;
    company_email: string | null;
    email_status: 'valid' | 'uncertain' | 'invalid' | null;
    stage: string;
    company_summary: string | null;
    next_step: string | null;
    fit_score: string | null;
    custom_field_1: string | null;
    custom_field_2: string | null;
    custom_field_3: string | null;
}

interface CompanyFormProps {
    opened: boolean;
    onClose: () => void;
    company: Company | null; // null = create mode
    onSuccess?: () => void;
    onTerminalStageSelected?: (companyId: string, companyName: string, targetStage: string) => void;
}

export default function CompanyForm({ opened, onClose, company, onSuccess, onTerminalStageSelected }: CompanyFormProps) {
    const { t } = useTranslation();
    const { user } = useAuth();
    const queryClient = useQueryClient();
    const isEdit = !!company;
    const [pendingTerminalStage, setPendingTerminalStage] = useState<string | null>(null);

    const form = useForm({
        initialValues: {
            name: '',
            website: '',
            location: '',
            industry: '',
            employee_size: '',
            product_services: '',
            product_portfolio: '',
            linkedin: '',
            company_phone: '',
            company_email: '',
            email_status: null as string | null,
            stage: 'cold',
            company_summary: '',
            next_step: '',
            fit_score: '',
            custom_field_1: '',
            custom_field_2: '',
            custom_field_3: '',
            // Contact fields (only used on create)
            contact_first_name: '',
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
                product_portfolio: company.product_portfolio || '',
                linkedin: company.linkedin || '',
                company_phone: company.company_phone || '',
                company_email: company.company_email || '',
                email_status: company.email_status || null,
                stage: company.stage || 'in_queue',
                company_summary: company.company_summary || '',
                next_step: company.next_step || '',
                fit_score: company.fit_score || '',
                custom_field_1: company.custom_field_1 || '',
                custom_field_2: company.custom_field_2 || '',
                custom_field_3: company.custom_field_3 || '',
                contact_first_name: '',
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
            queryClient.invalidateQueries({ queryKey: ['statistics'] });
            showSuccess(t('company.created'));
            onClose();
            form.reset();
        },
        onError: (err) => {
            showErrorFromApi(err);
        },
    });

    const updateMutation = useMutation({
        mutationFn: async (values: typeof form.values) => {
            // Strip contact fields on update, as we manage contacts separately
            const { contact_first_name: _cn, contact_title: _ct, contact_email: _ce, contact_phone_e164: _cp, ...updateValues } = values;
            const res = await api.put(`/companies/${company!.id}`, updateValues);
            return res.data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['companies'] });
            queryClient.invalidateQueries({ queryKey: ['statistics'] });
            showSuccess(t('company.updated'));
            onClose();
            onSuccess?.();
        },
        onError: (err) => {
            showErrorFromApi(err);
        },
    });

    const handleSubmit = form.onSubmit((values: typeof form.values) => {
        // If editing and a terminal stage is selected, delegate to parent instead of submitting
        if (isEdit && onTerminalStageSelected && TERMINAL_STAGES.includes(values.stage as any) && values.stage !== company?.stage) {
            onTerminalStageSelected(company!.id, company!.name, values.stage);
            return;
        }
        if (isEdit) {
            updateMutation.mutate(values);
        } else {
            createMutation.mutate(values);
        }
    });

    const isSaving = createMutation.isPending || updateMutation.isPending;

    const { stageOptions } = useStages();

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

                    {/* Row 4: Company Email + Email Status */}
                    <SimpleGrid cols={2}>
                        <TextInput
                            label={t('company.companyEmail')}
                            placeholder="info@company.com"
                            radius="md"
                            rightSection={
                                <EmailStatusIcon
                                    status={form.values.email_status as 'valid' | 'uncertain' | 'invalid' | null}
                                    size={18}
                                />
                            }
                            {...form.getInputProps('company_email')}
                        />
                        <Select
                            label={t('company.emailStatus')}
                            data={[
                                { value: 'valid', label: t('company.emailValid') },
                                { value: 'uncertain', label: t('company.emailUncertain') },
                                { value: 'invalid', label: t('company.emailInvalid') },
                            ]}
                            radius="md"
                            clearable
                            {...form.getInputProps('email_status')}
                        />
                    </SimpleGrid>

                    {/* Row 5: Stage + Location */}
                    <SimpleGrid cols={2}>
                        <Stack gap={4}>
                            <Select
                                label={t('company.stage')}
                                data={stageOptions}
                                radius="md"
                                {...form.getInputProps('stage')}
                                onChange={(val) => {
                                    form.setFieldValue('stage', val || 'cold');
                                    if (isEdit && val && TERMINAL_STAGES.includes(val as any) && val !== company?.stage) {
                                        setPendingTerminalStage(val);
                                    } else {
                                        setPendingTerminalStage(null);
                                    }
                                }}
                            />
                            {pendingTerminalStage && isEdit && onTerminalStageSelected && (
                                <Alert
                                    icon={<IconAlertTriangle size={14} />}
                                    color="orange"
                                    variant="light"
                                    radius="sm"
                                    py={4}
                                    px={8}
                                >
                                    <span style={{ fontSize: '0.78rem' }}>{t('activity.closingReport.required')}</span>
                                </Alert>
                            )}
                        </Stack>
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

                    {/* Product Portfolio */}
                    <TextInput
                        label={t('company.productPortfolio')}
                        placeholder={t('company.productPortfolio')}
                        radius="md"
                        {...form.getInputProps('product_portfolio')}
                    />

                    {/* Company Summary */}
                    <Textarea
                        label={t('company.companySummary')}
                        placeholder={t('company.companySummary')}
                        autosize
                        minRows={2}
                        radius="md"
                        {...form.getInputProps('company_summary')}
                    />

                    {/* Next Step */}
                    <TextInput
                        label={t('company.nextStep')}
                        placeholder="Follow up on Monday"
                        radius="md"
                        {...form.getInputProps('next_step')}
                    />

                    {/* Fit Score */}
                    <TextInput
                        label={t('company.fitScore')}
                        placeholder={t('company.fitScore')}
                        radius="md"
                        {...form.getInputProps('fit_score')}
                    />

                    {/* Custom Fields */}
                    <SimpleGrid cols={3}>
                        <Textarea
                            label={user?.tenantSettings?.custom_field_1_label || t('company.customField1', 'Özel Alan 1')}
                            autosize
                            minRows={2}
                            radius="md"
                            {...form.getInputProps('custom_field_1')}
                        />
                        <Textarea
                            label={user?.tenantSettings?.custom_field_2_label || t('company.customField2', 'Özel Alan 2')}
                            autosize
                            minRows={2}
                            radius="md"
                            {...form.getInputProps('custom_field_2')}
                        />
                        <Textarea
                            label={user?.tenantSettings?.custom_field_3_label || t('company.customField3', 'Özel Alan 3')}
                            autosize
                            minRows={2}
                            radius="md"
                            {...form.getInputProps('custom_field_3')}
                        />
                    </SimpleGrid>

                    {/* Contact Option (Create Only) */}
                    {!isEdit && (
                        <>
                            <Divider my="sm" />
                            <Title order={5} style={{ color: '#495057' }}>
                                {t('contact.addPrimaryContact')}
                            </Title>

                            <SimpleGrid cols={2}>
                                <TextInput
                                    label={t('contact.firstName')}
                                    placeholder="John"
                                    radius="md"
                                    {...form.getInputProps('contact_first_name')}
                                />
                                <TextInput
                                    label={t('contact.jobTitle')}
                                    placeholder="CEO"
                                    radius="md"
                                    {...form.getInputProps('contact_title')}
                                />
                            </SimpleGrid>

                            <SimpleGrid cols={2}>
                                <TextInput
                                    label={t('contact.emailAddress')}
                                    placeholder="john@example.com"
                                    radius="md"
                                    {...form.getInputProps('contact_email')}
                                />
                                <TextInput
                                    label={t('contact.phoneNumber')}
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
