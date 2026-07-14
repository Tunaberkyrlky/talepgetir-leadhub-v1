import { useEffect, useMemo } from 'react';
import {
    Alert,
    Anchor,
    Button,
    Group,
    Modal,
    NumberInput,
    Select,
    Stack,
    Textarea,
    TextInput,
} from '@mantine/core';
import { DateInput } from '@mantine/dates';
import { useForm } from '@mantine/form';
import { useMediaQuery } from '@mantine/hooks';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showErrorFromApi, showSuccess } from '../../lib/notifications';
import { useAuth } from '../../contexts/AuthContext';
import { useStages } from '../../contexts/StagesContext';
import OwnerSelect from '../OwnerSelect';
import type { Deal } from '../../types/deal';

interface DealContact {
    id: string;
    first_name: string;
    last_name?: string | null;
}

interface DealFormModalProps {
    opened: boolean;
    onClose: () => void;
    // Firma bağlamı sabit gelir (firsatlar firmaya bağlıdır).
    companyId: string;
    contacts?: DealContact[];
    // Düzenlemede mevcut firsat; oluşturmada null.
    deal?: Deal | null;
    // İlk-firsat CTA'sı firma stage'ini (slug) ön-doldurmak için geçirir.
    initialStageSlug?: string;
    onSuccess?: () => void;
}

// NumberInput değeri boşken '' döner; sunucuya number | null gönderilir.
function toAmount(value: number | string): number | null {
    if (value === '' || value === null || value === undefined) return null;
    const num = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(num) ? num : null;
}

export default function DealFormModal({
    opened,
    onClose,
    companyId,
    contacts = [],
    deal,
    initialStageSlug,
    onSuccess,
}: DealFormModalProps) {
    const { t } = useTranslation();
    const { user } = useAuth();
    const queryClient = useQueryClient();
    const {
        allStages,
        isLoading: stagesLoading,
        isError: stagesError,
        refetch: refetchStages,
        getStageLabel,
    } = useStages();
    const isMobile = useMediaQuery('(max-width: 48em)') ?? false;
    const isEdit = !!deal;

    // Stage seçenekleri id-değerli (kanonik). Düzenlemede firsatın mevcut stage'i aktif
    // listede yoksa (pasif/legacy stage) onu da ekle — aksi halde firsat düzenlenemez.
    const stageSelectData = useMemo(() => {
        const opts = allStages.map((s) => ({ value: s.id, label: getStageLabel(s.slug) }));
        if (deal?.stage_id && !allStages.some((s) => s.id === deal.stage_id)) {
            opts.push({ value: deal.stage_id, label: getStageLabel(deal.stage) });
        }
        return opts;
    }, [allStages, deal, getStageLabel]);

    const form = useForm({
        initialValues: {
            title: '',
            stage_id: '',
            amount: '' as number | string,
            currency: 'USD',
            expected_close: null as string | null,
            contact_id: '',
            description: '',
            owner: null as string | null,
        },
        validate: {
            title: (value) => value.trim()
                ? null
                : t('validation.required', { field: t('deals.title', 'Firsat') }),
            stage_id: (value) => value
                ? null
                : t('deals.stageRequired', 'Aşama seçin'),
            currency: (value) => /^[A-Z]{3}$/.test(value.trim())
                ? null
                : t('deals.currencyInvalid', '3 harfli para birimi kodu girin'),
        },
    });

    const mutation = useMutation({
        mutationFn: async (values: typeof form.values) => {
            const payload: Record<string, unknown> = {
                title: values.title.trim(),
                description: values.description.trim() || null,
                amount: toAmount(values.amount),
                currency: values.currency.trim().toUpperCase(),
                expected_close: values.expected_close || null,
                contact_id: values.contact_id || null,
            };

            if (deal) {
                // Stage yalnız gerçekten değiştiyse gönder. Değişmediyse (ör. pasif/legacy
                // stage'li firsat) payload'dan çıkar — böylece pasif stage yeniden doğrulanmaz.
                if (values.stage_id !== (deal.stage_id || '')) payload.stage_id = values.stage_id;
                // Sahip yalnız değiştiyse gönderilir (gereksiz yeniden-doğrulamayı önler).
                if ((values.owner || null) !== (deal.owner || null)) payload.owner = values.owner || null;
                return (await api.put(`/deals/${deal.id}`, payload)).data;
            }

            if (!values.stage_id) throw new Error(t('deals.stageRequired', 'Aşama seçin'));
            payload.stage_id = values.stage_id;
            payload.company_id = companyId;
            payload.owner = values.owner || null;
            return (await api.post('/deals', payload)).data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['deals'] });
            showSuccess(isEdit
                ? t('deals.updated', 'Firsat güncellendi')
                : t('deals.created', 'Firsat oluşturuldu'));
            onSuccess?.();
            onClose();
        },
        onError: (error) => showErrorFromApi(error),
    });

    useEffect(() => {
        if (!opened) return;
        if (deal) {
            form.setValues({
                title: deal.title,
                stage_id: deal.stage_id || '',
                amount: deal.amount ?? '',
                currency: deal.currency || 'USD',
                expected_close: deal.expected_close || null,
                contact_id: deal.contact_id || '',
                description: deal.description || '',
                owner: deal.owner ?? null,
            });
        } else {
            form.setValues({
                title: '',
                // İlk-firsat CTA'sı slug geçirir; kanonik id'ye çevir.
                stage_id: allStages.find((s) => s.slug === initialStageSlug)?.id || '',
                amount: '',
                currency: 'USD',
                expected_close: null,
                contact_id: '',
                description: '',
                // A2 owner sözleşmesi: oluşturan varsayılan sahiptir.
                owner: user?.id ?? null,
            });
        }
        form.resetDirty();
        // Yeni modal oturumunda önceki denemeden kalan doğrulama hataları ve mutasyon durumunu temizle.
        form.clearErrors();
        mutation.reset();
        // Mantine form yöntemleri stabil; form objesini bağımlılığa eklemek her render'da sıfırlar.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [opened, deal]);

    return (
        <Modal
            opened={opened}
            onClose={onClose}
            title={isEdit ? t('deals.edit', 'Firsatı düzenle') : t('deals.add', 'Firsat ekle')}
            size="md"
            radius={isMobile ? 0 : 'lg'}
            centered
            fullScreen={isMobile}
            overlayProps={{ backgroundOpacity: 0.4, blur: 4 }}
            styles={{ title: { fontWeight: 700, fontSize: '1.1rem' } }}
        >
            <form onSubmit={form.onSubmit((values) => mutation.mutate(values))}>
                <Stack gap="md">
                    <TextInput
                        label={t('deals.title', 'Firsat')}
                        placeholder={t('deals.titlePlaceholder', 'Örn. Yıllık lisans yenileme')}
                        required
                        autoFocus
                        radius="md"
                        {...form.getInputProps('title')}
                    />

                    {stagesError ? (
                        <Alert color="red" variant="light" title={t('deals.stageLoadError', 'Aşamalar yüklenemedi')}>
                            <Anchor component="button" type="button" size="sm" onClick={() => refetchStages()}>
                                {t('deals.retry', 'Tekrar dene')}
                            </Anchor>
                        </Alert>
                    ) : (
                        <Select
                            label={t('deals.stage', 'Aşama')}
                            placeholder={stagesLoading ? t('common.loading') : t('deals.selectStage', 'Aşama seçin')}
                            data={stageSelectData}
                            required
                            searchable
                            radius="md"
                            allowDeselect={false}
                            disabled={stagesLoading}
                            {...form.getInputProps('stage_id')}
                        />
                    )}

                    <Group grow align="flex-start">
                        <NumberInput
                            label={t('deals.amount', 'Tutar')}
                            placeholder="0"
                            min={0}
                            thousandSeparator=","
                            hideControls
                            radius="md"
                            {...form.getInputProps('amount')}
                        />
                        <TextInput
                            label={t('deals.currency', 'Para birimi')}
                            placeholder="USD"
                            maxLength={3}
                            radius="md"
                            {...form.getInputProps('currency')}
                            onChange={(e) => form.setFieldValue('currency', e.currentTarget.value.toUpperCase())}
                        />
                    </Group>

                    <Group grow align="flex-start">
                        <DateInput
                            label={t('deals.expectedClose', 'Tahmini kapanış')}
                            placeholder={t('deals.selectDate', 'Tarih seçin')}
                            valueFormat="DD MMM YYYY"
                            clearable
                            radius="md"
                            {...form.getInputProps('expected_close')}
                        />
                        <Select
                            label={t('deals.contact', 'İlgili kişi')}
                            placeholder={t('deals.selectContact', 'Kişi seçin (opsiyonel)')}
                            data={contacts.map((c) => ({
                                value: c.id,
                                label: [c.first_name, c.last_name].filter(Boolean).join(' '),
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
                        value={form.values.owner}
                        onChange={(val) => form.setFieldValue('owner', val)}
                        clearable
                    />

                    <Textarea
                        label={t('deals.description', 'Açıklama')}
                        placeholder={t('deals.descriptionPlaceholder', 'Firsat bağlamı, kapsam veya notlar')}
                        autosize
                        minRows={3}
                        maxRows={8}
                        radius="md"
                        {...form.getInputProps('description')}
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
