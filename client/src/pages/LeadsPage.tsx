import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
    Container,
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
    Select,
    UnstyledButton,
    Menu,
    Popover,
    Checkbox,
    Divider,
    Modal,
    Alert,
    SegmentedControl,
    ScrollArea,
    Switch,
} from '@mantine/core';
import { useDebouncedValue, useDisclosure, useHotkeys } from '@mantine/hooks';
import { showSuccess, showInfo, showErrorFromApi } from '../lib/notifications';
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
    IconUser,
    IconDotsVertical,
    IconAdjustments,
    IconGripVertical,
    IconArrowLeft,
    IconMap,
    IconMapPin,
    IconAlertCircle,
    IconCalendar,
    IconChevronLeft,
    IconChevronRight,
    IconStar,
    IconStarFilled,
    IconDownload,
    IconDeviceFloppy,
    IconBookmark,
    IconShare,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { DatePickerInput } from '@mantine/dates';
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
import { localizeCountry } from '../lib/countryNamesTr';
import { useAuth } from '../contexts/AuthContext';
import { canWrite } from '../lib/permissions';
import { useStages } from '../contexts/StagesContext';
import CompanyForm from '../components/CompanyForm';
import CompaniesPeopleToggle from '../components/CompaniesPeopleToggle';
import ClosingReportModal from '../components/ClosingReportModal';
import ReopenReasonModal from '../components/ReopenReasonModal';
import TruncatedText from '../components/TruncatedText';
import EmailStatusIcon from '../components/EmailStatusIcon';
import { useUndoStack } from '../hooks/useUndoStack';
import { useMembers } from '../lib/useMembers';
import type { ClosingOutcome } from '../types/activity';

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
    custom_field_1: string | null;
    custom_field_2: string | null;
    custom_field_3: string | null;
    assigned_to: string | null;
    assigned_user: { id: string; name: string | null; email: string } | null;
    created_at: string;
    updated_at: string;
    latitude: number | null;
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
    // Present (true) only when the server had to drop the owner filter from this
    // search on a pre-migration-118 DB — shown to the user as a one-time notice.
    owner_filter_dropped?: boolean;
}

interface FilterOptions {
    stages: string[];
    industries: string[];
    locations: string[];
    products: string[];
    countries: string[];
}

// ─── Saved views + favorites/recents (E11) ────────────────────────────────────

// Serialized filter set stored in saved_views.filters. Forward-compatible: unknown
// keys are ignored on apply, and `tags` is a placeholder for the later E4 tag wave.
interface SavedViewFilters {
    search?: string;
    stages?: string[];
    industries?: string[];
    locations?: string[];
    countries?: string[];
    products?: string[];
    owner?: string;
    periodType?: PeriodType;
    periodAnchor?: string;
    customRange?: [string | null, string | null];
    tags?: string[];
}

interface SavedViewColumns {
    visible?: ColumnDef[];
    sortBy?: SortKey;
    sortOrder?: 'asc' | 'desc';
}

interface SavedView {
    id: string;
    name: string;
    entity_type: string;
    filters: SavedViewFilters;
    columns: SavedViewColumns;
    is_shared: boolean;
    is_owner: boolean;
    user_id: string;
    created_at: string;
    updated_at: string;
}

// A favorited / recently-visited company, enriched with display fields by the API.
interface EntityRef {
    entity_id: string;
    name: string | null;
    stage: string | null;
    created_at?: string;
    last_visited_at?: string;
}

// Hard cap on CSV export so a huge filtered set can't fan out into hundreds of
// paginated requests. 50 pages × 100 rows.
const CSV_EXPORT_PAGE_SIZE = 100;
const CSV_EXPORT_MAX_PAGES = 50;

// Sortable columns
type SortKey = 'name' | 'stage' | 'industry' | 'location' | 'updated_at' | 'created_at' | 'employee_size' | 'contact_count';

// All available column keys
type ColumnKey =
    | 'name' | 'website' | 'stage' | 'industry' | 'location'
    | 'employee_size' | 'product_services' | 'product_portfolio'
    | 'linkedin' | 'company_phone' | 'company_email' | 'company_summary'
    | 'next_step' | 'assigned_to' | 'contact_count'
    | 'fit_score' | 'custom_field_1' | 'custom_field_2' | 'custom_field_3'
    | 'created_at' | 'updated_at';

interface ColumnDef {
    key: ColumnKey;
    visible: boolean;
}

const COLUMNS_STORAGE_KEY = 'leads_columns_v2';
const LEADS_TABLE_STATE_KEY = 'leads_table_state';

interface LeadsTableState {
    page: number;
    search: string;
    selectedStages: string[];
    selectedIndustries: string[];
    selectedLocations: string[];
    selectedCountries: string[];
    selectedProducts: string[];
    owner: string;
    periodType: PeriodType;
    periodAnchor: string;
    customRange: [string | null, string | null];
    sortBy: SortKey;
    sortOrder: 'asc' | 'desc';
}

function loadLeadsTableState(): LeadsTableState | null {
    try {
        const s = sessionStorage.getItem(LEADS_TABLE_STATE_KEY);
        return s ? (JSON.parse(s) as LeadsTableState) : null;
    } catch {
        return null;
    }
}

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
    { key: 'product_portfolio', visible: false },
    { key: 'linkedin', visible: false },
    { key: 'company_phone', visible: false },
    { key: 'company_email', visible: false },
    { key: 'company_summary', visible: false },
    { key: 'fit_score', visible: false },
    { key: 'custom_field_1', visible: false },
    { key: 'custom_field_2', visible: false },
    { key: 'custom_field_3', visible: false },
    { key: 'assigned_to', visible: false },
    { key: 'contact_count', visible: false },
    { key: 'created_at', visible: false },
];

const SORTABLE_COLUMNS: Set<string> = new Set([
    'name', 'stage', 'industry', 'location', 'updated_at', 'created_at', 'employee_size', 'contact_count',
]);

const VALID_COLUMN_KEYS = new Set<string>(DEFAULT_COLUMNS.map(c => c.key));

// Validates the owner field of an (untrusted) shared saved view before it hits state.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function loadColumnConfig(): ColumnDef[] {
    try {
        const stored = localStorage.getItem(COLUMNS_STORAGE_KEY);
        if (stored) {
            const parsed = JSON.parse(stored) as ColumnDef[];
            // Filter out unknown keys from old localStorage data
            const valid = parsed.filter(c => VALID_COLUMN_KEYS.has(c.key));
            const keys = valid.map(c => c.key);
            const missing = DEFAULT_COLUMNS.filter(c => !keys.includes(c.key));
            return [...valid, ...missing];
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

// ─── Period Filter Helpers ────────────────────────────────────────────────────

type PeriodType = 'all' | 'day' | 'week' | 'month' | 'custom';

function toLocalDateStr(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function getDateRangeForPeriod(type: PeriodType, anchor: Date): { from: string; to: string } {
    if (type === 'day') {
        const from = toLocalDateStr(anchor);
        return { from, to: `${from}T23:59:59` };
    }
    if (type === 'week') {
        const d = new Date(anchor);
        const day = d.getDay();
        const diff = day === 0 ? -6 : 1 - day;
        const monday = new Date(d);
        monday.setDate(d.getDate() + diff);
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);
        return { from: toLocalDateStr(monday), to: `${toLocalDateStr(sunday)}T23:59:59` };
    }
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    return { from: toLocalDateStr(first), to: `${toLocalDateStr(last)}T23:59:59` };
}

function shiftPeriod(type: PeriodType, anchor: Date, direction: 1 | -1): Date {
    const d = new Date(anchor);
    if (type === 'day') d.setDate(d.getDate() + direction);
    else if (type === 'week') d.setDate(d.getDate() + direction * 7);
    else if (type === 'month') d.setMonth(d.getMonth() + direction);
    return d;
}

function formatPeriodLabel(type: PeriodType, anchor: Date, locale: string): string {
    if (type === 'day') return anchor.toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' });
    if (type === 'week') {
        const day = anchor.getDay();
        const diff = day === 0 ? -6 : 1 - day;
        const monday = new Date(anchor);
        monday.setDate(anchor.getDate() + diff);
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);
        const monthStr = sunday.toLocaleDateString(locale, { month: 'short' });
        return `${monday.getDate()} — ${sunday.getDate()} ${monthStr} ${sunday.getFullYear()}`;
    }
    return anchor.toLocaleDateString(locale, { month: 'long', year: 'numeric' });
}


export default function LeadsPage() {
    const { t, i18n } = useTranslation();
    const locale = i18n.language === 'en' ? 'en-US' : 'tr-TR';
    const { user, activeTenantId } = useAuth();
    const { allStages, getStageColor, getStageLabel, terminalStageSlugs } = useStages();
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const fromMap = searchParams.get('fromMap') === 'true';

    // Restore table state when coming back from company detail
    const savedState = fromMap ? null : loadLeadsTableState();

    const [page, setPage] = useState(() => savedState?.page ?? 1);
    const [opened, { open, close }] = useDisclosure(false);
    const [editingCompany, setEditingCompany] = useState<Company | null>(null);

    // Search & filter state — initialise from URL param when coming from the map, otherwise restore saved state
    const [search, setSearch] = useState(() => {
        if (fromMap) return searchParams.get('search') || '';
        return savedState?.search ?? '';
    });
    const [debouncedSearch] = useDebouncedValue(search, 300);
    const [selectedStages, setSelectedStages] = useState<string[]>(() => savedState?.selectedStages ?? []);
    const [selectedIndustries, setSelectedIndustries] = useState<string[]>(() => savedState?.selectedIndustries ?? []);
    const [selectedLocations, setSelectedLocations] = useState<string[]>(() => {
        if (fromMap) {
            const loc = searchParams.get('locations');
            return loc ? loc.split(',').filter(Boolean) : [];
        }
        return savedState?.selectedLocations ?? [];
    });
    // Country filter — combined with locations into the single "Konum" dropdown.
    // Initial value comes from globe-map URL param (?country=) or restored sessionStorage.
    const [selectedCountries, setSelectedCountries] = useState<string[]>(() => {
        if (fromMap) {
            const c = searchParams.get('country');
            return c ? c.split(',').filter(Boolean) : [];
        }
        return savedState?.selectedCountries ?? [];
    });
    const [locationSearchValue, setLocationSearchValue] = useState('');
    const [selectedProducts, setSelectedProducts] = useState<string[]>(() => savedState?.selectedProducts ?? []);
    // Owner filter: '' (all), 'me', 'unassigned', or a member UUID.
    // A ?owner= URL param (e.g. dashboard Operations "unowned" card) wins over saved state on entry.
    const [ownerFilter, setOwnerFilter] = useState<string>(() => searchParams.get('owner') || savedState?.owner || '');
    const { data: membersData } = useMembers();
    const [periodType, setPeriodType] = useState<PeriodType>(() => savedState?.periodType ?? 'all');
    const [periodAnchor, setPeriodAnchor] = useState<Date>(() =>
        savedState?.periodAnchor ? new Date(savedState.periodAnchor) : new Date()
    );
    const [customRange, setCustomRange] = useState<[Date | null, Date | null]>(() => {
        if (savedState?.customRange) {
            return [
                savedState.customRange[0] ? new Date(savedState.customRange[0]) : null,
                savedState.customRange[1] ? new Date(savedState.customRange[1]) : null,
            ];
        }
        return [null, null];
    });

    // Sort state
    const [sortBy, setSortBy] = useState<SortKey>(() => savedState?.sortBy ?? 'updated_at');
    const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>(() => savedState?.sortOrder ?? 'desc');

    // Column visibility state
    const [columns, setColumns] = useState<ColumnDef[]>(loadColumnConfig);
    const [colPopoverOpen, setColPopoverOpen] = useState(false);

    // Bulk selection state
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const lastClickedRef = useRef<string | null>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    const undoStack = useUndoStack();
    const [deleteModalCompany, setDeleteModalCompany] = useState<Company | null>(null);
    const [closingReportTarget, setClosingReportTarget] = useState<{
        companyId: string;
        companyName: string;
        targetStage: ClosingOutcome;
    } | null>(null);
    const [reopenTarget, setReopenTarget] = useState<{
        companyId: string;
        companyName: string;
        targetStage: string;
        targetLabel: string;
    } | null>(null);
    const [reopenLoading, setReopenLoading] = useState(false);

    // ── Saved views + CSV export (E11) ────────────────────────────────────────
    const [saveViewOpened, { open: openSaveView, close: closeSaveView }] = useDisclosure(false);
    const [newViewName, setNewViewName] = useState('');
    const [newViewShared, setNewViewShared] = useState(false);
    const [exporting, setExporting] = useState(false);

    const canEdit = canWrite(user?.role || '');

    const periodLabel = formatPeriodLabel(periodType, periodAnchor, locale);

    const dateParams = useMemo(() => {
        if (periodType === 'all') return null;
        if (periodType === 'custom') {
            if (!customRange[0] || !customRange[1]) return null;
            return {
                dateFrom: `${toLocalDateStr(customRange[0] instanceof Date ? customRange[0] : new Date(customRange[0]))}T00:00:00`,
                dateTo: `${toLocalDateStr(customRange[1] instanceof Date ? customRange[1] : new Date(customRange[1]))}T23:59:59`,
            };
        }
        const r = getDateRangeForPeriod(periodType, periodAnchor);
        return { dateFrom: r.from, dateTo: r.to };
    }, [periodType, periodAnchor, customRange]);

    const handleCompanyClick = useCallback((id: string) => {
        sessionStorage.setItem(LEADS_TABLE_STATE_KEY, JSON.stringify({
            page,
            search,
            selectedStages,
            selectedIndustries,
            selectedLocations,
            selectedCountries,
            selectedProducts,
            owner: ownerFilter,
            periodType,
            periodAnchor: periodAnchor.toISOString(),
            customRange: [
                customRange[0]?.toISOString() ?? null,
                customRange[1]?.toISOString() ?? null,
            ],
            sortBy,
            sortOrder,
        } satisfies LeadsTableState));
        navigate(`/companies/${id}`);
    }, [page, search, selectedStages, selectedIndustries, selectedLocations, selectedCountries, selectedProducts, ownerFilter, periodType, periodAnchor, customRange, sortBy, sortOrder, navigate]);

    // Single source of truth for the active filter set — used by the live query AND
    // by CSV export, so an export always matches exactly what's on screen.
    const appendFilterParams = useCallback((params: URLSearchParams) => {
        if (debouncedSearch) params.set('search', debouncedSearch);
        if (selectedStages.length) params.set('stages', selectedStages.join(','));
        if (selectedIndustries.length) params.set('industries', selectedIndustries.join(','));
        if (selectedLocations.length) params.set('locations', selectedLocations.join(','));
        if (selectedCountries.length) params.set('country', selectedCountries.join(','));
        if (selectedProducts.length) params.set('products', selectedProducts.join(','));
        if (ownerFilter) params.set('owner', ownerFilter);
        if (dateParams?.dateFrom) params.set('dateFrom', dateParams.dateFrom);
        if (dateParams?.dateTo) params.set('dateTo', dateParams.dateTo);
    }, [debouncedSearch, selectedStages, selectedIndustries, selectedLocations, selectedCountries, selectedProducts, ownerFilter, dateParams]);

    // Build query params (moved up so useQuery can be before handleRowSelect)
    const buildQueryParams = useCallback(() => {
        const params = new URLSearchParams();
        params.set('page', String(page));
        params.set('limit', '25');
        params.set('sortBy', sortBy);
        params.set('sortOrder', sortOrder);
        appendFilterParams(params);
        return params.toString();
    }, [page, sortBy, sortOrder, appendFilterParams]);

    // Fetch companies (moved up so data is available for handleRowSelect and useHotkeys)
    const { data, isLoading, error } = useQuery<PaginatedResponse>({
        queryKey: ['companies', page, debouncedSearch, selectedStages, selectedIndustries, selectedLocations, selectedCountries, selectedProducts, ownerFilter, sortBy, sortOrder, dateParams],
        queryFn: async () => {
            const res = await api.get(`/companies?${buildQueryParams()}`);
            return res.data;
        },
    });

    // One-time notice when the server had to drop the owner filter from a search
    // (pre-migration-118 DB). The owner Select stays fully usable — the filter just
    // didn't apply to THIS search. Reset once a later response applies it again, so a
    // fresh drop can notify again without spamming on every refetch.
    const ownerDropNotifiedRef = useRef(false);
    useEffect(() => {
        if (data?.owner_filter_dropped) {
            if (!ownerDropNotifiedRef.current) {
                ownerDropNotifiedRef.current = true;
                notifications.show({
                    message: t('owner.filterDropped'),
                    color: 'yellow',
                    autoClose: 6000,
                });
            }
        } else {
            ownerDropNotifiedRef.current = false;
        }
    }, [data?.owner_filter_dropped, t]);

    // Bulk selection computed (after data query)
    const allOnPage = data?.data.map(c => c.id) || [];
    const allSelected = allOnPage.length > 0 && allOnPage.every(id => selectedIds.has(id));
    const someSelected = allOnPage.some(id => selectedIds.has(id));

    const handleRowSelect = useCallback((id: string, shiftKey: boolean) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (shiftKey && lastClickedRef.current && data?.data) {
                // Shift+Click range selection
                const ids = data.data.map(c => c.id);
                const startIdx = ids.indexOf(lastClickedRef.current);
                const endIdx = ids.indexOf(id);
                if (startIdx !== -1 && endIdx !== -1) {
                    const [from, to] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
                    for (let i = from; i <= to; i++) next.add(ids[i]);
                    lastClickedRef.current = id;
                    return next;
                }
            }
            if (next.has(id)) next.delete(id);
            else next.add(id);
            lastClickedRef.current = id;
            return next;
        });
    }, [data?.data]);

    // Page-level keyboard shortcuts
    useHotkeys([
        ['mod+K', () => searchRef.current?.focus()],
        ['mod+F', () => searchRef.current?.focus()],
        ['N', () => { open(); }],
        ['Escape', () => {
            if (selectedIds.size > 0) setSelectedIds(new Set());
            else if (search) setSearch('');
        }],
        ['mod+A', () => {
            if (allOnPage.length > 0) {
                if (allSelected) setSelectedIds(new Set());
                else setSelectedIds(new Set(allOnPage));
            }
        }],
        ['mod+Z', () => {
            const entry = undoStack.pop();
            if (entry) {
                entry.undo();
                showInfo(`${t('shortcuts.undone', 'Geri alındı')}: ${entry.description}`);
            }
        }],
    ]);

    // Clear selection when page/filters change
    useEffect(() => {
        setSelectedIds(new Set());
    }, [page, debouncedSearch, selectedStages, selectedIndustries, selectedLocations, selectedCountries, selectedProducts, ownerFilter]);

    // Bulk stage update mutation with undo support
    const columnLabels: Record<ColumnKey, string> = {
        name: t('company.name'),
        website: t('company.website'),
        stage: t('company.stage'),
        industry: t('company.industry'),
        location: t('company.location'),
        employee_size: t('company.employeeSize'),
        product_services: t('company.productServices'),
        product_portfolio: t('company.productPortfolio'),
        linkedin: t('company.linkedin'),
        company_phone: t('company.companyPhone'),
        company_email: t('company.companyEmail'),
        company_summary: t('company.companySummary'),
        fit_score: t('company.fitScore'),
        custom_field_1: user?.tenantSettings?.custom_field_1_label || t('company.customField1', 'Özel Alan 1'),
        custom_field_2: user?.tenantSettings?.custom_field_2_label || t('company.customField2', 'Özel Alan 2'),
        custom_field_3: user?.tenantSettings?.custom_field_3_label || t('company.customField3', 'Özel Alan 3'),
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
        if (col?.visible && visibleCount <= 1) {
            notifications.show({
                message: t('leads.minOneColumn', 'En az 1 kolon görünür olmalı'),
                color: 'yellow',
                autoClose: 2500,
            });
            return;
        }
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
    }, [debouncedSearch, selectedStages, selectedIndustries, selectedLocations, selectedCountries, selectedProducts, ownerFilter]);

    useEffect(() => {
        setPage(1);
    }, [dateParams]);

    // Fetch filter options
    const { data: filterOptions } = useQuery<FilterOptions>({
        queryKey: ['filterOptions'],
        queryFn: async () => {
            const res = await api.get('/filter-options');
            return res.data;
        },
    });

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
            showSuccess(t('company.deleted'));
            setDeleteModalCompany(null);
        },
        onError: (err) => {
            showErrorFromApi(err);
        },
    });

    const handleEdit = (company: Company) => { setEditingCompany(company); open(); };
    const handleCreate = () => { setEditingCompany(null); open(); };
    const handleFormClose = () => { setEditingCompany(null); close(); };
    const handleDelete = (company: Company) => {
        setDeleteModalCompany(company);
    };

    // Bulk owner (re)assignment for the current selection, with an undo that restores each
    // company's previous owner. assigned_to null moves them to the unassigned queue.
    const bulkAssignOwner = (assigned_to: string | null) => {
        const ids = Array.from(selectedIds);
        if (ids.length === 0) return;
        const oldOwners: Record<string, string | null> = {};
        for (const id of ids) {
            const c = data?.data.find((co) => co.id === id);
            if (c) oldOwners[id] = c.assigned_to;
        }
        api.patch('/companies/bulk-owner', { ids, assigned_to }).then((res) => {
            queryClient.invalidateQueries({ queryKey: ['companies'] });
            queryClient.invalidateQueries({ queryKey: ['statistics'] });
            // Refresh each affected company's detail cache so an open detail view never shows a stale owner.
            ids.forEach((id) => queryClient.invalidateQueries({ queryKey: ['company', id] }));
            undoStack.push({
                description: t('owner.bulkAssigned'),
                undo: async () => {
                    const grouped = new Map<string | null, string[]>();
                    for (const id of ids) {
                        const old = oldOwners[id] ?? null;
                        if (!grouped.has(old)) grouped.set(old, []);
                        grouped.get(old)!.push(id);
                    }
                    for (const [owner, ownerIds] of grouped) {
                        await api.patch('/companies/bulk-owner', { ids: ownerIds, assigned_to: owner });
                    }
                    queryClient.invalidateQueries({ queryKey: ['companies'] });
                    queryClient.invalidateQueries({ queryKey: ['statistics'] });
                    ids.forEach((id) => queryClient.invalidateQueries({ queryKey: ['company', id] }));
                },
            });
            setSelectedIds(new Set());
            showSuccess(t('owner.bulkAssignedCount', { count: res.data?.updated ?? ids.length }));
        }).catch((err) => showErrorFromApi(err));
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
        const date = new Date(dateStr);
        const isCurrentYear = date.getFullYear() === new Date().getFullYear();
        return date.toLocaleDateString(undefined, {
            year: isCurrentYear ? undefined : 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    };

    const hasActiveFilters = !!(debouncedSearch || selectedStages.length || selectedIndustries.length || selectedLocations.length || selectedCountries.length || selectedProducts.length || ownerFilter);

    const clearAllFilters = () => {
        setSearch('');
        setSelectedStages([]);
        setSelectedIndustries([]);
        setSelectedLocations([]);
        setSelectedCountries([]);
        setSelectedProducts([]);
        setOwnerFilter('');
        setPeriodType('all');
        setPeriodAnchor(new Date());
        setCustomRange([null, null]);
    };

    // ── Saved views + favorites/recents data (E11) ────────────────────────────
    // All three lists are per-tenant (views also include team-shared ones). They
    // share their query cache with CompanyDetailPage, so a star toggled there
    // reflects here without a manual refetch.
    // D4 tenant-isolation pattern: key on activeTenantId, don't fetch until a tenant
    // is resolved, and PIN the tenant into the request header from the tenant this
    // query was keyed on — so a refetch of a stale key (right after a tenant switch)
    // can't read another tenant's rows. `signal` lets React Query abort in-flight
    // requests when the key changes.
    const { data: savedViewsData } = useQuery<{ data: SavedView[] }>({
        queryKey: ['saved-views', 'companies', activeTenantId],
        enabled: !!activeTenantId,
        queryFn: async ({ signal }) =>
            (await api.get('/views/saved?entity_type=companies', { headers: { 'X-Tenant-Id': activeTenantId! }, signal })).data,
    });
    const savedViews = savedViewsData?.data ?? [];
    const myViews = savedViews.filter((v) => v.is_owner);
    const sharedViews = savedViews.filter((v) => !v.is_owner && v.is_shared);

    const { data: favoritesData } = useQuery<{ data: EntityRef[] }>({
        queryKey: ['favorites', 'companies', activeTenantId],
        enabled: !!activeTenantId,
        queryFn: async ({ signal }) =>
            (await api.get('/views/favorites?entity_type=companies', { headers: { 'X-Tenant-Id': activeTenantId! }, signal })).data,
    });
    const favorites = useMemo(() => favoritesData?.data ?? [], [favoritesData]);
    const favoriteIds = useMemo(() => new Set(favorites.map((f) => f.entity_id)), [favorites]);

    const { data: recentsData } = useQuery<{ data: EntityRef[] }>({
        queryKey: ['recents', 'companies', activeTenantId],
        enabled: !!activeTenantId,
        queryFn: async ({ signal }) =>
            (await api.get('/views/recents?entity_type=companies', { headers: { 'X-Tenant-Id': activeTenantId! }, signal })).data,
    });
    const recents = recentsData?.data ?? [];

    const favoriteToggle = useMutation({
        mutationFn: async (entityId: string) =>
            (await api.post('/views/favorites/toggle', { entity_type: 'companies', entity_id: entityId })).data,
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['favorites', 'companies', activeTenantId] }),
        onError: (err) => showErrorFromApi(err),
    });

    // Serialize the current filter/column set into the forward-compatible bags the
    // saved_views table stores. `search` (not the debounced copy) captures exactly
    // what the user typed at save time.
    const buildViewFilters = useCallback((): SavedViewFilters => ({
        ...(search ? { search } : {}),
        ...(selectedStages.length ? { stages: selectedStages } : {}),
        ...(selectedIndustries.length ? { industries: selectedIndustries } : {}),
        ...(selectedLocations.length ? { locations: selectedLocations } : {}),
        ...(selectedCountries.length ? { countries: selectedCountries } : {}),
        ...(selectedProducts.length ? { products: selectedProducts } : {}),
        ...(ownerFilter ? { owner: ownerFilter } : {}),
        periodType,
        periodAnchor: periodAnchor.toISOString(),
        customRange: [customRange[0]?.toISOString() ?? null, customRange[1]?.toISOString() ?? null],
    }), [search, selectedStages, selectedIndustries, selectedLocations, selectedCountries, selectedProducts, ownerFilter, periodType, periodAnchor, customRange]);

    const saveViewMutation = useMutation({
        mutationFn: async () =>
            (await api.post('/views/saved', {
                name: newViewName.trim(),
                entity_type: 'companies',
                filters: buildViewFilters(),
                columns: { visible: columns, sortBy, sortOrder } satisfies SavedViewColumns,
                is_shared: newViewShared,
            })).data,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['saved-views', 'companies', activeTenantId] });
            showSuccess(t('savedViews.savedToast'));
            closeSaveView();
            setNewViewName('');
            setNewViewShared(false);
        },
        onError: (err) => showErrorFromApi(err),
    });

    const handleSaveView = () => {
        if (!newViewName.trim()) {
            showInfo(t('savedViews.nameRequired'));
            return;
        }
        saveViewMutation.mutate();
    };

    const shareToggleMutation = useMutation({
        mutationFn: async (view: { id: string; is_shared: boolean }) =>
            (await api.put(`/views/saved/${view.id}`, { is_shared: view.is_shared })).data,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['saved-views', 'companies', activeTenantId] });
            showSuccess(t('savedViews.updatedToast'));
        },
        onError: (err) => showErrorFromApi(err),
    });

    const deleteViewMutation = useMutation({
        mutationFn: async (viewId: string) => { await api.delete(`/views/saved/${viewId}`); },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['saved-views', 'companies', activeTenantId] });
            showSuccess(t('savedViews.deletedToast'));
        },
        onError: (err) => showErrorFromApi(err),
    });

    // Re-validate a stored column bag against the current schema: drop unknown keys,
    // append any columns added since the view was saved (mirrors loadColumnConfig).
    const sanitizeSavedColumns = (visible: unknown): ColumnDef[] | null => {
        if (!Array.isArray(visible)) return null;
        const valid = visible.filter(
            (c): c is ColumnDef => !!c && typeof c === 'object' && VALID_COLUMN_KEYS.has((c as ColumnDef).key),
        );
        if (valid.length === 0) return null;
        const keys = valid.map((c) => c.key);
        const missing = DEFAULT_COLUMNS.filter((c) => !keys.includes(c.key));
        return [...valid.map((c) => ({ key: c.key, visible: !!c.visible })), ...missing];
    };

    // Apply a saved view — forward-compatible AND untrusting. A SHARED view's filter
    // bag is authored by another user, so every field is validated against a
    // whitelist/type before it touches state: unknown keys are ignored, malformed
    // fields fall back to their default. Nothing here can crash or inject a bad value.
    const applyView = (v: SavedView) => {
        const f: SavedViewFilters = (v.filters && typeof v.filters === 'object' && !Array.isArray(v.filters))
            ? v.filters
            : {};
        // Array filters → string[] with a sane per-field size cap (drops non-strings,
        // over-long entries, and caps count so a hostile bag can't balloon state).
        const MAX_ITEMS = 200;
        const MAX_ITEM_LEN = 500;
        const asStrings = (x: unknown): string[] =>
            Array.isArray(x)
                ? x.filter((s): s is string => typeof s === 'string' && s.length <= MAX_ITEM_LEN).slice(0, MAX_ITEMS)
                : [];
        // A finite, parseable date string → its ISO form, else null.
        const asDate = (x: unknown): Date | null => {
            if (typeof x !== 'string' || x.length === 0) return null;
            const d = new Date(x);
            return Number.isFinite(d.getTime()) ? d : null;
        };
        setSearch(typeof f.search === 'string' ? f.search.slice(0, MAX_ITEM_LEN) : '');
        setSelectedStages(asStrings(f.stages));
        setSelectedIndustries(asStrings(f.industries));
        setSelectedLocations(asStrings(f.locations));
        setSelectedCountries(asStrings(f.countries));
        setSelectedProducts(asStrings(f.products));
        // Owner filter is '' (all), 'me', 'unassigned', or a member UUID — nothing else.
        const owner = typeof f.owner === 'string' ? f.owner : '';
        setOwnerFilter(owner === 'me' || owner === 'unassigned' || UUID_RE.test(owner) ? owner : '');
        const validPeriods: PeriodType[] = ['all', 'day', 'week', 'month', 'custom'];
        setPeriodType(validPeriods.includes(f.periodType as PeriodType) ? (f.periodType as PeriodType) : 'all');
        setPeriodAnchor(asDate(f.periodAnchor) ?? new Date());
        if (Array.isArray(f.customRange)) {
            setCustomRange([asDate(f.customRange[0]), asDate(f.customRange[1])]);
        } else {
            setCustomRange([null, null]);
        }
        const savedCols = sanitizeSavedColumns(v.columns?.visible);
        if (savedCols) saveColumns(savedCols);
        const savedSortBy = v.columns?.sortBy;
        if (savedSortBy && SORTABLE_COLUMNS.has(savedSortBy)) setSortBy(savedSortBy);
        const savedSortOrder = v.columns?.sortOrder;
        if (savedSortOrder === 'asc' || savedSortOrder === 'desc') setSortOrder(savedSortOrder);
        setPage(1);
        showInfo(t('savedViews.appliedToast'));
    };

    // Plain-text value for a single CSV cell, mirroring what the on-screen column shows.
    const csvCellValue = (company: Company, key: ColumnKey): string => {
        switch (key) {
            case 'name': return company.name ?? '';
            case 'website': return company.website ?? '';
            case 'stage': return getStageLabel(company.stage);
            case 'industry': return company.industry ?? '';
            case 'location': return company.location ?? '';
            case 'employee_size': return company.employee_size ?? '';
            case 'product_services': return (company.product_services ?? []).join('; ');
            case 'product_portfolio': return (company.product_portfolio ?? []).join('; ');
            case 'linkedin': return company.linkedin ?? '';
            case 'company_phone': return company.company_phone ?? '';
            case 'company_email': return company.company_email ?? '';
            case 'company_summary': return company.company_summary ?? '';
            case 'next_step': return company.next_step ?? '';
            case 'assigned_to': return company.assigned_user?.name || company.assigned_user?.email || '';
            case 'contact_count': return String(company.contact_count ?? 0);
            case 'fit_score': return company.fit_score ?? '';
            case 'custom_field_1': return company.custom_field_1 ?? '';
            case 'custom_field_2': return company.custom_field_2 ?? '';
            case 'custom_field_3': return company.custom_field_3 ?? '';
            case 'created_at': return company.created_at ?? '';
            case 'updated_at': return company.updated_at ?? '';
            default: return '';
        }
    };

    // Export the ACTIVE filtered set (matching the on-screen filters + sort + visible
    // columns) as CSV. Pages the same /companies endpoint the table uses, capped so a
    // huge set can't fan out into hundreds of requests.
    const handleExportCsv = async () => {
        setExporting(true);
        try {
            const rows: Company[] = [];
            let capped = false;
            for (let p = 1; p <= CSV_EXPORT_MAX_PAGES; p++) {
                const params = new URLSearchParams();
                params.set('page', String(p));
                params.set('limit', String(CSV_EXPORT_PAGE_SIZE));
                params.set('sortBy', sortBy);
                params.set('sortOrder', sortOrder);
                appendFilterParams(params);
                const res = await api.get(`/companies?${params.toString()}`);
                const batch: Company[] = res.data?.data ?? [];
                rows.push(...batch);
                const total: number = res.data?.pagination?.total ?? rows.length;
                if (batch.length < CSV_EXPORT_PAGE_SIZE || rows.length >= total) break;
                if (p === CSV_EXPORT_MAX_PAGES && rows.length < total) capped = true;
            }
            if (rows.length === 0) {
                showInfo(t('savedViews.exportEmpty'));
                return;
            }
            const cols = visibleColumns;
            // Neutralize CSV/spreadsheet formula injection: a cell whose (optionally
            // whitespace-led) first char is =, +, - or @ gets a leading apostrophe so
            // Excel/Sheets treat it as text, NOT a formula. Then apply standard quoting.
            const escape = (val: string) => {
                const guarded = /^[\s]*[=+\-@]/.test(val) ? `'${val}` : val;
                return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
            };
            const lines = [cols.map((c) => escape(columnLabels[c.key])).join(',')];
            for (const company of rows) {
                lines.push(cols.map((c) => escape(csvCellValue(company, c.key))).join(','));
            }
            // Prefix a UTF-8 BOM so Excel opens Turkish characters correctly.
            const csv = '\ufeff' + lines.join('\r\n');
            const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `companies-${toLocalDateStr(new Date())}.csv`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            if (capped) showInfo(t('savedViews.exportCapped', { count: CSV_EXPORT_MAX_PAGES * CSV_EXPORT_PAGE_SIZE }));
        } catch (err) {
            showErrorFromApi(err);
        } finally {
            setExporting(false);
        }
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
                    <Table.Td key="stage" onClick={(e) => e.stopPropagation()}>
                        <Menu withinPortal position="bottom-start" shadow="md">
                            <Menu.Target>
                                <Badge
                                    color={getStageColor(company.stage)}
                                    variant="light"
                                    size="sm"
                                    radius="sm"
                                    rightSection={<IconChevronDown size={12} />}
                                    style={{ cursor: 'pointer', paddingRight: 4 }}
                                >
                                    {getStageLabel(company.stage)}
                                </Badge>
                            </Menu.Target>
                            <Menu.Dropdown>
                                {(() => {
                                    const isSelected = selectedIds.has(company.id);
                                    const affectedCount = isSelected && selectedIds.size > 1 ? selectedIds.size : 1;
                                    const affectedLabel = affectedCount > 1
                                        ? `${affectedCount} ${t('bulk.selected', 'seçili şirketin aşaması değişecek')}`
                                        : `${t('bulk.onlyThis', 'Yalnızca')} ${company.name}`;
                                    return <Menu.Label>{affectedLabel}</Menu.Label>;
                                })()}
                                {allStages.map((s) => (
                                    <Menu.Item
                                        key={s.slug}
                                        onClick={() => {
                                            const isBulk = selectedIds.has(company.id) && selectedIds.size > 1;
                                            if (terminalStageSlugs.includes(s.slug)) {
                                                if (isBulk) {
                                                    showInfo(t('bulk.terminalNotBulk', 'Sonuç aşamaları toplu olarak değiştirilemez. Her şirket için ayrı sonlandırma raporu gereklidir.'));
                                                } else {
                                                    setClosingReportTarget({
                                                        companyId: company.id,
                                                        companyName: company.name,
                                                        targetStage: s.slug as ClosingOutcome,
                                                    });
                                                }
                                                return;
                                            }
                                            // Single-row reopen: a closed company moving to a non-terminal stage needs a
                                            // reason, so route it through PATCH /:id/stage (not the reason-less bulk path).
                                            // Bulk reopens are rejected server-side (422) and surfaced via showErrorFromApi.
                                            if (!isBulk && terminalStageSlugs.includes(company.stage)) {
                                                setReopenTarget({
                                                    companyId: company.id,
                                                    companyName: company.name,
                                                    targetStage: s.slug,
                                                    targetLabel: getStageLabel(s.slug),
                                                });
                                                return;
                                            }
                                            const ids = isBulk
                                                ? Array.from(selectedIds)
                                                : [company.id];
                                            const oldStages: Record<string, string> = {};
                                            for (const id of ids) {
                                                const c = data?.data.find(co => co.id === id);
                                                if (c) oldStages[id] = c.stage;
                                            }
                                            api.patch('/companies/bulk-stage', { ids, stage: s.slug }).then(() => {
                                                queryClient.invalidateQueries({ queryKey: ['companies'] });
                                                queryClient.invalidateQueries({ queryKey: ['filterOptions'] });
                                                queryClient.invalidateQueries({ queryKey: ['statistics'] });
                                                queryClient.invalidateQueries({ queryKey: ['pipeline'] });
                                                undoStack.push({
                                                    description: t('bulk.stageChanged', 'Aşama değişikliği'),
                                                    undo: async () => {
                                                        const grouped = new Map<string, string[]>();
                                                        for (const id of ids) {
                                                            const old = oldStages[id];
                                                            if (old) {
                                                                if (!grouped.has(old)) grouped.set(old, []);
                                                                grouped.get(old)!.push(id);
                                                            }
                                                        }
                                                        for (const [stage, stageIds] of grouped) {
                                                            await api.patch('/companies/bulk-stage', { ids: stageIds, stage });
                                                        }
                                                        queryClient.invalidateQueries({ queryKey: ['companies'] });
                                                        queryClient.invalidateQueries({ queryKey: ['pipeline'] });
                                                        queryClient.invalidateQueries({ queryKey: ['statistics'] });
                                                    },
                                                });
                                                if (selectedIds.size > 0) setSelectedIds(new Set());
                                                showSuccess(t('company.updated'));
                                            }).catch((err) => showErrorFromApi(err));
                                        }}
                                        leftSection={
                                            <Badge color={s.color} variant="light" size="xs" radius="sm">
                                                {' '}
                                            </Badge>
                                        }
                                    >
                                        <Text size="sm" fw={company.stage === s.slug ? 700 : 400}>
                                            {getStageLabel(s.slug)}
                                        </Text>
                                    </Menu.Item>
                                ))}
                            </Menu.Dropdown>
                        </Menu>
                    </Table.Td>
                );
            case 'industry':
                return <Table.Td key="industry"><TruncatedText size="sm">{company.industry}</TruncatedText></Table.Td>;
            case 'location':
                return (
                    <Table.Td key="location">
                        <Group gap={4} wrap="nowrap">
                            <TruncatedText size="sm">{company.location}</TruncatedText>
                            {company.latitude != null && (
                                <Tooltip label={t('company.geocoded')} withArrow>
                                    <IconMapPin size={14} color="var(--mantine-color-teal-6)" style={{ flexShrink: 0 }} />
                                </Tooltip>
                            )}
                        </Group>
                    </Table.Td>
                );
            case 'employee_size':
                return <Table.Td key="employee_size"><TruncatedText size="sm">{company.employee_size}</TruncatedText></Table.Td>;
            case 'product_services':
                return (
                    <Table.Td key="product_services">
                        <TruncatedText size="sm">{company.product_services?.join(', ')}</TruncatedText>
                    </Table.Td>
                );
            case 'product_portfolio':
                return (
                    <Table.Td key="product_portfolio">
                        <TruncatedText size="sm">{company.product_portfolio?.join(', ')}</TruncatedText>
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
            case 'company_summary':
                return (
                    <Table.Td key="company_summary">
                        <TruncatedText size="sm">{company.company_summary}</TruncatedText>
                    </Table.Td>
                );
            case 'fit_score':
                return (
                    <Table.Td key="fit_score">
                        <TruncatedText size="sm">{company.fit_score}</TruncatedText>
                    </Table.Td>
                );
            case 'custom_field_1':
                return (
                    <Table.Td key="custom_field_1">
                        <TruncatedText size="sm">{company.custom_field_1}</TruncatedText>
                    </Table.Td>
                );
            case 'custom_field_2':
                return (
                    <Table.Td key="custom_field_2">
                        <TruncatedText size="sm">{company.custom_field_2}</TruncatedText>
                    </Table.Td>
                );
            case 'custom_field_3':
                return (
                    <Table.Td key="custom_field_3">
                        <TruncatedText size="sm">{company.custom_field_3}</TruncatedText>
                    </Table.Td>
                );
            case 'next_step':
                return (
                    <Table.Td key="next_step">
                        <TruncatedText size="sm">{company.next_step}</TruncatedText>
                    </Table.Td>
                );
            case 'assigned_to':
                return (
                    <Table.Td key="assigned_to">
                        <TruncatedText size="sm">
                            {company.assigned_user?.name || company.assigned_user?.email || null}
                        </TruncatedText>
                    </Table.Td>
                );
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
        value: s, label: getStageLabel(s),
    }));
    const industryOptions = (filterOptions?.industries || []).map((s) => ({
        value: s, label: s,
    }));
    // Combined "Konum" dropdown — countries always visible; specific location strings
    // appear only when the user starts typing (≥2 chars) so the default list stays short.
    // Values are prefixed (c:Turkey / l:Istanbul) so onChange can split them back into
    // selectedCountries vs selectedLocations. Special tokens (__empty__, __not_geocoded__)
    // remain unprefixed.
    //
    // Country labels are localized: in Turkish locale we display "Türkiye" while the
    // value stays "Turkey" (the canonical English form stored in the DB). The Mantine
    // searchable filter then matches against the display label, so users can type in
    // their own language. The localizedToCanonical map lets us also match the canonical
    // form so EN typists searching in a TR locale (or vice versa) still find results.
    const { locationGroupedData, locationSearchHaystack } = useMemo(() => {
        const lang = i18n.language;
        const countrySet = new Set(filterOptions?.countries || []);
        const haystack: Record<string, string> = {};

        const groups: { group: string; items: { value: string; label: string }[] }[] = [
            {
                group: t('filter.specialGroup', 'Özel'),
                items: [
                    { value: '__empty__', label: t('filter.emptyLocation') },
                    { value: '__not_geocoded__', label: t('filter.notGeocoded') },
                ],
            },
        ];

        const countryItems = (filterOptions?.countries || []).map((c) => {
            const value = `c:${c}`;
            const localized = localizeCountry(c, lang);
            haystack[value] = `${localized} ${c}`.toLowerCase();
            return { value, label: localized };
        });
        if (countryItems.length > 0) {
            groups.push({ group: t('filter.countriesGroup', 'Ülkeler'), items: countryItems });
        }

        if (locationSearchValue.trim().length >= 2) {
            const cityItems = (filterOptions?.locations || [])
                .filter((l) => !countrySet.has(l))
                .map((l) => {
                    const value = `l:${l}`;
                    haystack[value] = l.toLowerCase();
                    return { value, label: l };
                });
            if (cityItems.length > 0) {
                groups.push({ group: t('filter.locationsGroup', 'Konumlar'), items: cityItems });
            }
        }

        return { locationGroupedData: groups, locationSearchHaystack: haystack };
    }, [filterOptions, locationSearchValue, t, i18n.language]);

    const locationSelectValue = useMemo(() => [
        ...selectedCountries.map((c) => `c:${c}`),
        ...selectedLocations.map((l) => (l.startsWith('__') ? l : `l:${l}`)),
    ], [selectedCountries, selectedLocations]);

    const handleLocationChange = useCallback((values: string[]) => {
        const cs: string[] = [];
        const ls: string[] = [];
        for (const v of values) {
            if (v.startsWith('c:')) cs.push(v.slice(2));
            else if (v.startsWith('l:')) ls.push(v.slice(2));
            else ls.push(v); // __empty__, __not_geocoded__
        }
        setSelectedCountries(cs);
        setSelectedLocations(ls);
    }, []);
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
                    {selectedCountries.length > 0 && (
                        <Badge variant="light" color="violet" size="md" radius="md">
                            {selectedCountries.join(', ')}
                        </Badge>
                    )}
                </Group>
            )}
            {/* Header */}
            <Flex justify="space-between" align="center" mb="lg">
                <CompaniesPeopleToggle />
                <Group gap="xs" justify="flex-end" wrap="wrap">
                    {/* Saved views (E11) — apply is open to everyone; save/share/delete gated */}
                    <Popover position="bottom-end" shadow="md" width={300} withinPortal>
                        <Popover.Target>
                            <Button
                                variant="default"
                                radius="md"
                                leftSection={<IconBookmark size={16} />}
                                rightSection={<IconChevronDown size={14} />}
                            >
                                {t('savedViews.menu')}
                            </Button>
                        </Popover.Target>
                        <Popover.Dropdown p="sm">
                            {canEdit && (
                                <>
                                    <Button
                                        fullWidth
                                        size="xs"
                                        variant="light"
                                        color="violet"
                                        leftSection={<IconDeviceFloppy size={14} />}
                                        onClick={() => { setNewViewName(''); setNewViewShared(false); openSaveView(); }}
                                    >
                                        {t('savedViews.save')}
                                    </Button>
                                    <Divider my="xs" />
                                </>
                            )}
                            {savedViews.length === 0 ? (
                                <Text size="xs" c="dimmed" ta="center" py="xs">{t('savedViews.empty')}</Text>
                            ) : (
                                <Stack gap={4}>
                                    {myViews.length > 0 && (
                                        <>
                                            <Text size="xs" fw={700} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.5px' }}>
                                                {t('savedViews.mine')}
                                            </Text>
                                            {myViews.map((v) => (
                                                <Group key={v.id} gap={4} wrap="nowrap" justify="space-between">
                                                    <UnstyledButton style={{ flex: 1, minWidth: 0 }} onClick={() => applyView(v)}>
                                                        <Text size="sm" truncate>{v.name}</Text>
                                                    </UnstyledButton>
                                                    <Group gap={2} wrap="nowrap">
                                                        <Tooltip label={t('savedViews.shareToggle')} withArrow>
                                                            <ActionIcon
                                                                variant="subtle"
                                                                size="sm"
                                                                color={v.is_shared ? 'violet' : 'gray'}
                                                                onClick={() => shareToggleMutation.mutate({ id: v.id, is_shared: !v.is_shared })}
                                                            >
                                                                <IconShare size={14} />
                                                            </ActionIcon>
                                                        </Tooltip>
                                                        <Tooltip label={t('savedViews.delete')} withArrow>
                                                            <ActionIcon
                                                                variant="subtle"
                                                                size="sm"
                                                                color="red"
                                                                onClick={() => deleteViewMutation.mutate(v.id)}
                                                            >
                                                                <IconTrash size={14} />
                                                            </ActionIcon>
                                                        </Tooltip>
                                                    </Group>
                                                </Group>
                                            ))}
                                        </>
                                    )}
                                    {sharedViews.length > 0 && (
                                        <>
                                            {myViews.length > 0 && <Divider my={4} />}
                                            <Text size="xs" fw={700} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.5px' }}>
                                                {t('savedViews.shared')}
                                            </Text>
                                            {sharedViews.map((v) => (
                                                <Group key={v.id} gap={4} wrap="nowrap" justify="space-between">
                                                    <UnstyledButton style={{ flex: 1, minWidth: 0 }} onClick={() => applyView(v)}>
                                                        <Text size="sm" truncate>{v.name}</Text>
                                                    </UnstyledButton>
                                                    <Badge size="xs" variant="light" color="violet">{t('savedViews.sharedBadge')}</Badge>
                                                </Group>
                                            ))}
                                        </>
                                    )}
                                </Stack>
                            )}
                        </Popover.Dropdown>
                    </Popover>

                    {/* Favorites + recently viewed (E11) — personal, multi-device */}
                    <Popover position="bottom-end" shadow="md" width={300} withinPortal>
                        <Popover.Target>
                            <Button
                                variant="default"
                                radius="md"
                                leftSection={<IconStar size={16} />}
                                rightSection={<IconChevronDown size={14} />}
                            >
                                {t('savedViews.favorites')}
                            </Button>
                        </Popover.Target>
                        <Popover.Dropdown p="sm">
                            <Text size="xs" fw={700} c="dimmed" tt="uppercase" mb={4} style={{ letterSpacing: '0.5px' }}>
                                {t('savedViews.favorites')}
                            </Text>
                            {favorites.length === 0 ? (
                                <Text size="xs" c="dimmed" py={4}>{t('savedViews.favoritesEmpty')}</Text>
                            ) : (
                                <Stack gap={2} mb="xs">
                                    {favorites.map((f) => (
                                        <Group key={f.entity_id} gap={4} wrap="nowrap" justify="space-between">
                                            <UnstyledButton style={{ flex: 1, minWidth: 0 }} onClick={() => handleCompanyClick(f.entity_id)}>
                                                <Text size="sm" truncate>{f.name ?? '—'}</Text>
                                            </UnstyledButton>
                                            <Tooltip label={t('savedViews.removeFavorite')} withArrow>
                                                <ActionIcon
                                                    variant="subtle"
                                                    size="sm"
                                                    color="yellow"
                                                    onClick={() => favoriteToggle.mutate(f.entity_id)}
                                                >
                                                    <IconStarFilled size={14} />
                                                </ActionIcon>
                                            </Tooltip>
                                        </Group>
                                    ))}
                                </Stack>
                            )}
                            <Divider my="xs" />
                            <Text size="xs" fw={700} c="dimmed" tt="uppercase" mb={4} style={{ letterSpacing: '0.5px' }}>
                                {t('savedViews.recents')}
                            </Text>
                            {recents.length === 0 ? (
                                <Text size="xs" c="dimmed" py={4}>{t('savedViews.recentsEmpty')}</Text>
                            ) : (
                                <Stack gap={2}>
                                    {recents.map((r) => (
                                        <UnstyledButton key={r.entity_id} onClick={() => handleCompanyClick(r.entity_id)}>
                                            <Text size="sm" truncate>{r.name ?? '—'}</Text>
                                        </UnstyledButton>
                                    ))}
                                </Stack>
                            )}
                        </Popover.Dropdown>
                    </Popover>

                    {/* Export the active filtered set as CSV (E11) */}
                    <Button
                        variant="default"
                        radius="md"
                        leftSection={<IconDownload size={16} />}
                        loading={exporting}
                        onClick={handleExportCsv}
                    >
                        {t('savedViews.exportCsv')}
                    </Button>

                    {canEdit && (
                        <>
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
                        </>
                    )}
                </Group>
            </Flex>

            {/* Search & Filters */}
            <Paper shadow="sm" radius="lg" p="md" mb="md" withBorder>
                <Group grow>
                    <TextInput
                        ref={searchRef}
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
                        placeholder={selectedStages.length === 0 ? t('filter.stage') : undefined}
                        data={stageOptions}
                        value={selectedStages}
                        onChange={setSelectedStages}
                        clearable
                        radius="md"
                        maxDropdownHeight={200}
                    />
                    <MultiSelect
                        placeholder={selectedIndustries.length === 0 ? t('filter.industry') : undefined}
                        data={industryOptions}
                        value={selectedIndustries}
                        onChange={setSelectedIndustries}
                        clearable
                        radius="md"
                        maxDropdownHeight={200}
                    />
                    <MultiSelect
                        placeholder={locationSelectValue.length === 0 ? t('filter.locationOrCountry', 'Konum veya ülke ara') : undefined}
                        data={locationGroupedData}
                        value={locationSelectValue}
                        onChange={handleLocationChange}
                        searchable
                        searchValue={locationSearchValue}
                        onSearchChange={setLocationSearchValue}
                        // Match against both the localized label and the canonical English
                        // form (e.g. "Türkiye" + "Turkey"), so search works regardless of
                        // which language the user types in.
                        filter={({ options, search }) => {
                            const q = search.trim().toLowerCase();
                            if (!q) return options;
                            const matches = (value: string, label: string) => {
                                const hay = locationSearchHaystack[value] ?? label.toLowerCase();
                                return hay.includes(q);
                            };
                            return options
                                .map((opt) => {
                                    if ('group' in opt) {
                                        const items = opt.items.filter((it) => matches(it.value, it.label));
                                        return items.length > 0 ? { ...opt, items } : null;
                                    }
                                    return matches(opt.value, opt.label) ? opt : null;
                                })
                                .filter((o): o is NonNullable<typeof o> => o !== null);
                        }}
                        nothingFoundMessage={locationSearchValue.trim().length >= 2 ? t('filter.noMatch', 'Sonuç bulunamadı') : t('filter.typeToSearchCity', 'Şehir aramak için yazın')}
                        clearable
                        radius="md"
                        maxDropdownHeight={260}
                    />
                    <MultiSelect
                        placeholder={selectedProducts.length === 0 ? t('filter.product') : undefined}
                        data={productOptions}
                        value={selectedProducts}
                        onChange={setSelectedProducts}
                        clearable
                        searchable
                        radius="md"
                        maxDropdownHeight={200}
                    />
                    <Select
                        placeholder={t('owner.filterPlaceholder')}
                        data={[
                            { value: 'me', label: t('owner.myLeads') },
                            { value: 'unassigned', label: t('owner.unassigned') },
                            ...(membersData?.members ?? []).map((m) => ({ value: m.id, label: m.name || m.email })),
                        ]}
                        value={ownerFilter || null}
                        onChange={(v) => setOwnerFilter(v || '')}
                        clearable
                        searchable
                        radius="md"
                        maxDropdownHeight={240}
                    />
                </Group>
                <Group mt="xs" gap="xs" wrap="nowrap" justify="flex-end">
                    <SegmentedControl
                        size="xs"
                        value={periodType}
                        onChange={(v) => {
                            setPeriodType(v as PeriodType);
                            setPeriodAnchor(new Date());
                            setCustomRange([null, null]);
                            setPage(1);
                        }}
                        data={[
                            { label: t('activities.periodAll'), value: 'all' },
                            { label: t('activities.periodDay'), value: 'day' },
                            { label: t('activities.periodWeek'), value: 'week' },
                            { label: t('activities.periodMonth'), value: 'month' },
                            { label: t('activities.periodCustom'), value: 'custom' },
                        ]}
                    />

                    {periodType !== 'custom' && periodType !== 'all' && (
                        <Group gap={4} wrap="nowrap">
                            <ActionIcon
                                variant="subtle"
                                color="gray"
                                size="sm"
                                onClick={() => { setPeriodAnchor((prev) => shiftPeriod(periodType, prev, -1)); setPage(1); }}
                            >
                                <IconChevronLeft size={14} />
                            </ActionIcon>
                            <Text size="xs" fw={600} miw={120} ta="center">
                                {periodLabel}
                            </Text>
                            <ActionIcon
                                variant="subtle"
                                color="gray"
                                size="sm"
                                onClick={() => { setPeriodAnchor((prev) => shiftPeriod(periodType, prev, 1)); setPage(1); }}
                            >
                                <IconChevronRight size={14} />
                            </ActionIcon>
                            <Button
                                size="compact-xs"
                                variant="light"
                                color="violet"
                                onClick={() => { setPeriodAnchor(new Date()); setPage(1); }}
                            >
                                {t('activities.today')}
                            </Button>
                        </Group>
                    )}

                    {periodType === 'custom' && (
                        <DatePickerInput
                            type="range"
                            placeholder={t('activities.dateRange')}
                            value={customRange}
                            onChange={(v) => { setCustomRange(v as [Date | null, Date | null]); setPage(1); }}
                            leftSection={<IconCalendar size={16} />}
                            clearable
                            size="xs"
                        />
                    )}
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
                        {canEdit && (
                            <Menu withinPortal position="bottom-end" shadow="md" width={240}>
                                <Menu.Target>
                                    <Button
                                        variant="light"
                                        color="violet"
                                        size="xs"
                                        leftSection={<IconUser size={14} />}
                                        rightSection={<IconChevronDown size={14} />}
                                    >
                                        {t('owner.assignOwner')}
                                    </Button>
                                </Menu.Target>
                                <Menu.Dropdown>
                                    <Menu.Label>
                                        {t('owner.bulkAffected', { count: selectedIds.size })}
                                    </Menu.Label>
                                    <Menu.Item onClick={() => bulkAssignOwner(user?.id ?? null)}>
                                        {t('owner.assignToMe')}
                                    </Menu.Item>
                                    <Menu.Item onClick={() => bulkAssignOwner(null)}>
                                        {t('owner.setUnassigned')}
                                    </Menu.Item>
                                    {(membersData?.members ?? []).length > 0 && <Menu.Divider />}
                                    <ScrollArea.Autosize mah={220}>
                                        {(membersData?.members ?? []).map((m) => (
                                            <Menu.Item key={m.id} onClick={() => bulkAssignOwner(m.id)}>
                                                {m.name || m.email}
                                            </Menu.Item>
                                        ))}
                                    </ScrollArea.Autosize>
                                </Menu.Dropdown>
                            </Menu>
                        )}
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
                                            <Popover.Dropdown p="sm" style={{ minWidth: 240, maxHeight: 400, overflowY: 'auto' }}>
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
                                        onClick={() => handleCompanyClick(company.id)}
                                    >
                                        <Table.Td
                                            style={{ width: 48, padding: '0 8px' }}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                handleRowSelect(company.id, e.shiftKey);
                                            }}
                                        >
                                            <Checkbox
                                                checked={selectedIds.has(company.id)}
                                                onChange={() => {}}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleRowSelect(company.id, e.shiftKey);
                                                }}
                                                size="sm"
                                                color="violet"
                                                styles={{ input: { cursor: 'pointer' }, root: { padding: 4 } }}
                                            />
                                        </Table.Td>
                                        {visibleColumns.map(col => renderColumnCell(col.key, company))}
                                        <Table.Td style={{ padding: '0 4px' }}>
                                            <Group gap={2} wrap="nowrap" justify="flex-end">
                                            <Tooltip label={t(favoriteIds.has(company.id) ? 'savedViews.removeFavorite' : 'savedViews.addFavorite')} withArrow>
                                                <ActionIcon
                                                    variant="subtle"
                                                    color={favoriteIds.has(company.id) ? 'yellow' : 'gray'}
                                                    onClick={(e) => { e.stopPropagation(); favoriteToggle.mutate(company.id); }}
                                                    aria-label={t(favoriteIds.has(company.id) ? 'savedViews.removeFavorite' : 'savedViews.addFavorite')}
                                                >
                                                    {favoriteIds.has(company.id) ? <IconStarFilled size={16} /> : <IconStar size={16} />}
                                                </ActionIcon>
                                            </Tooltip>
                                            {canEdit && (
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
                                            </Group>
                                        </Table.Td>
                                    </Table.Tr>
                                ))}
                            </Table.Tbody>
                        </Table>
                        </Table.ScrollContainer>

                        {/* Pagination */}
                        {data && data.pagination.totalPages > 1 && (
                            <Box p="md">
                                <Flex justify="space-between" align="center" gap="sm" wrap="wrap">
                                    <Text size="sm" c="dimmed">
                                        {t('pagination.showing')} {((page - 1) * 25) + 1}–
                                        {Math.min(page * 25, data.pagination.total)} {t('pagination.of')} {data.pagination.total}
                                    </Text>
                                    <Flex align="center" gap="xs">
                                        <Pagination
                                            total={data.pagination.totalPages}
                                            value={page}
                                            onChange={setPage}
                                            color="violet"
                                            radius="md"
                                            size="sm"
                                        />
                                        <TextInput
                                            key={page}
                                            size="xs"
                                            placeholder={t('pagination.goTo')}
                                            style={{ width: 110 }}
                                            defaultValue=""
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') {
                                                    const val = parseInt((e.currentTarget as HTMLInputElement).value, 10);
                                                    if (!isNaN(val)) {
                                                        setPage(Math.max(1, Math.min(val, data.pagination.totalPages)));
                                                    }
                                                    (e.currentTarget as HTMLInputElement).value = '';
                                                }
                                            }}
                                        />
                                    </Flex>
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
                onTerminalStageSelected={(cId, cName, stage) => {
                    handleFormClose();
                    setClosingReportTarget({ companyId: cId, companyName: cName, targetStage: stage as ClosingOutcome });
                }}
            />

            {/* Delete Confirm Modal */}
            <Modal
                opened={!!deleteModalCompany}
                onClose={() => setDeleteModalCompany(null)}
                title={t('company.deleteTitle', 'Şiirketi Sil')}
                radius="lg"
                centered
                size="sm"
            >
                <Stack gap="md">
                    <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light">
                        <Text size="sm" fw={600}>{deleteModalCompany?.name}</Text>
                        <Text size="sm" c="dimmed" mt={4}>
                            {t('company.deleteConfirmDesc', 'Bu şirket kalıcı olarak silinecek. Bu işlem geri alınamaz.')}
                        </Text>
                    </Alert>
                    <Group justify="flex-end">
                        <Button variant="default" onClick={() => setDeleteModalCompany(null)}>
                            {t('common.cancel')}
                        </Button>
                        <Button
                            color="red"
                            leftSection={<IconTrash size={14} />}
                            loading={deleteMutation.isPending}
                            onClick={() => deleteModalCompany && deleteMutation.mutate(deleteModalCompany.id)}
                        >
                            {t('common.delete', 'Kalıcı Olarak Sil')}
                        </Button>
                    </Group>
                </Stack>
            </Modal>

            {/* Save current view modal (E11) */}
            <Modal
                opened={saveViewOpened}
                onClose={closeSaveView}
                title={t('savedViews.saveTitle')}
                radius="lg"
                centered
                size="sm"
            >
                <Stack gap="md">
                    <TextInput
                        label={t('savedViews.namePlaceholder')}
                        placeholder={t('savedViews.namePlaceholder')}
                        value={newViewName}
                        onChange={(e) => setNewViewName(e.currentTarget.value)}
                        data-autofocus
                        onKeyDown={(e) => { if (e.key === 'Enter') handleSaveView(); }}
                    />
                    <Switch
                        label={t('savedViews.shareToggle')}
                        description={t('savedViews.shareHint')}
                        checked={newViewShared}
                        onChange={(e) => setNewViewShared(e.currentTarget.checked)}
                    />
                    <Group justify="flex-end">
                        <Button variant="default" onClick={closeSaveView}>
                            {t('common.cancel')}
                        </Button>
                        <Button
                            leftSection={<IconDeviceFloppy size={16} />}
                            loading={saveViewMutation.isPending}
                            onClick={handleSaveView}
                        >
                            {t('savedViews.create')}
                        </Button>
                    </Group>
                </Stack>
            </Modal>

            {closingReportTarget && (
                <ClosingReportModal
                    opened={true}
                    onClose={() => setClosingReportTarget(null)}
                    companyId={closingReportTarget.companyId}
                    companyName={closingReportTarget.companyName}
                    targetStage={closingReportTarget.targetStage}
                    onSuccess={() => {
                        setClosingReportTarget(null);
                        queryClient.invalidateQueries({ queryKey: ['companies'] });
                        queryClient.invalidateQueries({ queryKey: ['filterOptions'] });
                        queryClient.invalidateQueries({ queryKey: ['statistics'] });
                        queryClient.invalidateQueries({ queryKey: ['pipeline'] });
                    }}
                />
            )}
            {reopenTarget && (
                <ReopenReasonModal
                    opened
                    onClose={() => setReopenTarget(null)}
                    companyName={reopenTarget.companyName}
                    targetStageLabel={reopenTarget.targetLabel}
                    loading={reopenLoading}
                    onConfirm={(reason) => {
                        setReopenLoading(true);
                        api.patch(`/companies/${reopenTarget.companyId}/stage`, { stage: reopenTarget.targetStage, reopen_reason: reason })
                            .then(() => {
                                queryClient.invalidateQueries({ queryKey: ['companies'] });
                                queryClient.invalidateQueries({ queryKey: ['filterOptions'] });
                                queryClient.invalidateQueries({ queryKey: ['statistics'] });
                                queryClient.invalidateQueries({ queryKey: ['pipeline'] });
                                queryClient.invalidateQueries({ queryKey: ['activities'] });
                                setReopenTarget(null);
                                showSuccess(t('company.updated'));
                            })
                            .catch((err) => showErrorFromApi(err))
                            .finally(() => setReopenLoading(false));
                    }}
                />
            )}
        </Container>
    );
}
