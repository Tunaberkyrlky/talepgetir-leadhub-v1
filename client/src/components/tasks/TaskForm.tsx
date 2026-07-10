import { useEffect, useState } from 'react';
import {
    Button,
    Combobox,
    Group,
    Input,
    InputBase,
    Loader,
    Modal,
    Select,
    Stack,
    Textarea,
    TextInput,
    useCombobox,
} from '@mantine/core';
import { DateTimePicker } from '@mantine/dates';
import { useForm } from '@mantine/form';
import { useDebouncedValue, useMediaQuery } from '@mantine/hooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showErrorFromApi, showSuccess } from '../../lib/notifications';
import { useAuth } from '../../contexts/AuthContext';
import OwnerSelect from '../OwnerSelect';
import type { CrmTask, TaskPriority } from '../../types/task';

interface TaskContact {
    id: string;
    first_name: string;
    last_name?: string | null;
}

interface TaskFormProps {
    opened: boolean;
    onClose: () => void;
    // Firma bağlamında (firma detayı, next-action paneli) sabit gelir.
    // Global oluşturmada boş bırakılır ve enableCompanyPicker ile firma seçtirilir.
    companyId?: string;
    enableCompanyPicker?: boolean;
    contacts?: TaskContact[];
    task?: CrmTask | null;
    onSuccess?: () => void;
}

function defaultDueDate(): Date {
    const due = new Date();
    due.setDate(due.getDate() + 1);
    due.setHours(9, 0, 0, 0);
    return due;
}

export default function TaskForm({
    opened,
    onClose,
    companyId,
    enableCompanyPicker = false,
    contacts = [],
    task,
    onSuccess,
}: TaskFormProps) {
    const { t } = useTranslation();
    const { user } = useAuth();
    const queryClient = useQueryClient();
    const isMobile = useMediaQuery('(max-width: 48em)') ?? false;
    const isEdit = !!task;
    // Firma seçici yalnız global oluşturmada (sabit companyId yokken) görünür.
    const showCompanyPicker = enableCompanyPicker && !companyId && !isEdit;

    const [selectedCompanyName, setSelectedCompanyName] = useState('');
    const [companySearch, setCompanySearch] = useState('');
    const [debouncedCompanySearch] = useDebouncedValue(companySearch, 250);
    const [companyDropdownOpened, setCompanyDropdownOpened] = useState(false);

    const companyCombobox = useCombobox({
        onDropdownOpen: () => setCompanyDropdownOpened(true),
        onDropdownClose: () => {
            setCompanyDropdownOpened(false);
            companyCombobox.resetSelectedOption();
        },
    });

    const { data: companyOptions, isLoading: companyOptionsLoading } = useQuery<{
        data: { id: string; name: string }[];
    }>({
        queryKey: ['task-company-picker', debouncedCompanySearch],
        queryFn: async () => {
            const params: Record<string, string> = { limit: '20' };
            if (debouncedCompanySearch.trim()) params.search = debouncedCompanySearch.trim();
            return (await api.get('/companies', { params })).data;
        },
        enabled: showCompanyPicker && companyDropdownOpened,
        staleTime: 30_000,
    });

    const form = useForm({
        initialValues: {
            title: '',
            detail: '',
            due_at: defaultDueDate(),
            priority: 'normal' as TaskPriority,
            contact_id: '',
            company_id: '',
            assigned_to: null as string | null,
        },
        validate: {
            title: (value) => value.trim()
                ? null
                : t('validation.required', { field: t('tasks.title', 'Görev') }),
            due_at: (value) => value && !Number.isNaN(new Date(value).getTime())
                ? null
                : t('tasks.dueRequired', 'Geçerli bir tarih ve saat seçin'),
            company_id: (value) => showCompanyPicker && !value
                ? t('tasks.companyRequired', 'Firma seçin')
                : null,
        },
    });

    useEffect(() => {
        if (!opened) return;
        setCompanySearch('');
        if (task) {
            form.setValues({
                title: task.title,
                detail: task.detail || '',
                due_at: new Date(task.due_at),
                priority: task.priority,
                contact_id: task.contact_id || '',
                company_id: task.company_id || '',
                assigned_to: task.assigned_to || null,
            });
            setSelectedCompanyName(task.company_name || '');
        } else {
            form.setValues({
                title: '',
                detail: '',
                due_at: defaultDueDate(),
                priority: 'normal',
                contact_id: '',
                company_id: '',
                assigned_to: user?.id ?? null,
            });
            setSelectedCompanyName('');
        }
        form.resetDirty();
        // Mantine form methods are stable and including the form object would reset on each render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [opened, task]);

    // If the auth user arrives after the create form opened, backfill the default owner —
    // but only while the field is still pristine so a manual pick is never clobbered.
    useEffect(() => {
        if (opened && !task && user?.id && !form.isDirty('assigned_to')) {
            form.setFieldValue('assigned_to', user.id);
            form.resetDirty();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user?.id, opened, task]);

    const mutation = useMutation({
        mutationFn: async (values: typeof form.values) => {
            const payload: Record<string, unknown> = {
                title: values.title.trim(),
                detail: values.detail.trim() || null,
                due_at: new Date(values.due_at).toISOString(),
                priority: values.priority,
                contact_id: values.contact_id || null,
            };
            // Only send assigned_to when it actually changed (or on create) — sending an
            // unchanged owner would needlessly re-validate a possibly-deactivated current owner.
            if (!task || (values.assigned_to || null) !== (task.assigned_to || null)) {
                payload.assigned_to = values.assigned_to || null;
            }
            if (task) return (await api.put(`/tasks/${task.id}`, payload)).data;
            return (await api.post('/tasks', {
                ...payload,
                company_id: values.company_id || companyId,
            })).data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['tasks'] });
            queryClient.invalidateQueries({ queryKey: ['pipeline'] });
            queryClient.invalidateQueries({ queryKey: ['dashboard-upcoming'] });
            showSuccess(isEdit
                ? t('tasks.updated', 'Görev güncellendi')
                : t('tasks.created', 'Görev oluşturuldu'));
            onSuccess?.();
            onClose();
        },
        onError: (error) => showErrorFromApi(error),
    });

    return (
        <Modal
            opened={opened}
            onClose={onClose}
            title={isEdit ? t('tasks.edit', 'Görevi düzenle') : t('tasks.add', 'Görev ekle')}
            size="md"
            radius={isMobile ? 0 : 'lg'}
            centered
            fullScreen={isMobile}
            overlayProps={{ backgroundOpacity: 0.4, blur: 4 }}
            styles={{ title: { fontWeight: 700, fontSize: '1.1rem' } }}
        >
            <form onSubmit={form.onSubmit((values) => mutation.mutate(values))}>
                <Stack gap="md">
                    {showCompanyPicker && (
                        <Combobox
                            store={companyCombobox}
                            withinPortal
                            onOptionSubmit={(val) => {
                                const picked = companyOptions?.data.find((c) => c.id === val);
                                if (picked) {
                                    form.setFieldValue('company_id', picked.id);
                                    setSelectedCompanyName(picked.name);
                                }
                                setCompanySearch('');
                                companyCombobox.closeDropdown();
                            }}
                        >
                            <Combobox.Target>
                                <InputBase
                                    component="button"
                                    type="button"
                                    pointer
                                    label={t('tasks.company', 'Firma')}
                                    required
                                    radius="md"
                                    rightSection={<Combobox.Chevron />}
                                    rightSectionPointerEvents="none"
                                    error={form.errors.company_id}
                                    onClick={() => companyCombobox.toggleDropdown()}
                                >
                                    {selectedCompanyName || (
                                        <Input.Placeholder>
                                            {t('tasks.selectCompany', 'Firma seçin')}
                                        </Input.Placeholder>
                                    )}
                                </InputBase>
                            </Combobox.Target>
                            <Combobox.Dropdown>
                                <Combobox.Search
                                    value={companySearch}
                                    onChange={(e) => setCompanySearch(e.currentTarget.value)}
                                    placeholder={t('tasks.searchCompanyPlaceholder', 'Firma ara...')}
                                />
                                <Combobox.Options mah={240} style={{ overflowY: 'auto' }}>
                                    {companyOptionsLoading ? (
                                        <Combobox.Empty>
                                            <Loader size="xs" color="violet" />
                                        </Combobox.Empty>
                                    ) : (companyOptions?.data?.length ?? 0) === 0 ? (
                                        <Combobox.Empty>
                                            {debouncedCompanySearch
                                                ? t('filter.noResults', 'Sonuç yok')
                                                : t('tasks.searchCompanyHint', 'Aramaya başlayın')}
                                        </Combobox.Empty>
                                    ) : (
                                        companyOptions!.data.map((c) => (
                                            <Combobox.Option value={c.id} key={c.id}>
                                                {c.name}
                                            </Combobox.Option>
                                        ))
                                    )}
                                </Combobox.Options>
                            </Combobox.Dropdown>
                        </Combobox>
                    )}

                    <TextInput
                        label={t('tasks.title', 'Yapılacak iş')}
                        placeholder={t('tasks.titlePlaceholder', 'Örn. Teklif hakkında takip araması yap')}
                        required
                        autoFocus={!showCompanyPicker}
                        radius="md"
                        {...form.getInputProps('title')}
                    />

                    <DateTimePicker
                        label={t('tasks.dueAt', 'Son tarih')}
                        required
                        radius="md"
                        valueFormat="DD MMM YYYY HH:mm"
                        {...form.getInputProps('due_at')}
                    />

                    <Group grow align="flex-start">
                        <Select
                            label={t('tasks.priority', 'Öncelik')}
                            data={[
                                { value: 'low', label: t('tasks.priorities.low', 'Düşük') },
                                { value: 'normal', label: t('tasks.priorities.normal', 'Normal') },
                                { value: 'high', label: t('tasks.priorities.high', 'Yüksek') },
                            ]}
                            radius="md"
                            allowDeselect={false}
                            {...form.getInputProps('priority')}
                        />

                        <Select
                            label={t('activities.contact', 'Kişi')}
                            placeholder={t('activities.selectContact', 'Kişi seçin (opsiyonel)')}
                            data={contacts.map((contact) => ({
                                value: contact.id,
                                label: [contact.first_name, contact.last_name].filter(Boolean).join(' '),
                            }))}
                            searchable
                            clearable
                            radius="md"
                            disabled={contacts.length === 0}
                            {...form.getInputProps('contact_id')}
                        />
                    </Group>

                    <OwnerSelect
                        label={t('owner.assignee')}
                        value={form.values.assigned_to}
                        onChange={(val) => form.setFieldValue('assigned_to', val)}
                    />

                    <Textarea
                        label={t('tasks.detail', 'Detay')}
                        placeholder={t('tasks.detailPlaceholder', 'Görüşme bağlamı veya yapılması gerekenler')}
                        autosize
                        minRows={3}
                        maxRows={8}
                        radius="md"
                        {...form.getInputProps('detail')}
                    />

                    <Group justify="flex-end" mt="xs">
                        <Button variant="default" radius="md" onClick={onClose}>
                            {t('common.cancel')}
                        </Button>
                        <Button type="submit" color="violet" radius="md" loading={mutation.isPending}>
                            {t('common.save')}
                        </Button>
                    </Group>
                </Stack>
            </form>
        </Modal>
    );
}
