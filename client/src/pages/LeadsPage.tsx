import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
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
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { stageColors } from '../lib/stages';
import CompanyForm from '../components/CompanyForm';

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
}

// Stage colors imported from lib/stages.ts

// Sortable columns
type SortKey = 'name' | 'stage' | 'industry' | 'location' | 'updated_at';

// Column management
type ColumnKey = 'name' | 'stage' | 'industry' | 'location' | 'next_step' | 'updated_at';

interface ColumnDef {
    key: ColumnKey;
    visible: boolean;
}

const COLUMNS_STORAGE_KEY = 'leads_columns_v1';

const DEFAULT_COLUMNS: ColumnDef[] = [
    { key: 'name', visible: true },
    { key: 'stage', visible: true },
    { key: 'industry', visible: true },
    { key: 'location', visible: true },
    { key: 'next_step', visible: true },
    { key: 'updated_at', visible: true },
];

function loadColumnConfig(): ColumnDef[] {
    try {
        const stored = localStorage.getItem(COLUMNS_STORAGE_KEY);
        if (stored) {
            const parsed = JSON.parse(stored) as ColumnDef[];
            // Ensure all default columns are present (in case new columns added later)
            const keys = parsed.map(c => c.key);
            const missing = DEFAULT_COLUMNS.filter(c => !keys.includes(c.key));
            return [...parsed, ...missing];
        }
    } catch {}
    return DEFAULT_COLUMNS;
}

export default function LeadsPage() {
    const { t } = useTranslation();
    const { user } = useAuth();
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const [page, setPage] = useState(1);
    const [opened, { open, close }] = useDisclosure(false);
    const [editingCompany, setEditingCompany] = useState<Company | null>(null);

    // Search & filter state
    const [search, setSearch] = useState('');
    const [debouncedSearch] = useDebouncedValue(search, 300);
    const [selectedStages, setSelectedStages] = useState<string[]>([]);
    const [selectedIndustries, setSelectedIndustries] = useState<string[]>([]);
    const [selectedLocations, setSelectedLocations] = useState<string[]>([]);

    // Sort state
    const [sortBy, setSortBy] = useState<SortKey>('updated_at');
    const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

    // Column visibility state
    const [columns, setColumns] = useState<ColumnDef[]>(loadColumnConfig);
    const [colPopoverOpen, setColPopoverOpen] = useState(false);

    const isOpsOrAdmin = user?.role === 'superadmin' || user?.role === 'ops_agent';

    const columnLabels: Record<ColumnKey, string> = {
        name: t('company.name'),
        stage: t('company.stage'),
        industry: t('company.industry'),
        location: t('company.location'),
        next_step: t('company.nextStep'),
        updated_at: t('company.updatedAt'),
    };

    const saveColumns = (cols: ColumnDef[]) => {
        setColumns(cols);
        localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(cols));
    };

    const toggleColumn = (key: ColumnKey) => {
        const visibleCount = columns.filter(c => c.visible).length;
        const col = columns.find(c => c.key === key);
        if (col?.visible && visibleCount <= 1) return; // keep at least 1 visible
        saveColumns(columns.map(c => c.key === key ? { ...c, visible: !c.visible } : c));
    };

    const moveColumn = (key: ColumnKey, direction: 'up' | 'down') => {
        const idx = columns.findIndex(c => c.key === key);
        if (direction === 'up' && idx > 0) {
            const next = [...columns];
            [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
            saveColumns(next);
        } else if (direction === 'down' && idx < columns.length - 1) {
            const next = [...columns];
            [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
            saveColumns(next);
        }
    };

    const visibleColumns = columns.filter(c => c.visible);

    // Reset page when filters change
    useEffect(() => {
        setPage(1);
    }, [debouncedSearch, selectedStages, selectedIndustries, selectedLocations]);

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
        return params.toString();
    }, [page, sortBy, sortOrder, debouncedSearch, selectedStages, selectedIndustries, selectedLocations]);

    // Fetch companies
    const { data, isLoading, error } = useQuery<PaginatedResponse>({
        queryKey: ['companies', page, debouncedSearch, selectedStages, selectedIndustries, selectedLocations, sortBy, sortOrder],
        queryFn: async () => {
            const res = await api.get(`/companies?${buildQueryParams()}`);
            return res.data;
        },
    });

    // Delete mutation
    const deleteMutation = useMutation({
        mutationFn: async (id: string) => {
            await api.delete(`/companies/${id}`);
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['companies'] });
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
    };

    const formatDate = (dateStr: string) => {
        return new Date(dateStr).toLocaleDateString(undefined, {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        });
    };

    const hasActiveFilters = debouncedSearch || selectedStages.length || selectedIndustries.length || selectedLocations.length;

    const clearAllFilters = () => {
        setSearch('');
        setSelectedStages([]);
        setSelectedIndustries([]);
        setSelectedLocations([]);
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

    const renderColumnHeader = (key: ColumnKey) => {
        switch (key) {
            case 'name':
                return <Table.Th key="name"><SortHeader column="name" label={t('company.name')} /></Table.Th>;
            case 'stage':
                return <Table.Th key="stage"><SortHeader column="stage" label={t('company.stage')} /></Table.Th>;
            case 'industry':
                return <Table.Th key="industry"><SortHeader column="industry" label={t('company.industry')} /></Table.Th>;
            case 'location':
                return <Table.Th key="location"><SortHeader column="location" label={t('company.location')} /></Table.Th>;
            case 'next_step':
                return (
                    <Table.Th key="next_step">
                        <Text size="xs" fw={600} tt="uppercase" c="white" style={{ letterSpacing: '0.5px' }}>
                            {t('company.nextStep')}
                        </Text>
                    </Table.Th>
                );
            case 'updated_at':
                return <Table.Th key="updated_at"><SortHeader column="updated_at" label={t('company.updatedAt')} /></Table.Th>;
        }
    };

    const renderColumnCell = (key: ColumnKey, company: Company) => {
        switch (key) {
            case 'name':
                return (
                    <Table.Td key="name">
                        <Group gap="xs">
                            <Text fw={600} size="sm">{company.name}</Text>
                            {company.contact_count > 0 && (
                                <Tooltip label={`${company.contact_count} kişi`} withArrow>
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
                            {company.website && (
                                <Text size="xs" c="dimmed">{company.website}</Text>
                            )}
                        </Group>
                    </Table.Td>
                );
            case 'stage':
                return (
                    <Table.Td key="stage">
                        <Badge
                            color={stageColors[company.stage] || 'gray'}
                            variant="light"
                            size="sm"
                            radius="sm"
                        >
                            {t(`stages.${company.stage}`)}
                        </Badge>
                    </Table.Td>
                );
            case 'industry':
                return <Table.Td key="industry"><Text size="sm">{company.industry || '—'}</Text></Table.Td>;
            case 'location':
                return <Table.Td key="location"><Text size="sm">{company.location || '—'}</Text></Table.Td>;
            case 'next_step':
                return (
                    <Table.Td key="next_step">
                        <Text size="sm" lineClamp={1} maw={200}>
                            {company.next_step || '—'}
                        </Text>
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
                                },
                            }}
                        >
                            <Table.Thead>
                                <Table.Tr>
                                    {visibleColumns.map(col => renderColumnHeader(col.key))}
                                    {isOpsOrAdmin && <Table.Th style={{ width: 40 }} />}
                                    <Table.Th style={{ width: 40, padding: '0 8px' }}>
                                        <Popover
                                            opened={colPopoverOpen}
                                            onChange={setColPopoverOpen}
                                            position="bottom-end"
                                            shadow="md"
                                            withArrow
                                        >
                                            <Popover.Target>
                                                <Tooltip label="Sütunları düzenle" withArrow position="left">
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
                                            <Popover.Dropdown p="sm" style={{ minWidth: 220 }}>
                                                <Text size="xs" fw={700} tt="uppercase" c="dimmed" mb="xs" style={{ letterSpacing: '0.5px' }}>
                                                    Sütunlar
                                                </Text>
                                                <Divider mb="xs" />
                                                <Stack gap={6}>
                                                    {columns.map((col, idx) => (
                                                        <Group key={col.key} justify="space-between" wrap="nowrap">
                                                            <Checkbox
                                                                checked={col.visible}
                                                                onChange={() => toggleColumn(col.key)}
                                                                label={<Text size="sm">{columnLabels[col.key]}</Text>}
                                                                size="xs"
                                                            />
                                                            <Group gap={2}>
                                                                <ActionIcon
                                                                    size="xs"
                                                                    variant="subtle"
                                                                    color="gray"
                                                                    disabled={idx === 0}
                                                                    onClick={() => moveColumn(col.key, 'up')}
                                                                >
                                                                    <IconChevronUp size={12} />
                                                                </ActionIcon>
                                                                <ActionIcon
                                                                    size="xs"
                                                                    variant="subtle"
                                                                    color="gray"
                                                                    disabled={idx === columns.length - 1}
                                                                    onClick={() => moveColumn(col.key, 'down')}
                                                                >
                                                                    <IconChevronDown size={12} />
                                                                </ActionIcon>
                                                            </Group>
                                                        </Group>
                                                    ))}
                                                </Stack>
                                                <Divider mt="xs" mb="xs" />
                                                <Button
                                                    size="xs"
                                                    variant="subtle"
                                                    color="gray"
                                                    fullWidth
                                                    onClick={() => saveColumns(DEFAULT_COLUMNS)}
                                                >
                                                    Varsayılana sıfırla
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
                                        style={{ cursor: 'pointer' }}
                                        onClick={() => navigate(`/companies/${company.id}`)}
                                    >
                                        {visibleColumns.map(col => renderColumnCell(col.key, company))}
                                        {isOpsOrAdmin && (
                                            <Table.Td>
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
                                            </Table.Td>
                                        )}
                                        <Table.Td />
                                    </Table.Tr>
                                ))}
                            </Table.Tbody>
                        </Table>

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
