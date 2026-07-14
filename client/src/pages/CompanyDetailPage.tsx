import { useState, useRef, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useNavigateBack } from '../hooks/useNavigateBack';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
    Container,
    Paper,
    Title,
    Text,
    Group,
    Badge,
    Button,
    Stack,
    SimpleGrid,
    ActionIcon,
    Loader,
    Center,
    Tooltip,
    Card,
    Divider,
    Modal,
    TextInput,
    Select,
    Switch,
    Box,
    Anchor,
    Menu,
    Alert,
    Popover,
    Checkbox,
    Tabs,
    UnstyledButton,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { useDisclosure } from '@mantine/hooks';
import { showSuccess, showError, showErrorFromApi } from '../lib/notifications';
import { invalidateCompanyArchiveCaches, invalidateContactArchiveCaches } from '../lib/archiveCache';
import {
    IconArrowLeft,
    IconPencil,
    IconTrash,
    IconPlus,
    IconUser,
    IconMail,
    IconMailOpened,
    IconPhone,
    IconStar,
    IconStarFilled,
    IconBrandLinkedin,
    IconWorld,
    IconUsers,
    IconDotsVertical,
    IconLanguage,
    IconAlertCircle,
    IconChevronDown,
    IconEyeOff,
    IconArchive,
    IconArchiveOff,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import ErrorFeedbackButton from '../components/ErrorFeedbackButton';
import api from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { useStages } from '../contexts/StagesContext';
import { canWrite } from '../lib/permissions';
import { safeUrl } from '../lib/url';
import TranslatableField from '../components/TranslatableField';
import EmailStatusIcon from '../components/EmailStatusIcon';
import OwnerSelect from '../components/OwnerSelect';
import CompanyForm from '../components/CompanyForm';
import CompanyQualificationPanel from '../components/CompanyQualificationPanel';
import ClosingReportModal from '../components/ClosingReportModal';
import MergeWizardModal from '../components/MergeWizardModal';
import ReopenReasonModal from '../components/ReopenReasonModal';
import ActivityTimelineUnified from '../components/ActivityTimelineUnified';
import type { ActivityTimelineHandle } from '../components/ActivityTimeline';
import ReplyDetailModal from '../components/email/ReplyDetailModal';
import CallButton from '../components/coldcall/CallButton';
import type { ClosingOutcome } from '../types/activity';
import type { EmailReply } from '../types/emailReply';
import NextActionPanel from '../components/tasks/NextActionPanel';
import DealsSection from '../components/deals/DealsSection';

interface Contact {
    id: string;
    first_name: string;
    last_name: string | null;
    title: string | null;
    email: string | null;
    phone_e164: string | null;
    linkedin: string | null;
    country: string | null;
    seniority: string | null;
    buying_role: string | null;
    relationship_status: string | null;
    preferred_channel: string | null;
    is_primary: boolean;
}

// Contact-intelligence enum values (migration 134). Labels come from i18n (contactIntel.*).
const BUYING_ROLE_VALUES = ['decision_maker', 'influencer', 'champion', 'user', 'blocker'];
const RELATIONSHIP_STATUS_VALUES = ['active', 'passive', 'left_company'];
const PREFERRED_CHANNEL_VALUES = ['email', 'phone', 'whatsapp', 'linkedin', 'other'];

const BUYING_ROLE_COLORS: Record<string, string> = {
    decision_maker: 'grape', influencer: 'blue', champion: 'teal', user: 'gray', blocker: 'red',
};
const RELATIONSHIP_STATUS_COLORS: Record<string, string> = {
    active: 'green', passive: 'yellow', left_company: 'gray',
};

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
    lead_source: string | null;
    priority: 'low' | 'normal' | 'high' | null;
    qualification_status: 'unqualified' | 'in_progress' | 'qualified' | 'disqualified' | null;
    fit_score_num: number | null;
    competitor_notes: string | null;
    objection_notes: string | null;
    custom_field_1: string | null;
    custom_field_2: string | null;
    custom_field_3: string | null;
    assigned_to: string | null;
    assigned_user: { id: string; name: string | null; email: string } | null;
    contacts: Contact[];
    translations: Record<string, string> | null;
    created_at: string;
    updated_at: string;
    archived_at: string | null;
    archived_by: string | null;
}

const DETAIL_FIELDS = [
    { key: 'company_summary',   labelKey: 'company.companySummary' as const },
    { key: 'product_services',  labelKey: 'company.productServices' as const },
    { key: 'product_portfolio', labelKey: 'company.productPortfolio' as const },
    { key: 'next_step',         labelKey: 'company.nextStep' as const },
    { key: 'fit_score',         labelKey: 'company.fitScore' as const },
    { key: 'custom_field_1',    labelKey: null },
    { key: 'custom_field_2',    labelKey: null },
    { key: 'custom_field_3',    labelKey: null },
] as const;

type DetailFieldKey = typeof DETAIL_FIELDS[number]['key'];

function getFieldVisibilityKey(tenantId?: string): string {
    return tenantId
        ? `company_detail_field_visibility_${tenantId}`
        : 'company_detail_field_visibility';
}

function loadFieldVisibility(tenantId?: string): Set<string> {
    try {
        const stored = localStorage.getItem(getFieldVisibilityKey(tenantId));
        return stored ? new Set(JSON.parse(stored) as string[]) : new Set();
    } catch {
        return new Set();
    }
}

function saveFieldVisibility(hidden: Set<string>, tenantId?: string): void {
    localStorage.setItem(getFieldVisibilityKey(tenantId), JSON.stringify([...hidden]));
}

interface ContactCardProps {
    contact: Contact;
    canEdit: boolean;
    isSuperadmin: boolean;
    onNavigate: (id: string) => void;
    onEdit: (contact: Contact) => void;
    onDelete: (contact: Contact) => void;
    onArchive: (contact: Contact) => void;
    t: (key: string) => string;
    companyId?: string;
    companyName?: string;
}

function ContactCard({ contact, canEdit, isSuperadmin, onNavigate, onEdit, onDelete, onArchive, t, companyId, companyName }: ContactCardProps) {
    const href = safeUrl(contact.linkedin);
    return (
        <Card withBorder radius="md" p="md" style={{ cursor: 'pointer' }} onClick={() => onNavigate(contact.id)}>
            <Group justify="space-between">
                <Group>
                    {contact.is_primary && (
                        <Tooltip label={t('contact.isPrimary')}>
                            <IconStar size={16} color="gold" fill="gold" />
                        </Tooltip>
                    )}
                    <div>
                        <Group gap="xs">
                            <Text fw={600} size="sm">
                                {[contact.first_name, contact.last_name].filter(Boolean).join(' ')}
                            </Text>
                            {contact.seniority && (
                                <Badge size="xs" variant="outline" color="gray">{contact.seniority}</Badge>
                            )}
                            {contact.buying_role && (
                                <Badge size="xs" variant="light" color={BUYING_ROLE_COLORS[contact.buying_role] || 'gray'}>
                                    {t(`contactIntel.buyingRoles.${contact.buying_role}`)}
                                </Badge>
                            )}
                            {contact.relationship_status && (
                                <Badge size="xs" variant="dot" color={RELATIONSHIP_STATUS_COLORS[contact.relationship_status] || 'gray'}>
                                    {t(`contactIntel.relationshipStatuses.${contact.relationship_status}`)}
                                </Badge>
                            )}
                        </Group>
                        <Group gap="xs" mt={2}>
                            {contact.title && <Text size="xs" c="dimmed">{contact.title}</Text>}
                            {contact.country && <Text size="xs" c="dimmed">· {contact.country}</Text>}
                        </Group>
                    </div>
                </Group>
                <Group gap="md">
                    {contact.email && (
                        <Group gap={4}>
                            <IconMail size={14} color="gray" />
                            <Text size="xs">{contact.email}</Text>
                        </Group>
                    )}
                    {contact.phone_e164 && (
                        <Group gap={4}>
                            <IconPhone size={14} color="gray" />
                            <Text size="xs">{contact.phone_e164}</Text>
                            <CallButton
                                phone={contact.phone_e164}
                                companyId={companyId}
                                companyName={companyName}
                                contactId={contact.id}
                                size="xs"
                            />
                        </Group>
                    )}
                    {href && (
                        <Anchor href={href} target="_blank" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
                            <IconBrandLinkedin size={16} color="#0A66C2" />
                        </Anchor>
                    )}
                    {canEdit && (
                        <Menu withinPortal position="bottom-end" shadow="sm">
                            <Menu.Target>
                                <ActionIcon variant="subtle" color="gray" size="sm" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
                                    <IconDotsVertical size={14} />
                                </ActionIcon>
                            </Menu.Target>
                            <Menu.Dropdown>
                                <Menu.Item leftSection={<IconPencil size={14} />} onClick={() => onEdit(contact)}>
                                    {t('contact.editContact')}
                                </Menu.Item>
                                <Menu.Item leftSection={<IconArchive size={14} />} onClick={() => onArchive(contact)}>
                                    {t('archive.archive')}
                                </Menu.Item>
                                {isSuperadmin && (
                                    <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={() => onDelete(contact)}>
                                        {t('company.delete')}
                                    </Menu.Item>
                                )}
                            </Menu.Dropdown>
                        </Menu>
                    )}
                </Group>
            </Group>
        </Card>
    );
}

export default function CompanyDetailPage() {
    const { t } = useTranslation();
    const { id } = useParams();
    const navigate = useNavigate();
    const goBack = useNavigateBack();
    const { user, activeTenantId } = useAuth();
    const { getStageColor, getStageLabel, allStages, terminalStageSlugs } = useStages();
    const queryClient = useQueryClient();
    const [opened, { open, close }] = useDisclosure(false);
    const [editCompanyOpened, { open: openEditCompany, close: closeEditCompany }] = useDisclosure(false);
    const [editingContact, setEditingContact] = useState<Contact | null>(null);
    const [deleteContactTarget, setDeleteContactTarget] = useState<Contact | null>(null);
    const [showTranslation, setShowTranslation] = useState(false);
    const [hiddenFields, setHiddenFields] = useState<Set<string>>(() => loadFieldVisibility(user?.tenantId));
    const [fieldPopoverOpen, setFieldPopoverOpen] = useState(false);
    const [closingReportTarget, setClosingReportTarget] = useState<{
        companyId: string;
        companyName: string;
        targetStage: ClosingOutcome;
    } | null>(null);
    const [reopenTarget, setReopenTarget] = useState<{ targetStage: string; targetLabel: string } | null>(null);
    const [reopenLoading, setReopenLoading] = useState(false);
    const [selectedEmailReply, setSelectedEmailReply] = useState<EmailReply | null>(null);
    const [emailModalOpened, { open: openEmailModal, close: closeEmailModal }] = useDisclosure(false);
    const canEdit = canWrite(user?.role || '');
    const [activeTab, setActiveTab] = useState<string | null>('activities');
    const activityTimelineRef = useRef<ActivityTimelineHandle>(null);
    const [mergeOpened, { open: openMerge, close: closeMerge }] = useDisclosure(false);
    const [mergeSourceId, setMergeSourceId] = useState<string | null>(null);

    // Possible duplicate companies in this tenant (normalised name/domain/phone match).
    // The current company is always the merge TARGET (survivor); a duplicate is the source.
    const { data: duplicates = [] } = useQuery<Array<{ id: string; name: string; stage: string; match_reason: string }>>({
        queryKey: ['company-duplicates', id],
        queryFn: async () => (await api.get(`/companies/${id}/duplicates`)).data.data,
        enabled: !!id && canEdit,
        retry: false,
    });

    const { data: companyEmails = [], isLoading: emailsLoading, isError: emailsError } = useQuery<EmailReply[]>({
        queryKey: ['company-emails', id],
        queryFn: async () => (await api.get(`/email-replies/by-company/${id}`)).data,
        enabled: !!id,
        retry: false,
    });

    // Timeline email deep-link. The reply is usually already in companyEmails, but
    // the list can still be loading (or errored) when the timeline is clicked — a bare
    // `.find` miss then silently drops the user onto the emails tab. Fall back to a
    // cache-backed on-demand resolve (shares the ['company-emails', id] cache, so no
    // duplicate fetch when already loaded; retries once if the initial load errored),
    // keeping the tab switch only when the reply truly can't be resolved.
    const openEmailByRef = (refId: string) => {
        const cached = companyEmails.find((r) => r.id === refId);
        if (cached) { setSelectedEmailReply(cached); openEmailModal(); return; }
        queryClient
            .ensureQueryData<EmailReply[]>({
                queryKey: ['company-emails', id],
                queryFn: async () => (await api.get(`/email-replies/by-company/${id}`)).data,
            })
            .then((list) => {
                const found = list.find((r) => r.id === refId);
                if (found) { setSelectedEmailReply(found); openEmailModal(); }
                else setActiveTab('emails');
            })
            .catch(() => setActiveTab('emails'));
    };

    const toggleField = (key: DetailFieldKey) => {
        const next = new Set(hiddenFields);
        if (next.has(key)) next.delete(key); else next.add(key);
        setHiddenFields(next);
        saveFieldVisibility(next, user?.tenantId);
    };

    const resetFields = () => {
        setHiddenFields(new Set());
        saveFieldVisibility(new Set(), user?.tenantId);
    };

    const translateMutation = useMutation({
        mutationFn: () => api.post(`/companies/${id}/translate`),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['company', id] });
            setShowTranslation(true);
            showSuccess(t('translate.button'));
        },
        onError: () => {
            showError(t('translate.error'));
        },
    });

    const [ownerModalOpen, setOwnerModalOpen] = useState(false);
    const [ownerValue, setOwnerValue] = useState<string | null>(null);
    const ownerMutation = useMutation({
        mutationFn: async (assigned_to: string | null) => (await api.put(`/companies/${id}`, { assigned_to })).data,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['company', id] });
            queryClient.invalidateQueries({ queryKey: ['companies'] });
            setOwnerModalOpen(false);
            showSuccess(t('owner.updated'));
        },
        onError: (err) => showErrorFromApi(err),
    });

    // Archive / restore this company. Archiving hides it from the default list, pipeline
    // and search (reversibly); restoring brings it straight back.
    const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
    const archiveMutation = useMutation({
        mutationFn: async () => api.post(`/companies/${id}/archive`),
        onSuccess: () => {
            invalidateCompanyArchiveCaches(queryClient);
            setArchiveConfirmOpen(false);
            showSuccess(t('archive.archived'));
        },
        onError: (err) => showErrorFromApi(err),
    });
    const unarchiveMutation = useMutation({
        mutationFn: async () => api.post(`/companies/${id}/unarchive`),
        onSuccess: () => {
            invalidateCompanyArchiveCaches(queryClient);
            showSuccess(t('archive.restored'));
        },
        onError: (err) => showErrorFromApi(err),
    });

    // Archive a contact from the card list (reversible; restore from the People archive view).
    const archiveContactMutation = useMutation({
        mutationFn: async (contactId: string) => api.post(`/contacts/${contactId}/archive`),
        onSuccess: () => {
            invalidateContactArchiveCaches(queryClient);
            showSuccess(t('archive.archived'));
        },
        onError: (err) => showErrorFromApi(err),
    });
    const handleArchiveContact = (contact: Contact) => {
        if (window.confirm(t('archive.archiveContactConfirm'))) {
            archiveContactMutation.mutate(contact.id);
        }
    };

    const { data: company, isLoading } = useQuery<Company>({
        queryKey: ['company', id],
        queryFn: async () => {
            const res = await api.get(`/companies/${id}`);
            return res.data.data;
        },
        enabled: !!id,
    });

    // ── Favorites + recents (E11) ──────────────────────────────────────────────
    // Personal and multi-device (DB-backed): any authenticated member — viewers
    // included — may star a company, and visiting this page records a "recently
    // viewed" entry. Both share their query cache with the Leads list.
    // D4 tenant-isolation pattern (mirrors LeadsPage): key on activeTenantId, gate the
    // fetch on a resolved tenant, and pin that tenant into the request header + pass
    // the abort signal, so a stale-key refetch can't read another tenant's favorites.
    const { data: favoritesData } = useQuery<{ data: { entity_id: string }[] }>({
        queryKey: ['favorites', 'companies', activeTenantId],
        enabled: !!activeTenantId,
        queryFn: async ({ signal }) =>
            (await api.get('/views/favorites?entity_type=companies', { headers: { 'X-Tenant-Id': activeTenantId! }, signal })).data,
    });
    const isFavorited = !!favoritesData?.data?.some((f) => f.entity_id === id);
    const favoriteMutation = useMutation({
        mutationFn: async () =>
            (await api.post('/views/favorites/toggle', { entity_type: 'companies', entity_id: id })).data,
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['favorites', 'companies', activeTenantId] }),
        onError: (err) => showErrorFromApi(err),
    });

    // Record the visit only once the company is confirmed loaded, so we never POST
    // an id the caller can't actually access. Fire-and-forget; refresh the list.
    useEffect(() => {
        if (!company?.id) return;
        api.post('/views/recents', { entity_type: 'companies', entity_id: company.id })
            .then(() => queryClient.invalidateQueries({ queryKey: ['recents', 'companies', activeTenantId] }))
            .catch(() => { /* recents are best-effort */ });
    }, [company?.id, queryClient, activeTenantId]);

    // Single stage-change path for the header menu (drag-drop lives in PipelinePage). Terminal
    // targets and reopens are gated by the caller; reopenReason is forwarded when present.
    const patchStage = (slug: string, reopenReason?: string) =>
        api.patch(`/companies/${id}/stage`, { stage: slug, ...(reopenReason ? { reopen_reason: reopenReason } : {}) })
            .then(() => {
                queryClient.invalidateQueries({ queryKey: ['company', id] });
                queryClient.invalidateQueries({ queryKey: ['companies'] });
                queryClient.invalidateQueries({ queryKey: ['pipeline'] });
                queryClient.invalidateQueries({ queryKey: ['statistics'] });
                queryClient.invalidateQueries({ queryKey: ['activities'] });
                showSuccess(t('company.updated'));
            });

    const contactForm = useForm({
        initialValues: {
            first_name: '',
            last_name: '',
            title: '',
            email: '',
            phone_e164: '',
            linkedin: '',
            country: '',
            seniority: '',
            buying_role: '',
            relationship_status: '',
            preferred_channel: '',
            is_primary: false,
        },
        validate: {
            first_name: (v: string) => (v.trim() ? null : t('validation.required', { field: t('contact.firstName') })),
        },
    });

    const createContactMutation = useMutation({
        mutationFn: async (values: typeof contactForm.values) => {
            await api.post('/contacts', { ...values, company_id: id });
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['company', id] });
            queryClient.invalidateQueries({ queryKey: ['statistics'] });
            showSuccess(t('contact.created'));
            close();
            contactForm.reset();
        },
        onError: (err) => {
            showErrorFromApi(err);
        },
    });

    const updateContactMutation = useMutation({
        mutationFn: async (values: typeof contactForm.values) => {
            await api.put(`/contacts/${editingContact!.id}`, values);
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['company', id] });
            queryClient.invalidateQueries({ queryKey: ['statistics'] });
            showSuccess(t('contact.updated'));
            close();
            setEditingContact(null);
        },
        onError: (err) => {
            showErrorFromApi(err);
        },
    });

    const deleteContactMutation = useMutation({
        mutationFn: async (contactId: string) => {
            await api.delete(`/contacts/${contactId}`);
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['company', id] });
            queryClient.invalidateQueries({ queryKey: ['statistics'] });
            showSuccess(t('contact.deleted'));
            setDeleteContactTarget(null);
        },
        onError: (err) => {
            showErrorFromApi(err);
        },
    });


    const handleAddContact = () => {
        setEditingContact(null);
        contactForm.reset();
        open();
    };

    const handleEditContact = (contact: Contact) => {
        setEditingContact(contact);
        contactForm.setValues({
            first_name: contact.first_name,
            last_name: contact.last_name || '',
            title: contact.title || '',
            email: contact.email || '',
            phone_e164: contact.phone_e164 || '',
            linkedin: contact.linkedin || '',
            country: contact.country || '',
            seniority: contact.seniority || '',
            buying_role: contact.buying_role || '',
            relationship_status: contact.relationship_status || '',
            preferred_channel: contact.preferred_channel || '',
            is_primary: contact.is_primary,
        });
        open();
    };

    const handleContactSubmit = contactForm.onSubmit((values: typeof contactForm.values) => {
        if (editingContact) {
            updateContactMutation.mutate(values);
        } else {
            createContactMutation.mutate(values);
        }
    });

    if (isLoading) {
        return <Center py={100}><Loader size="lg" color="violet" /></Center>;
    }

    if (!company) {
        return (
            <Container size="lg" py="xl">
                <Center py={100}>
                    <Stack align="center" gap="md">
                        <Alert icon={<IconAlertCircle size={24} />} color="red" radius="lg" title={t('company.notFound')}>
                            {t('company.notFoundDesc')}
                        </Alert>
                        <Group>
                            <Button
                                leftSection={<IconArrowLeft size={16} />}
                                variant="light"
                                color="gray"
                                onClick={() => goBack('/companies')}
                            >
                                {t('common.goBack')}
                            </Button>
                            <ErrorFeedbackButton context="Company" />
                        </Group>
                    </Stack>
                </Center>
            </Container>
        );
    }

    return (
        <>
        <Container size="lg" py="lg">
            {/* Back button + Edit */}
            <Group mb="lg" justify="space-between">
                <Button
                    variant="subtle"
                    leftSection={<IconArrowLeft size={16} />}
                    onClick={() => goBack('/companies')}
                    color="gray"
                >
                    {t('company.back')}
                </Button>
                <Group gap="xs">
                    {canEdit && (
                        <Button
                            variant="light"
                            color="blue"
                            leftSection={<IconLanguage size={16} />}
                            radius="md"
                            onClick={() => translateMutation.mutate()}
                            loading={translateMutation.isPending}
                        >
                            {company?.translations ? t('translate.retranslate') : t('translate.button')}
                        </Button>
                    )}
                    {company?.translations && (
                        <Button
                            variant={showTranslation ? 'filled' : 'light'}
                            color="violet"
                            size="sm"
                            radius="md"
                            onClick={() => setShowTranslation((v) => !v)}
                        >
                            {showTranslation ? t('translate.hideTranslation') : t('translate.showTranslation')}
                        </Button>
                    )}
                    {canEdit && (
                        <Button
                            variant="light"
                            color="violet"
                            leftSection={<IconPencil size={16} />}
                            radius="md"
                            onClick={openEditCompany}
                        >
                            {t('company.editTitle')}
                        </Button>
                    )}
                    {canEdit && !company?.archived_at && (
                        <Button
                            variant="light"
                            color="gray"
                            leftSection={<IconArchive size={16} />}
                            radius="md"
                            onClick={() => setArchiveConfirmOpen(true)}
                        >
                            {t('archive.archive')}
                        </Button>
                    )}
                </Group>
            </Group>

            {/* Archived banner — the company is hidden from default views until restored. */}
            {company?.archived_at && (
                <Alert
                    icon={<IconArchive size={18} />}
                    color="violet"
                    variant="light"
                    radius="lg"
                    mb="lg"
                    title={t('archive.archivedBannerTitle')}
                >
                    <Group justify="space-between" align="center" wrap="nowrap">
                        <Text size="sm" c="dimmed">{t('archive.archivedBannerDesc')}</Text>
                        {canEdit && (
                            <Button
                                variant="light"
                                color="violet"
                                size="xs"
                                leftSection={<IconArchiveOff size={14} />}
                                radius="md"
                                loading={unarchiveMutation.isPending}
                                onClick={() => unarchiveMutation.mutate()}
                            >
                                {t('archive.restore')}
                            </Button>
                        )}
                    </Group>
                </Alert>
            )}

            {/* Possible-duplicate banner */}
            {canEdit && duplicates.length > 0 && (
                <Alert
                    icon={<IconAlertCircle size={18} />}
                    color="orange"
                    variant="light"
                    radius="md"
                    mb="lg"
                    title={t('merge.banner.title', { count: duplicates.length })}
                >
                    <Stack gap="xs">
                        {duplicates.map((d) => (
                            <Group key={d.id} justify="space-between" wrap="nowrap" gap="sm">
                                <div style={{ minWidth: 0 }}>
                                    <Anchor size="sm" fw={500} onClick={() => navigate(`/companies/${d.id}`)}>
                                        {d.name}
                                    </Anchor>
                                    <Text size="xs" c="dimmed">{t(`merge.reason.${d.match_reason}`)}</Text>
                                </div>
                                <Button
                                    size="xs"
                                    variant="light"
                                    color="orange"
                                    onClick={() => { setMergeSourceId(d.id); openMerge(); }}
                                >
                                    {t('merge.mergeButton')}
                                </Button>
                            </Group>
                        ))}
                    </Stack>
                </Alert>
            )}

            {/* Company Header */}
            <Paper shadow="sm" radius="lg" p="xl" withBorder mb="lg">
                <Group justify="space-between" align="flex-start">
                    {/* Left: name + stage + employee_size + location */}
                    <div>
                        <Group gap="xs" align="center">
                            <Title order={2} fw={700}>{company.name}</Title>
                            <Tooltip label={t(isFavorited ? 'savedViews.removeFavorite' : 'savedViews.addFavorite')} withArrow>
                                <ActionIcon
                                    variant="subtle"
                                    color={isFavorited ? 'yellow' : 'gray'}
                                    onClick={() => favoriteMutation.mutate()}
                                    loading={favoriteMutation.isPending}
                                    aria-label={t(isFavorited ? 'savedViews.removeFavorite' : 'savedViews.addFavorite')}
                                >
                                    {isFavorited ? <IconStarFilled size={18} /> : <IconStar size={18} />}
                                </ActionIcon>
                            </Tooltip>
                            {company.industry && (
                                <Text size="sm" c="dimmed" fw={400}>— {company.industry}</Text>
                            )}
                        </Group>
                        <Group mt="xs" gap="sm">
                            <Menu withinPortal position="bottom-start" shadow="md">
                                <Menu.Target>
                                    <Badge
                                        color={getStageColor(company.stage)}
                                        size="lg"
                                        variant="light"
                                        rightSection={<IconChevronDown size={14} />}
                                        style={{ cursor: 'pointer', paddingRight: 6 }}
                                    >
                                        {getStageLabel(company.stage)}
                                    </Badge>
                                </Menu.Target>
                                <Menu.Dropdown>
                                    {allStages.map((s) => (
                                        <Menu.Item
                                            key={s.slug}
                                            leftSection={
                                                <Badge color={s.color} variant="light" size="xs" radius="sm">
                                                    {' '}
                                                </Badge>
                                            }
                                            onClick={() => {
                                                if (s.slug === company.stage) return;
                                                if (terminalStageSlugs.includes(s.slug)) {
                                                    setClosingReportTarget({
                                                        companyId: company.id,
                                                        companyName: company.name,
                                                        targetStage: s.slug,
                                                    });
                                                    return;
                                                }
                                                // Reopen: currently in a terminal stage → ask a reason first
                                                if (terminalStageSlugs.includes(company.stage)) {
                                                    setReopenTarget({ targetStage: s.slug, targetLabel: getStageLabel(s.slug) });
                                                    return;
                                                }
                                                patchStage(s.slug).catch((err) => showErrorFromApi(err));
                                            }}
                                        >
                                            <Text size="sm" fw={company.stage === s.slug ? 700 : 400}>
                                                {getStageLabel(s.slug)}
                                            </Text>
                                        </Menu.Item>
                                    ))}
                                </Menu.Dropdown>
                            </Menu>
                            {company.employee_size && (
                                <Group gap={4}>
                                    <IconUsers size={14} color="var(--mantine-color-gray-5)" />
                                    <Text size="sm" c="dimmed">{company.employee_size}</Text>
                                </Group>
                            )}
                            {company.location && <Text size="sm" c="dimmed">📍 {company.location}</Text>}
                            {(() => {
                                const ownerName = company.assigned_user?.name || company.assigned_user?.email || null;
                                const ownerBadge = (
                                    <Badge
                                        variant="light"
                                        color={ownerName ? 'violet' : 'gray'}
                                        size="lg"
                                        leftSection={<IconUser size={13} />}
                                        rightSection={canEdit ? <IconChevronDown size={13} /> : undefined}
                                        style={{ cursor: canEdit ? 'pointer' : 'default', paddingRight: canEdit ? 6 : undefined }}
                                    >
                                        {ownerName || t('owner.unassigned')}
                                    </Badge>
                                );
                                if (!canEdit) return ownerBadge;
                                return (
                                    <UnstyledButton
                                        onClick={() => { setOwnerValue(company.assigned_to); setOwnerModalOpen(true); }}
                                    >
                                        {ownerBadge}
                                    </UnstyledButton>
                                );
                            })()}
                        </Group>
                    </div>

                    {/* Right: website, linkedin icon, phone */}
                    <Stack gap={6} align="flex-end">
                        {(() => {
                            const href = safeUrl(company.website);
                            return href ? (
                                <Anchor href={href} target="_blank" size="sm">
                                    <Group gap={4}>
                                        <IconWorld size={15} />
                                        <Text size="sm">{company.website}</Text>
                                    </Group>
                                </Anchor>
                            ) : null;
                        })()}
                        {(() => {
                            const href = safeUrl(company.linkedin);
                            return href ? (
                                <Anchor href={href} target="_blank">
                                    <Group gap={4}>
                                        <IconBrandLinkedin size={20} color="#0A66C2" />
                                        <Text size="sm" c="dimmed">LinkedIn</Text>
                                    </Group>
                                </Anchor>
                            ) : null;
                        })()}
                        {company.company_phone && (
                            <Group gap={4}>
                                <IconPhone size={15} color="gray" />
                                <Text size="sm" c="dimmed">{company.company_phone}</Text>
                                <CallButton phone={company.company_phone} companyId={company.id} companyName={company.name} />
                            </Group>
                        )}
                        {company.company_email && (
                            <Group gap={4}>
                                <IconMail size={15} color="gray" />
                                <Text size="sm" c="dimmed">{company.company_email}</Text>
                                <EmailStatusIcon status={company.email_status} />
                            </Group>
                        )}
                    </Stack>
                </Group>

                {/* Field visibility control */}
                <Group justify="flex-end" mt="lg" mb="xs">
                    <Popover
                        opened={fieldPopoverOpen}
                        onChange={setFieldPopoverOpen}
                        position="bottom-end"
                        shadow="md"
                        withArrow
                    >
                        <Popover.Target>
                            <Tooltip label={t('company.editFields')} withArrow position="left">
                                {hiddenFields.size > 0 ? (
                                    <Group
                                        gap={4}
                                        style={{
                                            padding: '4px 9px',
                                            borderRadius: 6,
                                            background: 'var(--mantine-color-violet-0)',
                                            border: '1px solid var(--mantine-color-violet-5)',
                                            cursor: 'pointer',
                                        }}
                                        onClick={() => setFieldPopoverOpen((o) => !o)}
                                    >
                                        <IconEyeOff size={13} color="var(--mantine-color-violet-6)" />
                                        <Text size="xs" fw={600} c="violet">{hiddenFields.size}</Text>
                                    </Group>
                                ) : (
                                    <ActionIcon
                                        variant="subtle"
                                        color="gray"
                                        size="sm"
                                        onClick={() => setFieldPopoverOpen((o) => !o)}
                                    >
                                        <IconEyeOff size={14} />
                                    </ActionIcon>
                                )}
                            </Tooltip>
                        </Popover.Target>
                        <Popover.Dropdown p="sm" style={{ minWidth: 220 }}>
                            <Text size="xs" fw={700} tt="uppercase" c="dimmed" mb="xs" style={{ letterSpacing: '0.5px' }}>
                                {t('company.fieldVisibility')}
                            </Text>
                            <Stack gap={8}>
                                {DETAIL_FIELDS.map((field) => {
                                    const label = field.labelKey
                                        ? t(field.labelKey)
                                        : (user?.tenantSettings?.[`${field.key}_label` as keyof typeof user.tenantSettings] as string | undefined)
                                          ?? t(`company.customField${field.key.slice(-1)}`, `Özel Alan ${field.key.slice(-1)}`);
                                    return (
                                        <Checkbox
                                            key={field.key}
                                            label={label}
                                            checked={!hiddenFields.has(field.key)}
                                            onChange={() => toggleField(field.key as DetailFieldKey)}
                                            color="violet"
                                            size="sm"
                                        />
                                    );
                                })}
                            </Stack>
                            <Divider my="xs" />
                            <Button
                                variant="subtle"
                                color="violet"
                                size="xs"
                                fullWidth
                                onClick={resetFields}
                            >
                                {t('company.resetFields')}
                            </Button>
                        </Popover.Dropdown>
                    </Popover>
                </Group>

                {/* Details Grid */}
                <SimpleGrid cols={2}>
                    {!hiddenFields.has('product_services') && company.product_services?.length ? (
                        <Box>
                            <Text size="xs" c="dimmed" fw={600} tt="uppercase">{t('company.productServices')}</Text>
                            <Group gap={4} mt={4}>
                                {company.product_services.map((p) => (
                                    <Badge key={p} variant="light" radius="sm" tt="none">{p}</Badge>
                                ))}
                            </Group>
                        </Box>
                    ) : null}
                    {!hiddenFields.has('product_portfolio') && company.product_portfolio?.length ? (
                        <Box>
                            <Text size="xs" c="dimmed" fw={600} tt="uppercase">{t('company.productPortfolio')}</Text>
                            <Group gap={4} mt={4}>
                                {company.product_portfolio.map((p) => (
                                    <Badge key={p} variant="light" radius="sm" tt="none">{p}</Badge>
                                ))}
                            </Group>
                        </Box>
                    ) : null}
                    {!hiddenFields.has('company_summary') && company.company_summary && (
                        <Box>
                            <Text size="xs" c="dimmed" fw={600} tt="uppercase">{t('company.companySummary')}</Text>
                            <TranslatableField original={company.company_summary} translated={company.translations?.company_summary} showTranslation={showTranslation} maxLength={350} />
                        </Box>
                    )}
                    {!hiddenFields.has('next_step') && company.next_step && (
                        <Box>
                            <Text size="xs" c="dimmed" fw={600} tt="uppercase">{t('company.nextStep')}</Text>
                            <TranslatableField original={company.next_step} translated={company.translations?.next_step} showTranslation={showTranslation} maxLength={350} />
                        </Box>
                    )}
                    {!hiddenFields.has('fit_score') && company.fit_score && (
                        <Box>
                            <Text size="xs" c="dimmed" fw={600} tt="uppercase">{t('company.fitScore')}</Text>
                            <Text size="sm">{company.fit_score}</Text>
                        </Box>
                    )}
                    {!hiddenFields.has('custom_field_1') && company.custom_field_1 && (
                        <Box>
                            <Text size="xs" c="dimmed" fw={600} tt="uppercase">
                                {user?.tenantSettings?.custom_field_1_label || t('company.customField1', 'Özel Alan 1')}
                            </Text>
                            <Text size="sm">{company.custom_field_1}</Text>
                        </Box>
                    )}
                    {!hiddenFields.has('custom_field_2') && company.custom_field_2 && (
                        <Box>
                            <Text size="xs" c="dimmed" fw={600} tt="uppercase">
                                {user?.tenantSettings?.custom_field_2_label || t('company.customField2', 'Özel Alan 2')}
                            </Text>
                            <Text size="sm">{company.custom_field_2}</Text>
                        </Box>
                    )}
                    {!hiddenFields.has('custom_field_3') && company.custom_field_3 && (
                        <Box>
                            <Text size="xs" c="dimmed" fw={600} tt="uppercase">
                                {user?.tenantSettings?.custom_field_3_label || t('company.customField3', 'Özel Alan 3')}
                            </Text>
                            <Text size="sm">{company.custom_field_3}</Text>
                        </Box>
                    )}
                </SimpleGrid>
            </Paper>

            {/* Qualification + tags (v2 Phase 6, slice E4) */}
            <CompanyQualificationPanel company={company} canEdit={canEdit} />

            <NextActionPanel
                companyId={company.id}
                contacts={company.contacts}
                canEdit={canEdit}
                legacyNextStep={company.next_step}
            />

            {/* Firsatlar (Deals — v2 Phase 5) */}
            <DealsSection
                companyId={company.id}
                companyStage={company.stage}
                contacts={company.contacts}
                canEdit={canEdit}
            />

            {/* Activities & Contacts Tabs */}
            <Paper shadow="sm" radius="lg" p="xl" withBorder>
                <Tabs value={activeTab} onChange={setActiveTab}>
                    <Group justify="space-between" align="center" mb="lg">
                        <Tabs.List>
                            <Tabs.Tab value="activities">{t('activity.timeline')}</Tabs.Tab>
                            <Tabs.Tab value="contacts">
                                <Group gap={6} wrap="nowrap">
                                    {t('company.contacts')}
                                    {company.contacts.length > 0 && (
                                        <Badge size="xs" variant="light" color="violet" radius="xl">{company.contacts.length}</Badge>
                                    )}
                                </Group>
                            </Tabs.Tab>
                            <Tabs.Tab value="emails">
                                <Group gap={6} wrap="nowrap">
                                    {t('emailReplies.companyEmailsTab')}
                                    {companyEmails.length > 0 && (
                                        <Badge size="xs" variant="light" color="blue" radius="xl">{companyEmails.length}</Badge>
                                    )}
                                </Group>
                            </Tabs.Tab>
                        </Tabs.List>
                        {activeTab === 'activities' && canEdit && (
                            <Button
                                size="sm"
                                leftSection={<IconPlus size={16} />}
                                onClick={() => activityTimelineRef.current?.openAddForm()}
                                variant="light"
                                color="violet"
                                radius="md"
                            >
                                {t('activity.addActivity')}
                            </Button>
                        )}
                        {activeTab === 'contacts' && canEdit && (
                            <Button
                                size="sm"
                                leftSection={<IconPlus size={16} />}
                                onClick={handleAddContact}
                                variant="light"
                                color="violet"
                                radius="md"
                            >
                                {t('contact.addContact')}
                            </Button>
                        )}
                    </Group>

                    <Tabs.Panel value="activities">
                        {id && (
                            <ActivityTimelineUnified
                                ref={activityTimelineRef}
                                companyId={id}
                                hideActionButton
                                onOpenEmail={openEmailByRef}
                            />
                        )}
                    </Tabs.Panel>

                    <Tabs.Panel value="contacts">

                        {company.contacts.length === 0 ? (
                            <Center py="xl">
                                <Stack align="center" gap="xs">
                                    <IconUser size={40} color="#ccc" />
                                    <Text c="dimmed">{t('company.noContacts')}</Text>
                                </Stack>
                            </Center>
                        ) : (() => {
                            const cardProps = {
                                canEdit,
                                isSuperadmin: user?.role === 'superadmin',
                                onNavigate: (cid: string) => navigate(`/people/${cid}`),
                                onEdit: handleEditContact,
                                onDelete: setDeleteContactTarget,
                                onArchive: handleArchiveContact,
                                t,
                                companyId: company.id,
                                companyName: company.name,
                            };
                            // Buying-committee gap: warn when there ARE engaged contacts
                            // (anyone not marked as having left the company) yet none of
                            // them is flagged as the decision maker.
                            const activeContacts = company.contacts.filter((c) => c.relationship_status !== 'left_company');
                            const showCommitteeGap = activeContacts.length > 0
                                && !activeContacts.some((c) => c.buying_role === 'decision_maker');
                            return (
                                <Stack gap="sm">
                                    {showCommitteeGap && (
                                        <Alert icon={<IconAlertCircle size={16} />} color="orange" variant="light" radius="md">
                                            {t('contactIntel.committeeGap')}
                                        </Alert>
                                    )}
                                    {company.contacts.map((c) => (
                                        <ContactCard key={c.id} contact={c} {...cardProps} />
                                    ))}
                                </Stack>
                            );
                        })()}
                    </Tabs.Panel>

                    <Tabs.Panel value="emails">
                        {emailsLoading ? (
                            <Center py="xl"><Loader size="sm" color="violet" /></Center>
                        ) : emailsError ? (
                            <Center py="xl">
                                <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light" radius="md">
                                    {t('errors.generic', 'E-postalar yüklenemedi')}
                                </Alert>
                            </Center>
                        ) : companyEmails.length === 0 ? (
                            <Center py="xl">
                                <Stack align="center" gap="xs">
                                    <IconMail size={40} color="#ccc" />
                                    <Text c="dimmed">{t('emailReplies.noEmailsForCompany')}</Text>
                                </Stack>
                            </Center>
                        ) : (
                            <Stack gap="xs">
                                {companyEmails.map((reply) => (
                                    <Card
                                        key={reply.id}
                                        withBorder
                                        radius="md"
                                        p="sm"
                                        style={{ cursor: 'pointer', opacity: reply.read_status === 'read' ? 0.75 : 1 }}
                                        onClick={() => { setSelectedEmailReply(reply); openEmailModal(); }}
                                    >
                                        <Group justify="space-between" wrap="nowrap" gap="xs">
                                            <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                                                {reply.read_status === 'unread'
                                                    ? <IconMail size={16} color="var(--mantine-color-blue-6)" style={{ flexShrink: 0 }} />
                                                    : <IconMailOpened size={16} color="var(--mantine-color-gray-5)" style={{ flexShrink: 0 }} />
                                                }
                                                <div style={{ minWidth: 0 }}>
                                                    <Group gap="xs" wrap="nowrap">
                                                        <Text size="sm" fw={reply.read_status === 'unread' ? 700 : 400} truncate>
                                                            {reply.sender_email}
                                                        </Text>
                                                        {reply.campaign_name && (
                                                            <Badge size="xs" variant="light" color="gray" style={{ flexShrink: 0 }}>
                                                                {reply.campaign_name}
                                                            </Badge>
                                                        )}
                                                    </Group>
                                                    {reply.reply_body && (
                                                        <Text size="xs" c="dimmed" lineClamp={1}>
                                                            {reply.reply_body}
                                                        </Text>
                                                    )}
                                                </div>
                                            </Group>
                                            <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                                                {new Date(reply.replied_at).toLocaleDateString()}
                                            </Text>
                                        </Group>
                                    </Card>
                                ))}
                            </Stack>
                        )}
                    </Tabs.Panel>
                </Tabs>
            </Paper>

            <ReplyDetailModal
                reply={selectedEmailReply}
                opened={emailModalOpened}
                onClose={() => { closeEmailModal(); queryClient.invalidateQueries({ queryKey: ['company-emails', id] }); queryClient.invalidateQueries({ queryKey: ['company-timeline', id] }); }}
            />

            {/* Company Edit Modal */}
            <CompanyForm
                opened={editCompanyOpened}
                onClose={closeEditCompany}
                company={company}
                onSuccess={() => queryClient.invalidateQueries({ queryKey: ['company', id] })}
                onTerminalStageSelected={(cId, cName, stage) => {
                    closeEditCompany();
                    setClosingReportTarget({ companyId: cId, companyName: cName, targetStage: stage as ClosingOutcome });
                }}
            />

            {/* Owner Reassignment Modal */}
            <Modal
                opened={ownerModalOpen}
                onClose={() => setOwnerModalOpen(false)}
                title={t('owner.label')}
                size="sm"
                radius="lg"
                centered
                overlayProps={{ backgroundOpacity: 0.4, blur: 4 }}
                styles={{ title: { fontWeight: 700 } }}
            >
                <Stack gap="md">
                    <OwnerSelect
                        label={t('owner.label')}
                        clearable
                        value={ownerValue}
                        onChange={setOwnerValue}
                    />
                    <Group justify="flex-end">
                        <Button variant="default" radius="md" onClick={() => setOwnerModalOpen(false)}>
                            {t('common.cancel')}
                        </Button>
                        <Button
                            color="violet"
                            radius="md"
                            loading={ownerMutation.isPending}
                            onClick={() => ownerMutation.mutate(ownerValue)}
                        >
                            {t('common.save')}
                        </Button>
                    </Group>
                </Stack>
            </Modal>

            {/* Contact Form Modal */}
            <Modal
                opened={opened}
                onClose={close}
                title={editingContact ? t('contact.editContact') : t('contact.addContact')}
                radius="lg"
                centered
            >
                <form onSubmit={handleContactSubmit}>
                    <Stack gap="md">
                        <Group grow>
                            <TextInput label={t('contact.firstName')} required radius="md" {...contactForm.getInputProps('first_name')} />
                            <TextInput label={t('contact.lastName')} radius="md" {...contactForm.getInputProps('last_name')} />
                        </Group>
                        <Group grow>
                            <TextInput label={t('contact.title')} radius="md" {...contactForm.getInputProps('title')} />
                        </Group>
                        <Group grow>
                            <Select
                                label={t('contact.seniority')}
                                radius="md"
                                data={['C-Suite', 'VP', 'Director', 'Manager', 'Senior', 'Mid-Level', 'Junior', 'Intern', 'Other']}
                                clearable
                                {...contactForm.getInputProps('seniority')}
                            />
                            <TextInput label={t('contact.country')} radius="md" {...contactForm.getInputProps('country')} />
                        </Group>
                        <Group grow>
                            <Select
                                label={t('contactIntel.buyingRole')}
                                radius="md"
                                data={BUYING_ROLE_VALUES.map((v) => ({ value: v, label: t(`contactIntel.buyingRoles.${v}`) }))}
                                clearable
                                {...contactForm.getInputProps('buying_role')}
                            />
                            <Select
                                label={t('contactIntel.relationshipStatus')}
                                radius="md"
                                data={RELATIONSHIP_STATUS_VALUES.map((v) => ({ value: v, label: t(`contactIntel.relationshipStatuses.${v}`) }))}
                                clearable
                                {...contactForm.getInputProps('relationship_status')}
                            />
                        </Group>
                        <Group grow>
                            <Select
                                label={t('contactIntel.preferredChannel')}
                                radius="md"
                                data={PREFERRED_CHANNEL_VALUES.map((v) => ({ value: v, label: t(`contactIntel.preferredChannels.${v}`) }))}
                                clearable
                                {...contactForm.getInputProps('preferred_channel')}
                            />
                        </Group>
                        <TextInput label={t('contact.email')} radius="md" {...contactForm.getInputProps('email')} />
                        <TextInput label={t('contact.phone')} radius="md" {...contactForm.getInputProps('phone_e164')} />
                        <TextInput label={t('contact.linkedin')} radius="md" {...contactForm.getInputProps('linkedin')} />
                        <Switch label={t('contact.isPrimary')} {...contactForm.getInputProps('is_primary', { type: 'checkbox' })} />
                        <Group justify="flex-end">
                            <Button variant="default" onClick={close}>{t('common.cancel')}</Button>
                            <Button
                                type="submit"
                                color="violet"
                                loading={createContactMutation.isPending || updateContactMutation.isPending}
                            >
                                {t('common.save')}
                            </Button>
                        </Group>
                    </Stack>
                </form>
            </Modal>
        </Container>

        {deleteContactTarget && (
            <Modal
                opened={!!deleteContactTarget}
                onClose={() => setDeleteContactTarget(null)}
                title={t('contact.deleteTitle')}
                radius="lg"
                centered
                size="sm"
            >
                <Stack gap="md">
                    <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light">
                        <Text size="sm" fw={600}>
                            {[deleteContactTarget?.first_name, deleteContactTarget?.last_name].filter(Boolean).join(' ')}
                        </Text>
                        <Text size="sm" c="dimmed" mt={4}>
                            {t('contact.deleteConfirmDesc')}
                        </Text>
                    </Alert>
                    <Group justify="flex-end">
                        <Button variant="default" onClick={() => setDeleteContactTarget(null)}>
                            {t('common.cancel')}
                        </Button>
                        <Button
                            color="red"
                            leftSection={<IconTrash size={14} />}
                            loading={deleteContactMutation.isPending}
                            onClick={() => { if (deleteContactTarget) deleteContactMutation.mutate(deleteContactTarget.id); }}
                        >
                            {t('common.delete')}
                        </Button>
                    </Group>
                </Stack>
            </Modal>
        )}
        <Modal
            opened={archiveConfirmOpen}
            onClose={() => setArchiveConfirmOpen(false)}
            title={t('archive.archiveTitle')}
            radius="lg"
            centered
            size="sm"
        >
            <Stack gap="md">
                <Alert icon={<IconArchive size={16} />} color="violet" variant="light">
                    <Text size="sm" fw={600}>{company?.name}</Text>
                    <Text size="sm" c="dimmed" mt={4}>
                        {t('archive.archiveConfirmDesc')}
                    </Text>
                </Alert>
                <Group justify="flex-end">
                    <Button variant="default" onClick={() => setArchiveConfirmOpen(false)}>
                        {t('common.cancel')}
                    </Button>
                    <Button
                        color="violet"
                        leftSection={<IconArchive size={14} />}
                        loading={archiveMutation.isPending}
                        onClick={() => archiveMutation.mutate()}
                    >
                        {t('archive.archive')}
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
                    queryClient.invalidateQueries({ queryKey: ['company', id] });
                }}
            />
        )}
        {reopenTarget && company && (
            <ReopenReasonModal
                opened
                onClose={() => setReopenTarget(null)}
                companyName={company.name}
                targetStageLabel={reopenTarget.targetLabel}
                loading={reopenLoading}
                onConfirm={(reason) => {
                    setReopenLoading(true);
                    patchStage(reopenTarget.targetStage, reason)
                        .then(() => setReopenTarget(null))
                        .catch((err) => showErrorFromApi(err))
                        .finally(() => setReopenLoading(false));
                }}
            />
        )}
        {mergeOpened && mergeSourceId && id && (
            <MergeWizardModal
                opened={mergeOpened}
                onClose={() => { closeMerge(); setMergeSourceId(null); }}
                entityType="company"
                sourceId={mergeSourceId}
                targetId={id}
                onSuccess={() => {
                    setMergeSourceId(null);
                    queryClient.invalidateQueries({ queryKey: ['company', id] });
                    queryClient.invalidateQueries({ queryKey: ['company-duplicates', id] });
                }}
            />
        )}
        </>
    );
}
