import { useState } from 'react';
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
    TextInput,
    MultiSelect,
    UnstyledButton,
    Menu,
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
    IconDotsVertical,
    IconUsers,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { canDelete, isInternal } from '../lib/permissions';
import ContactForm from '../components/ContactForm';

interface Contact {
    id: string;
    first_name: string;
    last_name: string | null;
    title: string | null;
    department: string | null;
    seniority: string | null;
    country: string | null;
    email: string | null;
    phone_e164: string | null;
    linkedin: string | null;
    is_primary: boolean;
    notes: string | null;
    company_id: string;
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
    departments: string[];
    countries: string[];
    companies: { id: string; name: string }[];
}

type SortKey = 'first_name' | 'last_name' | 'email' | 'updated_at';

function SortIcon({ column, sortBy, sortOrder }: { column: SortKey; sortBy: SortKey; sortOrder: 'asc' | 'desc' }) {
    if (sortBy !== column) return <IconSelector size={14} />;
    return sortOrder === 'asc' ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />;
}

export default function PeoplePage() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { user } = useAuth();
    const queryClient = useQueryClient();

    const [page, setPage] = useState(1);
    const [search, setSearch] = useState('');
    const [debouncedSearch] = useDebouncedValue(search, 300);
    const [sortBy, setSortBy] = useState<SortKey>('updated_at');
    const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
    const [filterCompanies, setFilterCompanies] = useState<string[]>([]);
    const [filterSeniorities, setFilterSeniorities] = useState<string[]>([]);
    const [filterDepartments, setFilterDepartments] = useState<string[]>([]);
    const [filterCountries, setFilterCountries] = useState<string[]>([]);

    const [formOpened, { open: openForm, close: closeForm }] = useDisclosure(false);
    const [editContact, setEditContact] = useState<Contact | null>(null);

    const userRole = user?.role || '';
    const userIsInternal = isInternal(userRole);
    const userCanDelete = canDelete(userRole);

    // Fetch filter options
    const { data: filterOptionsData } = useQuery<{ data: FilterOptions }>({
        queryKey: ['contact-filter-options'],
        queryFn: () => api.get('/contacts/filter-options').then((r) => r.data),
    });
    const filterOptions = filterOptionsData?.data;

    // Build query params
    const queryParams = new URLSearchParams({
        page: String(page),
        limit: '25',
        sortBy,
        sortOrder,
    });
    if (debouncedSearch) queryParams.set('search', debouncedSearch);
    if (filterCompanies.length) queryParams.set('company_ids', filterCompanies.join(','));
    if (filterSeniorities.length) queryParams.set('seniorities', filterSeniorities.join(','));
    if (filterDepartments.length) queryParams.set('departments', filterDepartments.join(','));
    if (filterCountries.length) queryParams.set('countries', filterCountries.join(','));

    const { data, isLoading } = useQuery<PaginatedResponse>({
        queryKey: ['people', page, debouncedSearch, sortBy, sortOrder, filterCompanies, filterSeniorities, filterDepartments, filterCountries],
        queryFn: () => api.get(`/contacts?${queryParams}`).then((r) => r.data),
    });

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

    const handleSort = (col: SortKey) => {
        if (sortBy === col) {
            setSortOrder((o) => (o === 'asc' ? 'desc' : 'asc'));
        } else {
            setSortBy(col);
            setSortOrder('asc');
        }
        setPage(1);
    };

    const handleSearchChange = (val: string) => {
        setSearch(val);
        setPage(1);
    };

    const openCreate = () => {
        setEditContact(null);
        openForm();
    };

    const openEdit = (contact: Contact) => {
        setEditContact(contact);
        openForm();
    };

    const contacts = data?.data || [];
    const pagination = data?.pagination;

    const hasFilters = filterCompanies.length > 0 || filterSeniorities.length > 0 ||
        filterDepartments.length > 0 || filterCountries.length > 0 || search;

    return (
        <Container size="xl">
            <Flex justify="space-between" align="center" mb="md">
                <Title order={2}>{t('people.title')}</Title>
                {userIsInternal && (
                    <Button leftSection={<IconPlus size={16} />} onClick={openCreate}>
                        {t('people.addPerson')}
                    </Button>
                )}
            </Flex>

            {/* Filters */}
            <Paper withBorder p="md" mb="md" radius="md">
                <Stack gap="sm">
                    <TextInput
                        placeholder={t('people.search')}
                        leftSection={<IconSearch size={16} />}
                        value={search}
                        onChange={(e) => handleSearchChange(e.currentTarget.value)}
                        rightSection={search ? (
                            <ActionIcon variant="subtle" onClick={() => handleSearchChange('')}>
                                <IconSearch size={14} />
                            </ActionIcon>
                        ) : null}
                    />
                    <Flex gap="sm" wrap="wrap">
                        <MultiSelect
                            placeholder={t('people.filterCompany')}
                            data={(filterOptions?.companies || []).map((c) => ({ value: c.id, label: c.name }))}
                            value={filterCompanies}
                            onChange={(v) => { setFilterCompanies(v); setPage(1); }}
                            searchable
                            clearable
                            style={{ flex: 1, minWidth: 160 }}
                        />
                        <MultiSelect
                            placeholder={t('people.filterSeniority')}
                            data={filterOptions?.seniorities || []}
                            value={filterSeniorities}
                            onChange={(v) => { setFilterSeniorities(v); setPage(1); }}
                            clearable
                            style={{ flex: 1, minWidth: 160 }}
                        />
                        <MultiSelect
                            placeholder={t('people.filterDepartment')}
                            data={filterOptions?.departments || []}
                            value={filterDepartments}
                            onChange={(v) => { setFilterDepartments(v); setPage(1); }}
                            clearable
                            style={{ flex: 1, minWidth: 160 }}
                        />
                        <MultiSelect
                            placeholder={t('people.filterCountry')}
                            data={filterOptions?.countries || []}
                            value={filterCountries}
                            onChange={(v) => { setFilterCountries(v); setPage(1); }}
                            clearable
                            style={{ flex: 1, minWidth: 160 }}
                        />
                        {hasFilters && (
                            <Button
                                variant="subtle"
                                color="gray"
                                onClick={() => {
                                    setSearch('');
                                    setFilterCompanies([]);
                                    setFilterSeniorities([]);
                                    setFilterDepartments([]);
                                    setFilterCountries([]);
                                    setPage(1);
                                }}
                            >
                                {t('filter.clearAll')}
                            </Button>
                        )}
                    </Flex>
                </Stack>
            </Paper>

            {/* Results info */}
            {pagination && (
                <Text size="sm" c="dimmed" mb="xs">
                    {t('pagination.showing')} {Math.min((page - 1) * 25 + 1, pagination.total)}–
                    {Math.min(page * 25, pagination.total)} {t('pagination.of')} {pagination.total} {t('filter.results')}
                </Text>
            )}

            {isLoading ? (
                <Center h={300}><Loader /></Center>
            ) : contacts.length === 0 ? (
                <Center h={300}>
                    <Stack align="center" gap="xs">
                        <IconUsers size={48} stroke={1.5} color="var(--mantine-color-gray-4)" />
                        <Text c="dimmed">{t('people.noData')}</Text>
                        <Text size="sm" c="dimmed">{t('people.noDataDescription')}</Text>
                    </Stack>
                </Center>
            ) : (
                <Paper withBorder radius="md" style={{ overflow: 'hidden' }}>
                    <Table highlightOnHover>
                        <Table.Thead>
                            <Table.Tr>
                                <Table.Th>
                                    <UnstyledButton onClick={() => handleSort('first_name')}>
                                        <Group gap={4}>
                                            {t('people.fullName')}
                                            <SortIcon column="first_name" sortBy={sortBy} sortOrder={sortOrder} />
                                        </Group>
                                    </UnstyledButton>
                                </Table.Th>
                                <Table.Th>{t('people.company')}</Table.Th>
                                <Table.Th>{t('people.titleDept')}</Table.Th>
                                <Table.Th>
                                    <UnstyledButton onClick={() => handleSort('email')}>
                                        <Group gap={4}>
                                            {t('contact.email')}
                                            <SortIcon column="email" sortBy={sortBy} sortOrder={sortOrder} />
                                        </Group>
                                    </UnstyledButton>
                                </Table.Th>
                                <Table.Th>{t('people.seniority')}</Table.Th>
                                <Table.Th>{t('people.country')}</Table.Th>
                                <Table.Th>
                                    <UnstyledButton onClick={() => handleSort('updated_at')}>
                                        <Group gap={4}>
                                            {t('people.updatedAt')}
                                            <SortIcon column="updated_at" sortBy={sortBy} sortOrder={sortOrder} />
                                        </Group>
                                    </UnstyledButton>
                                </Table.Th>
                                {userIsInternal && <Table.Th />}
                            </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                            {contacts.map((contact) => (
                                <Table.Tr
                                    key={contact.id}
                                    style={{ cursor: 'pointer' }}
                                    onClick={() => navigate(`/people/${contact.id}`)}
                                >
                                    <Table.Td>
                                        <Text fw={500}>
                                            {contact.first_name} {contact.last_name || ''}
                                            {contact.is_primary && (
                                                <Badge size="xs" variant="dot" color="violet" ml={6}>
                                                    primary
                                                </Badge>
                                            )}
                                        </Text>
                                    </Table.Td>
                                    <Table.Td>
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
                                    </Table.Td>
                                    <Table.Td>
                                        <Text size="sm">
                                            {[contact.title, contact.department].filter(Boolean).join(' / ') || '—'}
                                        </Text>
                                    </Table.Td>
                                    <Table.Td>
                                        <Text size="sm" c="dimmed">{contact.email || '—'}</Text>
                                    </Table.Td>
                                    <Table.Td>
                                        {contact.seniority ? (
                                            <Badge size="sm" variant="light" color="blue">
                                                {contact.seniority}
                                            </Badge>
                                        ) : '—'}
                                    </Table.Td>
                                    <Table.Td>
                                        <Text size="sm">{contact.country || '—'}</Text>
                                    </Table.Td>
                                    <Table.Td>
                                        <Text size="sm" c="dimmed">
                                            {new Date(contact.updated_at).toLocaleDateString()}
                                        </Text>
                                    </Table.Td>
                                    {userIsInternal && (
                                        <Table.Td onClick={(e) => e.stopPropagation()}>
                                            <Menu shadow="md" width={160} position="bottom-end">
                                                <Menu.Target>
                                                    <ActionIcon variant="subtle" color="gray">
                                                        <IconDotsVertical size={16} />
                                                    </ActionIcon>
                                                </Menu.Target>
                                                <Menu.Dropdown>
                                                    <Menu.Item
                                                        leftSection={<IconPencil size={14} />}
                                                        onClick={() => openEdit(contact)}
                                                    >
                                                        {t('contact.editContact')}
                                                    </Menu.Item>
                                                    {userCanDelete && (
                                                        <Menu.Item
                                                            leftSection={<IconTrash size={14} />}
                                                            color="red"
                                                            onClick={() => {
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
                                        </Table.Td>
                                    )}
                                </Table.Tr>
                            ))}
                        </Table.Tbody>
                    </Table>
                </Paper>
            )}

            {pagination && pagination.totalPages > 1 && (
                <Flex justify="center" mt="md">
                    <Pagination
                        value={page}
                        onChange={setPage}
                        total={pagination.totalPages}
                    />
                </Flex>
            )}

            <ContactForm
                opened={formOpened}
                onClose={closeForm}
                contact={editContact}
            />
        </Container>
    );
}
