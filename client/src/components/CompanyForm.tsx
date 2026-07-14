import { useEffect, useRef, useState } from 'react';
import { useForm } from '@mantine/form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
    Modal,
    TextInput,
    TagsInput,
    Textarea,
    Select,
    NumberInput,
    Button,
    Stack,
    Group,
    SimpleGrid,
    Title,
    Divider,
    Alert,
} from '@mantine/core';
import { COMPANY_PRIORITIES, QUALIFICATION_STATUSES } from '../lib/qualification';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import { showSuccess, showErrorFromApi } from '../lib/notifications';
import { useStages } from '../contexts/StagesContext';
import EmailStatusIcon from './EmailStatusIcon';
import OwnerSelect from './OwnerSelect';
import ReopenReasonModal from './ReopenReasonModal';
import { useAuth } from '../contexts/AuthContext';

/** Strip junk email placeholders (matches server-side sanitizeEmail) */
function sanitizeEmail(value: string | null | undefined): string {
    if (!value) return '';
    const trimmed = value.trim();
    if (!trimmed || /^[-–—_.\/\\()\s]+$/.test(trimmed) || /^n\/?a$/i.test(trimmed) || /^none$/i.test(trimmed) || /^yok$/i.test(trimmed)) return '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return '';
    return trimmed;
}

interface Company {
    id: string;
    name: string;
    website: string | null;
    location: string | null;
    industry: string | null;
    employee_size: string | null;
    product_services: string[] | null;
    product_portfolio: string[] | null;
    linkedin: string | null;
    company_phone: string | null;
    company_email: string | null;
    email_status: 'valid' | 'uncertain' | 'invalid' | null;
    stage: string;
    company_summary: string | null;
    next_step: string | null;
    fit_score: string | null;
    // Qualification (v2 Phase 6) — optional so callers with a narrower Company row
    // (e.g. LeadsPage) still satisfy this interface.
    lead_source?: string | null;
    priority?: 'low' | 'normal' | 'high' | null;
    qualification_status?: 'unqualified' | 'in_progress' | 'qualified' | 'disqualified' | null;
    fit_score_num?: number | null;
    competitor_notes?: string | null;
    objection_notes?: string | null;
    custom_field_1: string | null;
    custom_field_2: string | null;
    custom_field_3: string | null;
    assigned_to: string | null;
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
            product_services: [] as string[],
            product_portfolio: [] as string[],
            linkedin: '',
            company_phone: '',
            company_email: '',
            email_status: null as string | null,
            stage: 'cold',
            company_summary: '',
            next_step: '',
            fit_score: '',
            lead_source: '',
            priority: null as string | null,
            qualification_status: null as string | null,
            fit_score_num: '' as number | string,
            competitor_notes: '',
            objection_notes: '',
            custom_field_1: '',
            custom_field_2: '',
            custom_field_3: '',
            assigned_to: null as string | null,
            // Contact fields (only used on create)
            contact_first_name: '',
            contact_title: '',
            contact_email: '',
            contact_phone_e164: '',
        },
        validate: {
            name: (value: string) => (value.trim().length > 0 ? null : t('validation.required', { field: t('company.name') })),
        },
    });

    // Reopen: editing a currently-terminal company to a non-terminal stage requires a reason.
    // We hold the pending form values so the PUT still carries every other edit alongside the reason.
    const [pendingReopen, setPendingReopen] = useState<{ values: typeof form.values; targetLabel: string } | null>(null);

    // Set form values when editing
    useEffect(() => {
        if (company) {
            form.setValues({
                name: company.name || '',
                website: company.website || '',
                location: company.location || '',
                industry: company.industry || '',
                employee_size: company.employee_size || '',
                product_services: company.product_services ?? [],
                product_portfolio: company.product_portfolio ?? [],
                linkedin: company.linkedin || '',
                company_phone: company.company_phone || '',
                company_email: sanitizeEmail(company.company_email),
                email_status: company.email_status || null,
                stage: company.stage || 'cold',
                company_summary: company.company_summary || '',
                next_step: company.next_step || '',
                fit_score: company.fit_score || '',
                lead_source: company.lead_source || '',
                priority: company.priority ?? null,
                qualification_status: company.qualification_status ?? null,
                fit_score_num: company.fit_score_num ?? '',
                competitor_notes: company.competitor_notes || '',
                objection_notes: company.objection_notes || '',
                custom_field_1: company.custom_field_1 || '',
                custom_field_2: company.custom_field_2 || '',
                custom_field_3: company.custom_field_3 || '',
                assigned_to: company.assigned_to ?? null,
                contact_first_name: '',
                contact_title: '',
                contact_email: '',
                contact_phone_e164: '',
            });
        } else {
            form.reset();
            // Create: show the current user as the default owner, but keep the field pristine
            // so the payload omits assigned_to unless the user changes it (the server then
            // defaults to the creator). Clearing to empty becomes a deliberate "unassigned".
            form.setFieldValue('assigned_to', user?.id ?? null);
        }
        form.resetDirty();
        // Touched tracks edit INTENT (stays true even if the value returns to the
        // baseline), which the qualification omit below relies on — reset it per open.
        form.resetTouched();
        editedQualFields.current.clear();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [company, opened]);

    // Edit INTENT for qualification fields: Mantine marks a field touched on FOCUS,
    // so touched alone can't distinguish focus-then-blur from a deliberate clear.
    // Only a real onChange counts as intent; the omit logic below keys off this set.
    const editedQualFields = useRef(new Set<string>());
    const qualInputProps = (f: string) => {
        const p = form.getInputProps(f);
        return {
            ...p,
            onChange: (v: unknown) => {
                editedQualFields.current.add(f);
                p.onChange(v);
            },
        };
    };

    // NumberInput yields '' when empty — coerce to null (or a finite number) so the
    // server's z.number().int() never sees an empty string.
    const coerceFitScoreNum = (v: number | string | null | undefined): number | null =>
        v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v);

    const createMutation = useMutation({
        mutationFn: async (values: typeof form.values) => {
            const payload: Record<string, unknown> = { ...values, fit_score_num: coerceFitScoreNum(values.fit_score_num) };
            // Owner contract: omit assigned_to when the user never touched the picker so the
            // server assigns the creator; send an explicit value (member id, or null for the
            // unassigned queue) only when the user changed it.
            if (!form.isDirty('assigned_to')) delete payload.assigned_to;
            const res = await api.post('/companies', payload);
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
        mutationFn: async (values: typeof form.values & { reopen_reason?: string }) => {
            // Strip contact fields on update, as we manage contacts separately
            const { contact_first_name: _cn, contact_title: _ct, contact_email: _ce, contact_phone_e164: _cp, ...updateValues } = values;
            const payload: Record<string, unknown> = { ...updateValues, fit_score_num: coerceFitScoreNum(values.fit_score_num) };
            // Qualification fields (v2 Phase 6): when this edit was opened from a source that
            // does NOT project them (e.g. the ranked search_companies RPC → the prop field is
            // `undefined`) and the user never touched the input, OMIT the field so the PUT does
            // not blank out existing DB data with an empty default. Intent = a real
            // onChange (editedQualFields): touched fires on mere focus and dirty misses a
            // select-then-clear, so neither is a safe signal on its own.
            const qualFields = ['lead_source', 'priority', 'qualification_status', 'fit_score_num', 'competitor_notes', 'objection_notes'] as const;
            for (const f of qualFields) {
                if (company && company[f] === undefined && !editedQualFields.current.has(f)) {
                    delete payload[f];
                }
            }
            const res = await api.put(`/companies/${company!.id}`, payload);
            return res.data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['companies'] });
            queryClient.invalidateQueries({ queryKey: ['statistics'] });
            queryClient.invalidateQueries({ queryKey: ['pipeline'] });
            queryClient.invalidateQueries({ queryKey: ['activities'] });
            setPendingReopen(null);
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
        if (isEdit && onTerminalStageSelected && terminalStageSlugs.includes(values.stage) && values.stage !== company?.stage) {
            onTerminalStageSelected(company!.id, company!.name, values.stage);
            return;
        }
        // If editing a currently-terminal company to a non-terminal stage, ask a reopen reason first.
        if (isEdit && company && terminalStageSlugs.includes(company.stage) && !terminalStageSlugs.includes(values.stage) && values.stage !== company.stage) {
            setPendingReopen({ values, targetLabel: getStageLabel(values.stage) });
            return;
        }
        if (isEdit) {
            updateMutation.mutate(values);
        } else {
            createMutation.mutate(values);
        }
    });

    const isSaving = createMutation.isPending || updateMutation.isPending;

    const { stageOptions, terminalStageSlugs, getStageLabel } = useStages();

    return (
        <>
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
                                    if (isEdit && val && terminalStageSlugs.includes(val) && val !== company?.stage) {
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

                    {/* Owner (assigned_to) */}
                    <SimpleGrid cols={2}>
                        <OwnerSelect
                            label={t('owner.label')}
                            placeholder={isEdit ? t('owner.select') : t('owner.defaultsToYou')}
                            clearable
                            value={form.values.assigned_to}
                            onChange={(val) => form.setFieldValue('assigned_to', val)}
                        />
                    </SimpleGrid>

                    {/* Product / Services — list of categories (chips) */}
                    <TagsInput
                        label={t('company.productServices')}
                        placeholder="CRM, ERP, ..."
                        splitChars={[',', ';', '|']}
                        clearable
                        radius="md"
                        {...form.getInputProps('product_services')}
                    />

                    {/* Product Portfolio — list of categories (chips) */}
                    <TagsInput
                        label={t('company.productPortfolio')}
                        placeholder={t('company.productPortfolio')}
                        splitChars={[',', ';', '|']}
                        clearable
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

                    {/* Qualification (v2 Phase 6) */}
                    <Divider my="sm" label={t('qualification.sectionTitle')} labelPosition="left" />
                    <SimpleGrid cols={2}>
                        <TextInput
                            label={t('qualification.leadSource')}
                            placeholder={t('qualification.leadSourcePlaceholder')}
                            radius="md"
                            {...qualInputProps('lead_source')}
                        />
                        <NumberInput
                            label={t('qualification.fitScoreNum')}
                            placeholder="0 - 100"
                            min={0}
                            max={100}
                            allowDecimal={false}
                            clampBehavior="strict"
                            radius="md"
                            {...qualInputProps('fit_score_num')}
                        />
                        <Select
                            label={t('qualification.priority')}
                            placeholder={t('qualification.priorityPlaceholder')}
                            clearable
                            radius="md"
                            data={COMPANY_PRIORITIES.map((p) => ({ value: p, label: t(`qualification.priorityOptions.${p}`) }))}
                            {...qualInputProps('priority')}
                        />
                        <Select
                            label={t('qualification.status')}
                            placeholder={t('qualification.statusPlaceholder')}
                            clearable
                            radius="md"
                            data={QUALIFICATION_STATUSES.map((s) => ({ value: s, label: t(`qualification.statusOptions.${s}`) }))}
                            {...qualInputProps('qualification_status')}
                        />
                    </SimpleGrid>
                    <Textarea
                        label={t('qualification.competitorNotes')}
                        placeholder={t('qualification.competitorNotesPlaceholder')}
                        autosize
                        minRows={2}
                        radius="md"
                        {...qualInputProps('competitor_notes')}
                    />
                    <Textarea
                        label={t('qualification.objectionNotes')}
                        placeholder={t('qualification.objectionNotesPlaceholder')}
                        autosize
                        minRows={2}
                        radius="md"
                        {...qualInputProps('objection_notes')}
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
        {pendingReopen && company && (
            <ReopenReasonModal
                opened
                onClose={() => setPendingReopen(null)}
                companyName={company.name}
                targetStageLabel={pendingReopen.targetLabel}
                loading={updateMutation.isPending}
                onConfirm={(reason) => updateMutation.mutate({ ...pendingReopen.values, reopen_reason: reason })}
            />
        )}
        </>
    );
}
