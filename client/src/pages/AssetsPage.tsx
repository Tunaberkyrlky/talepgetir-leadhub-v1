import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
    Badge,
    Button,
    Center,
    Container,
    Group,
    Loader,
    Modal,
    Pagination,
    Paper,
    Select,
    Stack,
    Table,
    Tabs,
    Text,
    Title,
} from '@mantine/core';
import {
    IconFileText, IconSparkles, IconEye, IconThumbUp, IconRocket, IconAlertTriangle,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { showSuccess, showErrorFromApi } from '../lib/notifications';
import type {
    AssetRecipe,
    AssetRecipesResponse,
    GeneratedAssetListItem,
    GeneratedAssetsResponse,
    GeneratedAssetDetailResponse,
} from '../types/asset';

type AssetTab = 'generated' | 'recipes';

const PAGE_LIMIT = 25;

const STATUS_COLOR: Record<string, string> = {
    queued: 'gray',
    generating: 'blue',
    generated: 'teal',
    failed: 'red',
};

interface CompanyOption { id: string; name: string }
interface CompaniesResponse { data: CompanyOption[] }

export default function AssetsPage() {
    const { t } = useTranslation();
    const { activeTenantId } = useAuth();
    const queryClient = useQueryClient();

    const [activeTab, setActiveTab] = useState<AssetTab>('generated');
    const [page, setPage] = useState(1);

    // Generate modal state
    const [generateRecipe, setGenerateRecipe] = useState<AssetRecipe | null>(null);
    const [companyId, setCompanyId] = useState<string | null>(null);
    // Preview modal state
    const [previewId, setPreviewId] = useState<string | null>(null);

    // Generated asset list (metadata only).
    const { data: assetData, isLoading, isError } = useQuery<GeneratedAssetsResponse>({
        queryKey: ['assets', activeTenantId, page],
        enabled: !!activeTenantId,
        queryFn: async () => {
            const res = await api.get('/assets', { params: { page, limit: PAGE_LIMIT } });
            return res.data as GeneratedAssetsResponse;
        },
        refetchInterval: 15_000,
    });

    // Recipe catalog.
    const { data: recipeData, isLoading: recipesLoading, isError: recipesError } = useQuery<AssetRecipesResponse>({
        queryKey: ['asset-recipes', activeTenantId],
        enabled: !!activeTenantId,
        queryFn: async () => {
            const res = await api.get('/assets/recipes');
            return res.data as AssetRecipesResponse;
        },
    });

    // Companies for the generate picker (loaded only while the modal is open).
    const { data: companyData } = useQuery<CompaniesResponse>({
        queryKey: ['assets-companies', activeTenantId],
        enabled: !!activeTenantId && !!generateRecipe,
        queryFn: async () => {
            const res = await api.get('/companies', { params: { page: 1 } });
            return { data: (res.data?.data ?? []) as CompanyOption[] };
        },
    });

    // Asset detail (rendered HTML) for the preview modal.
    const { data: detailData, isLoading: detailLoading } = useQuery<GeneratedAssetDetailResponse>({
        queryKey: ['asset-detail', activeTenantId, previewId],
        enabled: !!activeTenantId && !!previewId,
        queryFn: async () => {
            const res = await api.get(`/assets/${previewId}`);
            return res.data as GeneratedAssetDetailResponse;
        },
    });

    const generateMutation = useMutation({
        mutationFn: async ({ recipeId, company }: { recipeId: string; company: string }) => {
            await api.post('/assets/generate', { recipe_id: recipeId, company_id: company });
        },
        onSuccess: () => {
            showSuccess(t('assets.generateSuccess', 'Üretim başlatıldı'));
            setGenerateRecipe(null);
            setCompanyId(null);
            setActiveTab('generated');
            queryClient.invalidateQueries({ queryKey: ['assets', activeTenantId] });
        },
        onError: (err) => showErrorFromApi(err, t('assets.generateError', 'Üretim başlatılamadı')),
    });

    const approveMutation = useMutation({
        mutationFn: async (id: string) => { await api.post(`/assets/${id}/approve`); },
        onSuccess: () => {
            showSuccess(t('assets.approveSuccess', 'Onaylandı'));
            queryClient.invalidateQueries({ queryKey: ['assets', activeTenantId] });
        },
        onError: (err) => showErrorFromApi(err, t('assets.approveError', 'Onaylanamadı')),
    });

    const publishMutation = useMutation({
        mutationFn: async (id: string) => { await api.post(`/assets/${id}/publish`); },
        onSuccess: () => {
            showSuccess(t('assets.publishSuccess', 'Yayınlandı'));
            queryClient.invalidateQueries({ queryKey: ['assets', activeTenantId] });
        },
        onError: (err) => showErrorFromApi(err, t('assets.publishError', 'Yayınlanamadı')),
    });

    const assets = assetData?.data ?? [];
    const recipes = recipeData?.data ?? [];
    const totalPages = assetData?.pagination.totalPages ?? 1;
    const busy = approveMutation.isPending || publishMutation.isPending;

    const handleTab = (value: string | null) => {
        if (!value) return;
        setActiveTab(value as AssetTab);
    };

    const who = (a: GeneratedAssetListItem) =>
        a.company_name || a.contact_name || (
            <Text component="span" c="dimmed" fs="italic">{t('assets.noTarget', 'Hedef yok')}</Text>
        );

    const assetRows = assets.map((a) => (
        <Table.Tr key={a.id}>
            <Table.Td>
                <Text fw={500}>{a.recipe_name || a.recipe_id.slice(0, 8)}</Text>
                <Text size="xs" c="dimmed">v{a.recipe_version}</Text>
            </Table.Td>
            <Table.Td>{who(a)}</Table.Td>
            <Table.Td>
                <Badge variant="light" color={STATUS_COLOR[a.status] || 'gray'} size="sm">
                    {t(`assets.status.${a.status}`, a.status)}
                </Badge>
                {a.status === 'failed' && a.error_reason && (
                    <Text size="xs" c="red" lineClamp={1}>{a.error_reason}</Text>
                )}
            </Table.Td>
            <Table.Td>
                <Group gap={4}>
                    {a.published_at ? (
                        <Badge variant="light" color="green" size="sm">{t('assets.published', 'Yayında')}</Badge>
                    ) : a.approved_at ? (
                        <Badge variant="light" color="blue" size="sm">{t('assets.approved', 'Onaylı')}</Badge>
                    ) : (
                        <Badge variant="light" color="gray" size="sm">{t(`assets.delivery.${a.delivery_mode}`, a.delivery_mode)}</Badge>
                    )}
                </Group>
            </Table.Td>
            <Table.Td>
                <Group gap="xs" wrap="nowrap">
                    <Button
                        size="compact-xs" variant="light" leftSection={<IconEye size={14} />}
                        disabled={a.status !== 'generated'}
                        onClick={() => setPreviewId(a.id)}
                    >
                        {t('assets.actions.preview', 'Önizle')}
                    </Button>
                    <Button
                        size="compact-xs" variant="light" color="teal" leftSection={<IconThumbUp size={14} />}
                        disabled={a.status !== 'generated' || !!a.approved_at || busy}
                        loading={approveMutation.isPending && approveMutation.variables === a.id}
                        onClick={() => approveMutation.mutate(a.id)}
                    >
                        {t('assets.actions.approve', 'Onayla')}
                    </Button>
                    <Button
                        size="compact-xs" variant="light" color="green" leftSection={<IconRocket size={14} />}
                        disabled={!a.approved_at || !!a.published_at || busy}
                        loading={publishMutation.isPending && publishMutation.variables === a.id}
                        onClick={() => publishMutation.mutate(a.id)}
                    >
                        {t('assets.actions.publish', 'Yayınla')}
                    </Button>
                </Group>
            </Table.Td>
        </Table.Tr>
    ));

    const recipeRows = recipes.map((r) => (
        <Table.Tr key={r.id}>
            <Table.Td>
                <Text fw={500}>{r.name}</Text>
                {r.description && <Text size="xs" c="dimmed" lineClamp={1}>{r.description}</Text>}
            </Table.Td>
            <Table.Td>
                <Badge variant="light" color="grape" size="sm">{t(`assets.outputKind.${r.output_kind}`, r.output_kind)}</Badge>
            </Table.Td>
            <Table.Td>
                <Badge variant="light" color="gray" size="sm">{t(`assets.approvalPolicy.${r.approval_policy}`, r.approval_policy)}</Badge>
            </Table.Td>
            <Table.Td>
                <Badge variant="light" color={r.status === 'active' ? 'green' : 'gray'} size="sm">
                    {t(`assets.recipeStatus.${r.status}`, r.status)}
                </Badge>
            </Table.Td>
            <Table.Td>
                <Button
                    size="compact-xs" variant="light" leftSection={<IconSparkles size={14} />}
                    disabled={r.status !== 'active'}
                    onClick={() => { setGenerateRecipe(r); setCompanyId(null); }}
                >
                    {t('assets.actions.generate', 'Üret')}
                </Button>
            </Table.Td>
        </Table.Tr>
    ));

    const loading = activeTab === 'recipes' ? recipesLoading : isLoading;
    const errored = activeTab === 'recipes' ? recipesError : isError;
    const empty = activeTab === 'recipes' ? recipes.length === 0 : assets.length === 0;

    const companyOptions = (companyData?.data ?? []).map((c) => ({ value: c.id, label: c.name }));

    return (
        <Container size="xl" py="md">
            <Group gap="xs" mb="md">
                <IconFileText size={26} />
                <Title order={2}>{t('assets.title', 'Asset Stüdyosu')}</Title>
            </Group>

            <Tabs value={activeTab} onChange={handleTab}>
                <Tabs.List mb="md">
                    <Tabs.Tab value="generated" leftSection={<IconFileText size={16} />}>
                        {t('assets.tabs.generated', 'Üretilenler')}
                    </Tabs.Tab>
                    <Tabs.Tab value="recipes" leftSection={<IconSparkles size={16} />}>
                        {t('assets.tabs.recipes', 'Reçeteler')}
                    </Tabs.Tab>
                </Tabs.List>
            </Tabs>

            <Paper withBorder radius="md">
                {loading ? (
                    <Center py="xl"><Loader /></Center>
                ) : errored ? (
                    <Center py="xl"><Text c="red">{t('assets.loadError', 'Liste yüklenemedi')}</Text></Center>
                ) : empty ? (
                    <Center py="xl">
                        <Text c="dimmed">
                            {activeTab === 'recipes'
                                ? t('assets.recipesEmpty', 'Henüz reçete tanımlı değil')
                                : t('assets.empty', 'Henüz üretilmiş asset yok')}
                        </Text>
                    </Center>
                ) : activeTab === 'recipes' ? (
                    <Table.ScrollContainer minWidth={720}>
                        <Table verticalSpacing="sm" highlightOnHover>
                            <Table.Thead>
                                <Table.Tr>
                                    <Table.Th>{t('assets.col.recipe', 'Reçete')}</Table.Th>
                                    <Table.Th>{t('assets.col.output', 'Çıktı')}</Table.Th>
                                    <Table.Th>{t('assets.col.approval', 'Onay')}</Table.Th>
                                    <Table.Th>{t('assets.col.status', 'Durum')}</Table.Th>
                                    <Table.Th>{t('assets.col.action', 'İşlem')}</Table.Th>
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>{recipeRows}</Table.Tbody>
                        </Table>
                    </Table.ScrollContainer>
                ) : (
                    <Table.ScrollContainer minWidth={820}>
                        <Table verticalSpacing="sm" highlightOnHover>
                            <Table.Thead>
                                <Table.Tr>
                                    <Table.Th>{t('assets.col.recipe', 'Reçete')}</Table.Th>
                                    <Table.Th>{t('assets.col.target', 'Hedef')}</Table.Th>
                                    <Table.Th>{t('assets.col.status', 'Durum')}</Table.Th>
                                    <Table.Th>{t('assets.col.stage', 'Aşama')}</Table.Th>
                                    <Table.Th>{t('assets.col.action', 'İşlem')}</Table.Th>
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>{assetRows}</Table.Tbody>
                        </Table>
                    </Table.ScrollContainer>
                )}
            </Paper>

            {activeTab === 'generated' && totalPages > 1 && (
                <Group justify="center" mt="md">
                    <Pagination value={page} onChange={setPage} total={totalPages} />
                </Group>
            )}

            <Stack gap={4} mt="md">
                <Text size="xs" c="dimmed">
                    {t('assets.hint', 'Reçeteden bir firma için kişiselleştirilmiş asset üretin, önizleyin, onaylayıp yayınlayın.')}
                </Text>
            </Stack>

            {/* Generate modal */}
            <Modal
                opened={!!generateRecipe}
                onClose={() => setGenerateRecipe(null)}
                title={t('assets.generateTitle', 'Asset üret')}
                centered
            >
                <Stack>
                    <Text size="sm">
                        {t('assets.generateFor', 'Reçete')}: <b>{generateRecipe?.name}</b>
                    </Text>
                    <Select
                        label={t('assets.company', 'Firma')}
                        placeholder={t('assets.companyPlaceholder', 'Firma seçin')}
                        data={companyOptions}
                        value={companyId}
                        onChange={setCompanyId}
                        searchable
                        nothingFoundMessage={t('assets.noCompanies', 'Firma bulunamadı')}
                    />
                    <Group justify="flex-end">
                        <Button variant="default" onClick={() => setGenerateRecipe(null)}>
                            {t('assets.cancel', 'Vazgeç')}
                        </Button>
                        <Button
                            leftSection={<IconSparkles size={16} />}
                            loading={generateMutation.isPending}
                            disabled={!companyId}
                            onClick={() => generateRecipe && companyId && generateMutation.mutate({ recipeId: generateRecipe.id, company: companyId })}
                        >
                            {t('assets.actions.generate', 'Üret')}
                        </Button>
                    </Group>
                </Stack>
            </Modal>

            {/* Preview modal */}
            <Modal
                opened={!!previewId}
                onClose={() => setPreviewId(null)}
                title={t('assets.previewTitle', 'Önizleme')}
                size="xl"
                centered
            >
                {detailLoading ? (
                    <Center py="xl"><Loader /></Center>
                ) : detailData?.data.rendered_html ? (
                    <iframe
                        title={t('assets.previewTitle', 'Önizleme')}
                        srcDoc={detailData.data.rendered_html}
                        sandbox=""
                        style={{ width: '100%', height: '60vh', border: '1px solid var(--mantine-color-default-border)', borderRadius: 8 }}
                    />
                ) : (
                    <Center py="xl">
                        <Group gap="xs">
                            <IconAlertTriangle size={18} />
                            <Text c="dimmed">{t('assets.noPreview', 'Önizlenecek içerik yok')}</Text>
                        </Group>
                    </Center>
                )}
            </Modal>
        </Container>
    );
}
