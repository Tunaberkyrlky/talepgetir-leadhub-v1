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
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import CompanyForm from '../components/CompanyForm';

interface Company {
    id: string;
    name: string;
    website: string | null;
    location: string | null;
    industry: string | null;
    employee_count: string | null;
    stage: string;
    deal_summary: string | null;
    internal_notes: string | null;
    next_step: string | null;
    custom_fields: Record<string, unknown>;
    assigned_to: string | null;
    created_at: string;
    updated_at: string;
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

// Stage color mapping
const stageColors: Record<string, string> = {
    new: 'blue',
    researching: 'cyan',
    contacted: 'indigo',
    meeting_scheduled: 'yellow',
    proposal_sent: 'orange',
    negotiation: 'grape',
    won: 'green',
    lost: 'red',
    on_hold: 'gray',
};

// Sortable columns
type SortKey = 'name' | 'stage' | 'industry' | 'location' | 'updated_at';

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

    const isOpsOrAdmin = user?.role === 'superadmin' || user?.role === 'ops_agent';

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
                                    <Table.Th><SortHeader column="name" label={t('company.name')} /></Table.Th>
                                    <Table.Th><SortHeader column="stage" label={t('company.stage')} /></Table.Th>
                                    <Table.Th><SortHeader column="industry" label={t('company.industry')} /></Table.Th>
                                    <Table.Th><SortHeader column="location" label={t('company.location')} /></Table.Th>
                                    <Table.Th><Text size="xs" fw={600} tt="uppercase" c="white" style={{ letterSpacing: '0.5px' }}>{t('company.nextStep')}</Text></Table.Th>
                                    <Table.Th><SortHeader column="updated_at" label={t('company.updatedAt')} /></Table.Th>
                                    {isOpsOrAdmin && <Table.Th><Text size="xs" fw={600} tt="uppercase" c="white" style={{ letterSpacing: '0.5px' }}>{t('common.actions')}</Text></Table.Th>}
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>
                                {data?.data.map((company) => (
                                    <Table.Tr
                                        key={company.id}
                                        style={{ cursor: 'pointer' }}
                                        onClick={() => navigate(`/companies/${company.id}`)}
                                    >
                                        <Table.Td>
                                            <Group gap="xs">
                                                <Text fw={600} size="sm">{company.name}</Text>
                                                {company.website && (
                                                    <Text size="xs" c="dimmed">{company.website}</Text>
                                                )}
                                            </Group>
                                        </Table.Td>
                                        <Table.Td>
                                            <Badge
                                                color={stageColors[company.stage] || 'gray'}
                                                variant="light"
                                                size="sm"
                                                radius="sm"
                                            >
                                                {t(`stages.${company.stage}`)}
                                            </Badge>
                                        </Table.Td>
                                        <Table.Td>
                                            <Text size="sm">{company.industry || '—'}</Text>
                                        </Table.Td>
                                        <Table.Td>
                                            <Text size="sm">{company.location || '—'}</Text>
                                        </Table.Td>
                                        <Table.Td>
                                            <Text size="sm" lineClamp={1} maw={200}>
                                                {company.next_step || '—'}
                                            </Text>
                                        </Table.Td>
                                        <Table.Td>
                                            <Text size="xs" c="dimmed">
                                                {formatDate(company.updated_at)}
                                            </Text>
                                        </Table.Td>
                                        {isOpsOrAdmin && (
                                            <Table.Td>
                                                <Group gap="xs">
                                                    <Tooltip label={t('company.editTitle')}>
                                                        <ActionIcon
                                                            variant="subtle"
                                                            color="blue"
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                handleEdit(company);
                                                            }}
                                                        >
                                                            <IconPencil size={16} />
                                                        </ActionIcon>
                                                    </Tooltip>
                                                    {user?.role === 'superadmin' && (
                                                        <Tooltip label={t('company.delete')}>
                                                            <ActionIcon
                                                                variant="subtle"
                                                                color="red"
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    handleDelete(company);
                                                                }}
                                                            >
                                                                <IconTrash size={16} />
                                                            </ActionIcon>
                                                        </Tooltip>
                                                    )}
                                                </Group>
                                            </Table.Td>
                                        )}
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
