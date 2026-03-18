import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
    Container,
    Title,
    Group,
    Button,
    Table,
    Badge,
    Text,
    Pagination,
    Stack,
    Paper,
    Flex,
    ActionIcon,
    Tooltip,
    Loader,
    Center,
    Box,
    TextInput,
    MultiSelect,
    UnstyledButton,
    Menu,
    Popover,
    Checkbox,
    Divider,
} from '@mantine/core';
import { useDebouncedValue, useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import {
    IconPlus,
    IconPencil,
    IconTrash,
    IconBuilding,
    IconFileImport,
    IconSearch,
    IconChevronUp,
    IconChevronDown,
    IconSelector,
    IconX,
    IconUsers,
    IconDotsVertical,
    IconAdjustments,
    IconGripVertical,
    IconArrowLeft,
    IconMap,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
    DndContext,
    closestCenter,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
    type DragEndEvent,
} from '@dnd-kit/core';
import {
    arrayMove,
    SortableContext,
    sortableKeyboardCoordinates,
    useSortable,
    verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import api from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { STAGES, stageColors } from '../lib/stages';
import type { Stage } from '../lib/stages';
import CompanyForm from '../components/CompanyForm';
import TruncatedText from '../components/TruncatedText';
import EmailStatusIcon from '../components/EmailStatusIcon';

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
    company_email: string | null;
    email_status: 'valid' | 'uncertain' | 'invalid' | null;
    stage: string;
    deal_summary: string | null;
    next_step: string | null;
    assigned_to: string | null;
    created_at: string;
    updated_at: string;
    contact_count: number;
}

interface PaginatedResponse {
    data: Company[];
    pagination: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
        hasNext: boolean;
        hasPrev: boolean;
    };
}

interface FilterOptions {
    stages: string[];
    industries: string[];
    locations: string[];
    products: string[];
}

// Sortable columns
type SortKey = 'name' | 'stage' | 'industry' | 'location' | 'updated_at' | 'created_at' | 'employee_size' | 'contact_count';

// All available column keys
type ColumnKey =
    | 'name' | 'website' | 'stage' | 'industry' | 'location'
    | 'employee_size' | 'product_services' | 'description'
    | 'linkedin' | 'company_phone' | 'company_email' | 'deal_summary'
    | 'next_step' | 'assigned_to' | 'contact_count'
    | 'created_at' | 'updated_at';

interface ColumnDef {
    key: ColumnKey;
    visible: boolean;
}

const COLUMNS_STORAGE_KEY = 'leads_columns_v2';

const DEFAULT_COLUMNS: ColumnDef[] = [
    { key: 'name', visible: true },
    { key: 'stage', visible: true },
    { key: 'industry', visible: true },
    { key: 'location', visible: true },
    { key: 'next_step', visible: true },
    { key: 'updated_at', visible: true },
    { key: 'website', visible: false },
    { key: 'employee_size', visible: false },
    { key: 'product_services', visible: false },
    { key: 'description', visible: false },
    { key: 'linkedin', visible: false },
    { key: 'company_phone', visible: false },
    { key: 'company_email', visible: false },
    { key: 'deal_summary', visible: false },
    { key: 'assigned_to', visible: false },
    { key: 'contact_count', visible: false },
    { key: 'created_at', visible: false },
];

const SORTABLE_COLUMNS: Set<string> = new Set([
    'name', 'stage', 'industry', 'location', 'updated_at', 'created_at', 'employee_size', 'contact_count',
]);

function loadColumnConfig(): ColumnDef[] {
    try {
        const stored = localStorage.getItem(COLUMNS_STORAGE_KEY);
        if (stored) {
            const parsed = JSON.parse(stored) as ColumnDef[];
            const keys = parsed.map(c => c.key);
            const missing = DEFAULT_COLUMNS.filter(c => !keys.includes(c.key));
            return [...parsed, ...missing];
        }
    } catch {}
    return DEFAULT_COLUMNS;
}

// Sortable column item for the popover
function SortableColumnItem({
    col,
    label,
    onToggle,
}: {
    col: ColumnDef;
    label: string;
    onToggle: () => void;
}) {
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging,
    } = useSortable({ id: col.key });

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
    };

    return (
        <Group ref={setNodeRef} style={style} justify="space-between" wrap="nowrap">
            <Group gap="xs" wrap="nowrap" style={{ flex: 1 }}>
                <Box
                    {...attributes}
                    {...listeners}
                    style={{ cursor: 'grab', display: 'flex', alignItems: 'center', touchAction: 'none' }}
                >
                    <IconGripVertical size={14} color="gray" />
                </Box>
                <Checkbox
                    checked={col.visible}
                    onChange={onToggle}
                    label={<Text size="sm">{label}</Text>}
                    size="xs"
                />
            </Group>
        </Group>
    );
}

export default function LeadsPage() {
    const { t } = useTranslation();
    const { user } = useAuth();
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const fromMap = searchParams.get('fromMap') === 'true';
    const [page, setPage] = useState(1);
    const [opened, { open, close }] = useDisclosure(false);
    const [editingCompany, setEditingCompany] = useState<Company | null>(null);

    // Search & filter state — initialise from URL param when coming from the map
    const [search, setSearch] = useState(() => searchParams.get('search') || '');
    const [debouncedSearch] = useDebouncedValue(search, 300);
    const [selectedStages, setSelectedStages] = useState<string[]>([]);
    const [selectedIndustries, setSelectedIndustries] = useState<string[]>([]);
    const [selectedLocations, setSelectedLocations] = useState<string[]>([]);
    const [selectedProducts, setSelectedProducts] = useState<string[]>([]);

    // Sort state
    const [sortBy, setSortBy] = useState<SortKey>('updated_at');
    const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

    // Column visibility state
    const [columns, setColumns] = useState<ColumnDef[]>(loadColumnConfig);
    const [colPopoverOpen, setColPopoverOpen] = useState(false);

    // Bulk selection state
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

    const isOpsOrAdmin = user?.role === 'superadmin' || user?.role === 'ops_agent';

    const toggleSelect = (id: string) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    // Clear selection when page/filters change
    useEffect(() => {
        setSelectedIds(new Set());
    }, [page, debouncedSearch, selectedStages, selectedIndustries, selectedLocations, selectedProducts]);

    // Bulk stage update mutation
    const bulkStageMutation = useMutation({
        mutationFn: async (stage: string) => {
            await api.patch('/companies/bulk-stage', { ids: Array.from(selectedIds), stage });
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['companies'] });
            queryClient.invalidateQueries({ queryKey: ['filterOptions'] });
            queryClient.invalidateQueries({ queryKey: ['statistics'] });
            setSelectedIds(new Set());
            notifications.show({ title: '✅', message: t('company.updated'), color: 'green' });
        },
        onError: () => {
            notifications.show({ title: '❌', message: t('common.error'), color: 'red' });
        },
    });

    const columnLabels: Record<ColumnKey, string> = {
        name: t('company.name'),
        website: t('company.website'),
        stage: t('company.stage'),
        industry: t('company.industry'),
        location: t('company.location'),
        employee_size: t('company.employeeSize'),
        product_services: t('company.productServices'),
        description: t('company.description'),
        linkedin: t('company.linkedin'),
        company_phone: t('company.companyPhone'),
        company_email: t('company.companyEmail'),
        deal_summary: t('company.dealSummary'),
        next_step: t('company.nextStep'),
        assigned_to: t('company.assignedTo'),
        contact_count: t('company.contactCount'),
        created_at: t('company.createdAt'),
        updated_at: t('company.updatedAt'),
    };

    const saveColumns = (cols: ColumnDef[]) => {
        setColumns(cols);
        localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(cols));
    };

    const toggleColumn = (key: ColumnKey) => {
        const visibleCount = columns.filter(c => c.visible).length;
        const col = columns.find(c => c.key === key);
        if (col?.visible && visibleCount <= 1) return;
        saveColumns(columns.map(c => c.key === key ? { ...c, visible: !c.visible } : c));
    };

    // DnD sensors
    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
    );

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;
        if (over && active.id !== over.id) {
            const oldIndex = columns.findIndex(c => c.key === active.id);
            const newIndex = columns.findIndex(c => c.key === over.id);
            saveColumns(arrayMove(columns, oldIndex, newIndex));
        }
    };

    const visibleColumns = columns.filter(c => c.visible);

    // Reset page when filters change
    useEffect(() => {
        setPage(1);
    }, [debouncedSearch, selectedStages, selectedIndustries, selectedLocations, selectedProducts]);

    // Fetch filter options
    const { data: filterOptions } = useQuery<FilterOptions>({
        queryKey: ['filterOptions'],
        queryFn: async () => {
            const res = await api.get('/filter-options');
            return res.data;
        },
    });

    // Build query params
    const buildQueryParams = useCallback(() => {
        const params = new URLSearchParams();
        params.set('page', String(page));
        params.set('limit', '25');
        params.set('sortBy', sortBy);
        params.set('sortOrder', sortOrder);
        if (debouncedSearch) params.set('search', debouncedSearch);
        if (selectedStages.length) params.set('stages', selectedStages.join(','));
        if (selectedIndustries.length) params.set('industries', selectedIndustries.join(','));
        if (selectedLocations.length) params.set('locations', selectedLocations.join(','));
        if (selectedProducts.length) params.set('products', selectedProducts.join(','));
        return params.toString();
    }, [page, sortBy, sortOrder, debouncedSearch, selectedStages, selectedIndustries, selectedLocations, selectedProducts]);

    // Fetch companies
    const { data, isLoading, error } = useQuery<PaginatedResponse>({
        queryKey: ['companies', page, debouncedSearch, selectedStages, selectedIndustries, selectedLocations, selectedProducts, sortBy, sortOrder],
        queryFn: async () => {
            const res = await api.get(`/companies?${buildQueryParams()}`);
            return res.data;
        },
    });

    // Bulk selection computed (after data query)
    const allOnPage = data?.data.map(c => c.id) || [];
    const allSelected = allOnPage.length > 0 && allOnPage.every(id => selectedIds.has(id));
    const someSelected = allOnPage.some(id => selectedIds.has(id));

    const toggleSelectAll = () => {
        if (allSelected) {
            setSelectedIds(new Set());
        } else {
            setSelectedIds(new Set(allOnPage));
        }
    };

    // Delete mutation
    const deleteMutation = useMutation({
        mutationFn: async (id: string) => {
            await api.delete(`/companies/${id}`);
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['companies'] });
            queryClient.invalidateQueries({ queryKey: ['statistics'] });
            notifications.show({ title: '✅', message: t('company.deleted'), color: 'green' });
        },
        onError: () => {
            notifications.show({ title: '❌', message: t('common.error'), color: 'red' });
        },
    });

    const handleEdit = (company: Company) => { setEditingCompany(company); open(); };
    const handleCreate = () => { setEditingCompany(null); open(); };
    const handleFormClose = () => { setEditingCompany(null); close(); };
    const handleDelete = (company: Company) => {
        if (window.confirm(t('company.deleteConfirm'))) deleteMutation.mutate(company.id);
    };

    const handleSort = (key: SortKey) => {
        if (sortBy === key) {
            setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
        } else {
            setSortBy(key);
            setSortOrder('asc');
        }
        setPage(1);
    };

    const formatDate = (dateStr: string) => {
        return new Date(dateStr).toLocaleDateString(undefined, {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        });
    };

    const hasActiveFilters = !!(debouncedSearch || selectedStages.length || selectedIndustries.length || selectedLocations.length || selectedProducts.length);

    const clearAllFilters = () => {
        setSearch('');
        setSelectedStages([]);
        setSelectedIndustries([]);
        setSelectedLocations([]);
        setSelectedProducts([]);
    };

    // Sort header component
    const SortHeader = ({ column, label }: { column: SortKey; label: string }) => {
        const isSorted = sortBy === column;
        const Icon = isSorted
            ? (sortOrder === 'asc' ? IconChevronUp : IconChevronDown)
            : IconSelector;

        return (
            <UnstyledButton
                onClick={() => handleSort(column)}
                style={{ display: 'flex', alignItems: 'center', gap: 4 }}
            >
                <Text size="xs" fw={600} tt="uppercase" style={{ letterSpacing: '0.5px', color: 'white' }}>
                    {label}
                </Text>
                <Icon size={14} color={isSorted ? '#a78bfa' : 'rgba(255,255,255,0.5)'} />
            </UnstyledButton>
        );
    };

    const NonSortHeader = ({ label }: { label: string }) => (
        <Text size="xs" fw={600} tt="uppercase" c="white" style={{ letterSpacing: '0.5px' }}>
            {label}
        </Text>
    );

    const renderColumnHeader = (key: ColumnKey) => {
        const label = columnLabels[key];
        if (SORTABLE_COLUMNS.has(key)) {
            return <Table.Th key={key}><SortHeader column={key as SortKey} label={label} /></Table.Th>;
        }
        return <Table.Th key={key}><NonSortHeader label={label} /></Table.Th>;
    };

    const renderColumnCell = (key: ColumnKey, company: Company) => {
        switch (key) {
            case 'name':
                return (
                    <Table.Td key="name">
                        <Group gap="xs">
                            <Text fw={600} size="sm">{company.name}</Text>
                            {company.contact_count > 0 && (
                                <Tooltip label={`${company.contact_count} ${t('company.contactCount').toLowerCase()}`} withArrow>
                                    <Badge
                                        size="xs"
                                        variant="light"
                                        color="violet"
                                        leftSection={<IconUsers size={10} />}
                                        style={{ cursor: 'default' }}
                                    >
                                        {company.contact_count}
                                    </Badge>
                                </Tooltip>
                            )}
                        </Group>
                    </Table.Td>
                );
            case 'website':
                return (
                    <Table.Td key="website">
                        <Text size="xs" c="dimmed" lineClamp={1}>{company.website || '—'}</Text>
                    </Table.Td>
                );
            case 'stage':
                return (
                    <Table.Td key="stage">
                        <Badge
                            color={stageColors[company.stage as keyof typeof stageColors] || 'gray'}
                            variant="light"
                            size="sm"
                            radius="sm"
                        >
                            {t(`stages.${company.stage}`)}
                        </Badge>
                    </Table.Td>
                );
            case 'industry':
                return <Table.Td key="industry"><TruncatedText size="sm">{company.industry}</TruncatedText></Table.Td>;
            case 'location':
                return <Table.Td key="location"><TruncatedText size="sm">{company.location}</TruncatedText></Table.Td>;
            case 'employee_size':
                return <Table.Td key="employee_size"><TruncatedText size="sm">{company.employee_size}</TruncatedText></Table.Td>;
            case 'product_services':
                return (
                    <Table.Td key="product_services">
                        <TruncatedText size="sm">{company.product_services}</TruncatedText>
                    </Table.Td>
                );
            case 'description':
                return (
                    <Table.Td key="description">
                        <TruncatedText size="sm">{company.description}</TruncatedText>
                    </Table.Td>
                );
            case 'linkedin':
                return (
                    <Table.Td key="linkedin">
                        <TruncatedText size="xs" c="dimmed">{company.linkedin}</TruncatedText>
                    </Table.Td>
                );
            case 'company_phone':
                return <Table.Td key="company_phone"><TruncatedText size="sm">{company.company_phone}</TruncatedText></Table.Td>;
            case 'company_email':
                return (
                    <Table.Td key="company_email">
                        {company.company_email ? (
                            <Group gap={4} wrap="nowrap">
                                <Text size="sm" lineClamp={1}>{company.company_email}</Text>
                                <EmailStatusIcon status={company.email_status} style={{ flexShrink: 0 }} />
                            </Group>
                        ) : (
                            <Text size="sm" c="dimmed">—</Text>
                        )}
                    </Table.Td>
                );
            case 'deal_summary':
                return (
                    <Table.Td key="deal_summary">
                        <TruncatedText size="sm">{company.deal_summary}</TruncatedText>
                    </Table.Td>
                );
            case 'next_step':
                return (
                    <Table.Td key="next_step">
                        <TruncatedText size="sm">{company.next_step}</TruncatedText>
                    </Table.Td>
                );
            case 'assigned_to':
                return <Table.Td key="assigned_to"><TruncatedText size="sm">{company.assigned_to}</TruncatedText></Table.Td>;
            case 'contact_count':
                return (
                    <Table.Td key="contact_count">
                        <Badge size="sm" variant="light" color="violet">{company.contact_count}</Badge>
                    </Table.Td>
                );
            case 'created_at':
                return (
                    <Table.Td key="created_at">
                        <Text size="xs" c="dimmed">{formatDate(company.created_at)}</Text>
                    </Table.Td>
                );
            case 'updated_at':
                return (
                    <Table.Td key="updated_at">
                        <Text size="xs" c="dimmed">{formatDate(company.updated_at)}</Text>
                    </Table.Td>
                );
        }
    };

    // Stage options for multi-select
    const stageOptions = (filterOptions?.stages || []).map((s) => ({
        value: s, label: t(`stages.${s}`),
    }));
    const industryOptions = (filterOptions?.industries || []).map((s) => ({
        value: s, label: s,
    }));
    const locationOptions = (filterOptions?.locations || []).map((s) => ({
        value: s, label: s,
    }));
    const productOptions = (filterOptions?.products || []).map((s) => ({
        value: s, label: s,
    }));

    if (error) {
        return (
            <Container size="xl" py="xl">
                <Center>
                    <Stack align="center">
                        <Text c="red">{t('common.error')}</Text>
                        <Button variant="light" onClick={() => queryClient.invalidateQueries({ queryKey: ['companies'] })}>
                            {t('common.retry')}
                        </Button>
                    </Stack>
                </Center>
            </Container>
        );
    }

    return (
        <Container size="xl" py="lg">
            {/* Back to map banner */}
            {fromMap && (
                <Group mb="md" gap="xs">
                    <Button
                        leftSection={<IconArrowLeft size={16} />}
                        variant="light"
                        color="violet"
                        radius="md"
                        size="sm"
                        onClick={() => navigate('/')}
                    >
                        <IconMap size={14} style={{ marginRight: 4 }} />
                        {t('dashboard.companyLocations')}
                    </Button>
                    {search && (
                        <Badge variant="light" color="blue" size="md" radius="md">
                            {search}
                        </Badge>
                    )}
                </Group>
            )}
            {/* Header */}
            <Flex justify="space-between" align="center" mb="lg">
                <Title order={2} fw={700}>
                    {t('leads.title')}
                </Title>
                {isOpsOrAdmin && (
                    <Group>
                        <Button
                            leftSection={<IconFileImport size={18} />}
                            onClick={() => navigate('/import')}
                            variant="light"
                            color="violet"
                            radius="md"
                        >
                            {t('leads.importData')}
                        </Button>
                        <Button
                            leftSection={<IconPlus size={18} />}
                            onClick={handleCreate}
                            gradient={{ from: '#6c63ff', to: '#3b82f6', deg: 135 }}
                            variant="gradient"
                            radius="md"
                        >
                            {t('leads.addCompany')}
                        </Button>
                    </Group>
                )}
            </Flex>

            {/* Search & Filters */}
            <Paper shadow="sm" radius="lg" p="md" mb="md" withBorder>
                <Group grow>
                    <TextInput
                        placeholder={t('leads.search')}
                        leftSection={<IconSearch size={16} />}
                        value={search}
                        onChange={(e) => setSearch(e.currentTarget.value)}
                        radius="md"
                        rightSection={search && (
                            <ActionIcon variant="subtle" size="sm" onClick={() => setSearch('')}>
                                <IconX size={14} />
                            </ActionIcon>
                        )}
                    />
                    <MultiSelect
                        placeholder={t('filter.stage')}
                        data={stageOptions}
                        value={selectedStages}
                        onChange={setSelectedStages}
                        clearable
                        radius="md"
                        maxDropdownHeight={200}
                    />
                    <MultiSelect
                        placeholder={t('filter.industry')}
                        data={industryOptions}
                        value={selectedIndustries}
                        onChange={setSelectedIndustries}
                        clearable
                        radius="md"
                        maxDropdownHeight={200}
                    />
                    <MultiSelect
                        placeholder={t('filter.location')}
                        data={locationOptions}
                        value={selectedLocations}
                        onChange={setSelectedLocations}
                        clearable
                        radius="md"
                        maxDropdownHeight={200}
                    />
                    <MultiSelect
                        placeholder={t('filter.product')}
                        data={productOptions}
                        value={selectedProducts}
                        onChange={setSelectedProducts}
                        clearable
                        searchable
                        radius="md"
                        maxDropdownHeight={200}
                    />
                </Group>
                {hasActiveFilters && (
                    <Group mt="xs">
                        <Button
                            variant="subtle"
                            color="gray"
                            size="xs"
                            leftSection={<IconX size={14} />}
                            onClick={clearAllFilters}
                        >
                            {t('filter.clearAll')}
                        </Button>
                        {data && (
                            <Text size="xs" c="dimmed">
                                {data.pagination.total} {t('filter.results')}
                            </Text>
                        )}
                    </Group>
                )}
            </Paper>

            {/* Bulk Action Bar */}
            {selectedIds.size > 0 && (
                <Paper shadow="md" radius="lg" p="xs" px="md" mb="md" withBorder
                    style={{ background: 'var(--mantine-color-violet-light)', border: '1px solid var(--mantine-color-violet-3)' }}
                >
                    <Group justify="space-between">
                        <Group gap="sm">
                            <Text size="sm" fw={600}>
                                {selectedIds.size} {t('bulk.selected')}
                            </Text>
                            <Button variant="subtle" color="gray" size="xs" onClick={() => setSelectedIds(new Set())}>
                                {t('bulk.clearSelection')}
                            </Button>
                        </Group>
                        <Group gap="xs">
                            <Text size="sm" fw={500} c="dimmed">{t('bulk.moveTo')}</Text>
                            {STAGES.map((stage) => (
                                <Button
                                    key={stage}
                                    size="compact-xs"
                                    variant="light"
                                    color={stageColors[stage as Stage] || 'gray'}
                                    onClick={() => bulkStageMutation.mutate(stage)}
                                    loading={bulkStageMutation.isPending}
                                    radius="sm"
                                >
                                    {t(`stages.${stage}`)}
                                </Button>
                            ))}
                        </Group>
                    </Group>
                </Paper>
            )}

            {/* Table */}
            <Paper shadow="sm" radius="lg" withBorder style={{ overflow: 'hidden' }}>
                {isLoading ? (
                    <Center py={80}>
                        <Loader size="lg" color="violet" />
                    </Center>
                ) : data?.data.length === 0 ? (
                    <Center py={80}>
                        <Stack align="center" gap="sm">
                            <IconBuilding size={48} color="#ccc" />
                            <Text fw={500} size="lg" c="dimmed">
                                {hasActiveFilters ? t('filter.noResults') : t('leads.noData')}
                            </Text>
                            <Text size="sm" c="dimmed">
                                {hasActiveFilters ? t('filter.tryDifferent') : t('leads.noDataDescription')}
                            </Text>
                        </Stack>
                    </Center>
                ) : (
                    <>
                        <Table.ScrollContainer minWidth={800}>
                        <Table
                            striped
                            highlightOnHover
                            verticalSpacing="sm"
                            horizontalSpacing="md"
                            styles={{
                                thead: {
                                    background: 'linear-gradient(135deg, #1a1b2e 0%, #16213e 100%)',
                                },
                                th: {
                                    fontWeight: 600,
                                    fontSize: '0.85rem',
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.5px',
                                    padding: '12px 16px',
                                    whiteSpace: 'nowrap',
                                },
                            }}
                        >
                            <Table.Thead>
                                <Table.Tr>
                                    <Table.Th style={{ width: 48, padding: '0 8px' }}>
                                        {someSelected ? (
                                            <Checkbox
                                                checked={allSelected}
                                                indeterminate={someSelected && !allSelected}
                                                onChange={toggleSelectAll}
                                                size="sm"
                                                color="violet"
                                                styles={{ input: { cursor: 'pointer' }, root: { padding: 4 } }}
                                            />
                                        ) : (
                                            <Box style={{ width: 20, height: 20 }} />
                                        )}
                                    </Table.Th>
                                    {visibleColumns.map(col => renderColumnHeader(col.key))}
                                    <Table.Th style={{ width: 40, padding: '0 4px' }}>
                                        <Popover
                                            opened={colPopoverOpen}
                                            onChange={setColPopoverOpen}
                                            position="bottom-end"
                                            shadow="md"
                                            withArrow
                                        >
                                            <Popover.Target>
                                                <Tooltip label={t('leads.editColumns')} withArrow position="left">
                                                    <ActionIcon
                                                        variant="subtle"
                                                        size="sm"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            setColPopoverOpen(o => !o);
                                                        }}
                                                        style={{ color: 'rgba(255,255,255,0.6)' }}
                                                    >
                                                        <IconAdjustments size={16} />
                                                    </ActionIcon>
                                                </Tooltip>
                                            </Popover.Target>
                                            <Popover.Dropdown p="sm" style={{ minWidth: 240 }}>
                                                <Text size="xs" fw={700} tt="uppercase" c="dimmed" mb="xs" style={{ letterSpacing: '0.5px' }}>
                                                    {t('leads.columns')}
                                                </Text>
                                                <Divider mb="xs" />
                                                <DndContext
                                                    sensors={sensors}
                                                    collisionDetection={closestCenter}
                                                    onDragEnd={handleDragEnd}
                                                >
                                                    <SortableContext
                                                        items={columns.map(c => c.key)}
                                                        strategy={verticalListSortingStrategy}
                                                    >
                                                        <Stack gap={6}>
                                                            {columns.map((col) => (
                                                                <SortableColumnItem
                                                                    key={col.key}
                                                                    col={col}
                                                                    label={columnLabels[col.key]}
                                                                    onToggle={() => toggleColumn(col.key)}
                                                                />
                                                            ))}
                                                        </Stack>
                                                    </SortableContext>
                                                </DndContext>
                                                <Divider mt="xs" mb="xs" />
                                                <Button
                                                    size="xs"
                                                    variant="subtle"
                                                    color="gray"
                                                    fullWidth
                                                    onClick={() => saveColumns(DEFAULT_COLUMNS)}
                                                >
                                                    {t('leads.resetColumns')}
                                                </Button>
                                            </Popover.Dropdown>
                                        </Popover>
                                    </Table.Th>
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>
                                {data?.data.map((company) => (
                                    <Table.Tr
                                        key={company.id}
                                        style={{
                                            cursor: 'pointer',
                                            background: selectedIds.has(company.id) ? 'var(--mantine-color-violet-light)' : undefined,
                                        }}
                                        onClick={() => navigate(`/companies/${company.id}`)}
                                    >
                                        <Table.Td
                                            style={{ width: 48, padding: '0 8px' }}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                toggleSelect(company.id);
                                            }}
                                        >
                                            <Checkbox
                                                checked={selectedIds.has(company.id)}
                                                onChange={() => toggleSelect(company.id)}
                                                onClick={(e) => e.stopPropagation()}
                                                size="sm"
                                                color="violet"
                                                styles={{ input: { cursor: 'pointer' }, root: { padding: 4 } }}
                                            />
                                        </Table.Td>
                                        {visibleColumns.map(col => renderColumnCell(col.key, company))}
                                        <Table.Td style={{ padding: '0 4px' }}>
                                            {isOpsOrAdmin && (
                                                <Menu withinPortal position="bottom-end" shadow="sm">
                                                    <Menu.Target>
                                                        <ActionIcon
                                                            variant="subtle"
                                                            color="gray"
                                                            onClick={(e) => e.stopPropagation()}
                                                        >
                                                            <IconDotsVertical size={16} />
                                                        </ActionIcon>
                                                    </Menu.Target>
                                                    <Menu.Dropdown>
                                                        <Menu.Item
                                                            leftSection={<IconPencil size={14} />}
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                handleEdit(company);
                                                            }}
                                                        >
                                                            {t('company.editTitle')}
                                                        </Menu.Item>
                                                        {user?.role === 'superadmin' && (
                                                            <Menu.Item
                                                                color="red"
                                                                leftSection={<IconTrash size={14} />}
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    handleDelete(company);
                                                                }}
                                                            >
                                                                {t('company.delete')}
                                                            </Menu.Item>
                                                        )}
                                                    </Menu.Dropdown>
                                                </Menu>
                                            )}
                                        </Table.Td>
                                    </Table.Tr>
                                ))}
                            </Table.Tbody>
                        </Table>
                        </Table.ScrollContainer>

                        {/* Pagination */}
                        {data && data.pagination.totalPages > 1 && (
                            <Box p="md">
                                <Flex justify="space-between" align="center">
                                    <Text size="sm" c="dimmed">
                                        {t('pagination.showing')} {((page - 1) * 25) + 1}–
                                        {Math.min(page * 25, data.pagination.total)} {t('pagination.of')} {data.pagination.total}
                                    </Text>
                                    <Pagination
                                        total={data.pagination.totalPages}
                                        value={page}
                                        onChange={setPage}
                                        color="violet"
                                        radius="md"
                                        size="sm"
                                    />
                                </Flex>
                            </Box>
                        )}
                    </>
                )}
            </Paper>

            {/* Company Form Modal */}
            <CompanyForm
                opened={opened}
                onClose={handleFormClose}
                company={editingCompany}
            />
        </Container>
    );
}
