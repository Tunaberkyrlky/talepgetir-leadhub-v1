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
    IconSearch,
    IconChevronUp,
    IconChevronDown,
    IconSelector,
    IconX,
    IconDotsVertical,
    IconUsers,
    IconAdjustments,
    IconGripVertical,
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
import { canDelete, isInternal } from '../lib/permissions';
import { useStages } from '../contexts/StagesContext';
import ContactForm from '../components/ContactForm';
import TruncatedText from '../components/TruncatedText';

interface Contact {
    id: string;
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
    company_id: string;
    created_at: string;
    updated_at: string;
    companies: { id: string; name: string; stage: string } | null;
}

interface PaginatedResponse {
    data: Contact[];
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
    seniorities: string[];
    countries: string[];
    companies: { id: string; name: string }[];
}

// Sortable columns
type SortKey = 'first_name' | 'last_name' | 'email' | 'updated_at' | 'created_at' | 'country' | 'seniority';

// All available column keys
type ColumnKey =
    | 'full_name' | 'company' | 'title_dept' | 'email' | 'phone'
    | 'seniority' | 'country' | 'linkedin' | 'is_primary'
    | 'notes' | 'updated_at' | 'created_at';

interface ColumnDef {
    key: ColumnKey;
    visible: boolean;
}

const COLUMNS_STORAGE_KEY = 'people_columns_v1';

const DEFAULT_COLUMNS: ColumnDef[] = [
    { key: 'full_name', visible: true },
    { key: 'company', visible: true },
    { key: 'title_dept', visible: true },
    { key: 'email', visible: true },
    { key: 'seniority', visible: true },
    { key: 'country', visible: true },
    { key: 'updated_at', visible: true },
    { key: 'phone', visible: false },
    { key: 'linkedin', visible: false },
    { key: 'is_primary', visible: false },
    { key: 'notes', visible: false },
    { key: 'created_at', visible: false },
];

const SORTABLE_COLUMNS: Record<string, SortKey> = {
    full_name: 'first_name',
    email: 'email',
    updated_at: 'updated_at',
    created_at: 'created_at',
    country: 'country',
    seniority: 'seniority',
};

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

export default function PeoplePage() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { user } = useAuth();
    const { getStageColor, getStageLabel } = useStages();
    const queryClient = useQueryClient();

    const [page, setPage] = useState(1);
    const [search, setSearch] = useState('');
    const [debouncedSearch] = useDebouncedValue(search, 300);
    const [sortBy, setSortBy] = useState<SortKey>('updated_at');
    const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
    const [filterCompanies, setFilterCompanies] = useState<string[]>([]);
    const [filterSeniorities, setFilterSeniorities] = useState<string[]>([]);
    const [filterCountries, setFilterCountries] = useState<string[]>([]);

    const [formOpened, { open: openForm, close: closeForm }] = useDisclosure(false);
    const [editContact, setEditContact] = useState<Contact | null>(null);

    // Column visibility state
    const [columns, setColumns] = useState<ColumnDef[]>(loadColumnConfig);
    const [colPopoverOpen, setColPopoverOpen] = useState(false);

    const userRole = user?.role || '';
    const userIsInternal = isInternal(userRole);
    const userCanDelete = canDelete(userRole);

    const columnLabels: Record<ColumnKey, string> = {
        full_name: t('people.fullName'),
        company: t('people.company'),
        title_dept: t('people.titleDept'),
        email: t('contact.email'),
        phone: t('contact.phone'),
        seniority: t('people.seniority'),
        country: t('people.country'),
        linkedin: t('contact.linkedin'),
        is_primary: t('contact.isPrimary'),
        notes: t('contact.notes'),
        created_at: t('company.createdAt'),
        updated_at: t('people.updatedAt'),
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
    }, [debouncedSearch, filterCompanies, filterSeniorities, filterCountries]);

    // Fetch filter options
    const { data: filterOptionsData } = useQuery<{ data: FilterOptions }>({
        queryKey: ['contact-filter-options'],
        queryFn: () => api.get('/contacts/filter-options').then((r) => r.data),
    });
    const filterOptions = filterOptionsData?.data;

    // Build query params
    const buildQueryParams = useCallback(() => {
        const params = new URLSearchParams();
        params.set('page', String(page));
        params.set('limit', '25');
        params.set('sortBy', sortBy);
        params.set('sortOrder', sortOrder);
        if (debouncedSearch) params.set('search', debouncedSearch);
        if (filterCompanies.length) params.set('company_ids', filterCompanies.join(','));
        if (filterSeniorities.length) params.set('seniorities', filterSeniorities.join(','));
        if (filterCountries.length) params.set('countries', filterCountries.join(','));
        return params.toString();
    }, [page, sortBy, sortOrder, debouncedSearch, filterCompanies, filterSeniorities, filterCountries]);

    // Fetch contacts
    const { data, isLoading, error } = useQuery<PaginatedResponse>({
        queryKey: ['people', page, debouncedSearch, sortBy, sortOrder, filterCompanies, filterSeniorities, filterCountries],
        queryFn: async () => {
            const res = await api.get(`/contacts?${buildQueryParams()}`);
            return res.data;
        },
    });

    // Delete mutation
    const deleteMutation = useMutation({
        mutationFn: (id: string) => api.delete(`/contacts/${id}`),
        onSuccess: () => {
            notifications.show({ title: t('contact.deleted'), message: '', color: 'green' });
            queryClient.invalidateQueries({ queryKey: ['people'] });
        },
        onError: () => {
            notifications.show({ title: t('common.error'), message: '', color: 'red' });
        },
    });

    const handleSort = (key: SortKey) => {
        if (sortBy === key) {
            setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
        } else {
            setSortBy(key);
            setSortOrder('asc');
        }
        setPage(1);
    };

    const openCreate = () => { setEditContact(null); openForm(); };
    const openEdit = (contact: Contact) => { setEditContact(contact); openForm(); };

    const formatDate = (dateStr: string) => {
        return new Date(dateStr).toLocaleDateString(undefined, {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        });
    };

    const hasActiveFilters = debouncedSearch || filterCompanies.length || filterSeniorities.length || filterCountries.length;

    const clearAllFilters = () => {
        setSearch('');
        setFilterCompanies([]);
        setFilterSeniorities([]);
        setFilterCountries([]);
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
        const sortKey = SORTABLE_COLUMNS[key];
        if (sortKey) {
            return <Table.Th key={key}><SortHeader column={sortKey} label={label} /></Table.Th>;
        }
        return <Table.Th key={key}><NonSortHeader label={label} /></Table.Th>;
    };

    const renderColumnCell = (key: ColumnKey, contact: Contact) => {
        switch (key) {
            case 'full_name':
                return (
                    <Table.Td key="full_name">
                        <Group gap="xs">
                            <Text fw={600} size="sm">
                                {contact.first_name} {contact.last_name || ''}
                            </Text>
                            {contact.is_primary && (
                                <Badge size="xs" variant="dot" color="violet">
                                    {t('contact.isPrimary')}
                                </Badge>
                            )}
                        </Group>
                    </Table.Td>
                );
            case 'company':
                return (
                    <Table.Td key="company">
                        <Group gap="xs">
                            <Text
                                size="sm"
                                c="blue"
                                style={{ cursor: 'pointer' }}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    if (contact.companies?.id) navigate(`/companies/${contact.companies.id}`);
                                }}
                            >
                                {contact.companies?.name || '—'}
                            </Text>
                            {contact.companies?.stage && (
                                <Badge
                                    size="xs"
                                    variant="light"
                                    color={getStageColor(contact.companies.stage)}
                                >
                                    {getStageLabel(contact.companies.stage)}
                                </Badge>
                            )}
                        </Group>
                    </Table.Td>
                );
            case 'title_dept':
                return (
                    <Table.Td key="title_dept">
                        <TruncatedText size="sm">
                            {contact.title || null}
                        </TruncatedText>
                    </Table.Td>
                );
            case 'email':
                return <Table.Td key="email"><TruncatedText size="sm" c="dimmed">{contact.email}</TruncatedText></Table.Td>;
            case 'phone':
                return <Table.Td key="phone"><TruncatedText size="sm">{contact.phone_e164}</TruncatedText></Table.Td>;
            case 'seniority':
                return (
                    <Table.Td key="seniority" style={{ whiteSpace: 'nowrap' }}>
                        {contact.seniority ? (
                            <Text size="sm" c="blue" fw={500}>{contact.seniority}</Text>
                        ) : <Text size="sm">—</Text>}
                    </Table.Td>
                );
            case 'country':
                return <Table.Td key="country"><TruncatedText size="sm">{contact.country}</TruncatedText></Table.Td>;
            case 'linkedin':
                return (
                    <Table.Td key="linkedin">
                        <TruncatedText size="xs" c="dimmed">{contact.linkedin}</TruncatedText>
                    </Table.Td>
                );
            case 'is_primary':
                return (
                    <Table.Td key="is_primary">
                        {contact.is_primary ? (
                            <Badge size="sm" variant="light" color="green">{t('contact.isPrimary')}</Badge>
                        ) : <Text size="sm">—</Text>}
                    </Table.Td>
                );
            case 'notes':
                return (
                    <Table.Td key="notes">
                        <TruncatedText size="sm">{Array.isArray(contact.notes) ? contact.notes.map((n) => n.text).join(' | ') : ''}</TruncatedText>
                    </Table.Td>
                );
            case 'created_at':
                return (
                    <Table.Td key="created_at">
                        <Text size="xs" c="dimmed">{formatDate(contact.created_at)}</Text>
                    </Table.Td>
                );
            case 'updated_at':
                return (
                    <Table.Td key="updated_at">
                        <Text size="xs" c="dimmed">{formatDate(contact.updated_at)}</Text>
                    </Table.Td>
                );
        }
    };

    if (error) {
        return (
            <Container size="xl" py="xl">
                <Center>
                    <Stack align="center">
                        <Text c="red">{t('common.error')}</Text>
                        <Button variant="light" onClick={() => queryClient.invalidateQueries({ queryKey: ['people'] })}>
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
                    {t('people.title')}
                </Title>
                {userIsInternal && (
                    <Button
                        leftSection={<IconPlus size={18} />}
                        onClick={openCreate}
                        gradient={{ from: '#6c63ff', to: '#3b82f6', deg: 135 }}
                        variant="gradient"
                        radius="md"
                    >
                        {t('people.addPerson')}
                    </Button>
                )}
            </Flex>

            {/* Search & Filters */}
            <Paper shadow="sm" radius="lg" p="md" mb="md" withBorder>
                <Group grow>
                    <TextInput
                        placeholder={t('people.search')}
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
                        placeholder={filterCompanies.length === 0 ? t('people.filterCompany') : undefined}
                        data={(filterOptions?.companies || []).map((c) => ({ value: c.id, label: c.name }))}
                        value={filterCompanies}
                        onChange={setFilterCompanies}
                        searchable
                        clearable
                        radius="md"
                        maxDropdownHeight={200}
                    />
                    <MultiSelect
                        placeholder={filterSeniorities.length === 0 ? t('people.filterSeniority') : undefined}
                        data={filterOptions?.seniorities || []}
                        value={filterSeniorities}
                        onChange={setFilterSeniorities}
                        clearable
                        radius="md"
                        maxDropdownHeight={200}
                    />
                </Group>
                <Group mt="xs">
                    <MultiSelect
                        placeholder={filterCountries.length === 0 ? t('people.filterCountry') : undefined}
                        data={filterOptions?.countries || []}
                        value={filterCountries}
                        onChange={setFilterCountries}
                        clearable
                        radius="md"
                        maxDropdownHeight={200}
                        style={{ minWidth: 200 }}
                    />
                    {hasActiveFilters && (
                        <>
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
                        </>
                    )}
                </Group>
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
                            <IconUsers size={48} color="#ccc" />
                            <Text fw={500} size="lg" c="dimmed">
                                {hasActiveFilters ? t('filter.noResults') : t('people.noData')}
                            </Text>
                            <Text size="sm" c="dimmed">
                                {hasActiveFilters ? t('filter.tryDifferent') : t('people.noDataDescription')}
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
                                {data?.data.map((contact) => (
                                    <Table.Tr
                                        key={contact.id}
                                        style={{ cursor: 'pointer' }}
                                        onClick={() => navigate(`/people/${contact.id}`)}
                                    >
                                        {visibleColumns.map(col => renderColumnCell(col.key, contact))}
                                        <Table.Td style={{ padding: '0 4px' }}>
                                            {userIsInternal && (
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
                                                                openEdit(contact);
                                                            }}
                                                        >
                                                            {t('contact.editContact')}
                                                        </Menu.Item>
                                                        {userCanDelete && (
                                                            <Menu.Item
                                                                color="red"
                                                                leftSection={<IconTrash size={14} />}
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    if (confirm(t('contact.deleteConfirm'))) {
                                                                        deleteMutation.mutate(contact.id);
                                                                    }
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

            {/* Contact Form Modal */}
            <ContactForm
                opened={formOpened}
                onClose={closeForm}
                contact={editContact}
            />
        </Container>
    );
}
