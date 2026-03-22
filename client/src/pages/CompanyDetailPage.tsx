import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
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
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import {
    IconArrowLeft,
    IconPencil,
    IconTrash,
    IconPlus,
    IconUser,
    IconMail,
    IconPhone,
    IconStar,
    IconBrandLinkedin,
    IconWorld,
    IconUsers,
    IconDotsVertical,
    IconNotes,
    IconLanguage,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { useStages } from '../contexts/StagesContext';
import TranslatableField from '../components/TranslatableField';
import EmailStatusIcon from '../components/EmailStatusIcon';
import CompanyForm from '../components/CompanyForm';

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
    is_primary: boolean;
    notes: string | null;
}

interface Company {
    id: string;
    name: string;
    website: string | null;
    location: string | null;
    industry: string | null;
    employee_size: string | null;
    product_services: string | null;
    product_portfolio: string | null;
    linkedin: string | null;
    company_phone: string | null;
    company_email: string | null;
    email_status: 'valid' | 'uncertain' | 'invalid' | null;
    stage: string;
    company_summary: string | null;
    next_step: string | null;
    fit_score: string | null;
    partnership_observation_1: string | null;
    partnership_observation_2: string | null;
    partnership_observation_3: string | null;
    contacts: Contact[];
    translations: Record<string, string> | null;
    created_at: string;
    updated_at: string;
}

export default function CompanyDetailPage() {
    const { t } = useTranslation();
    const { id } = useParams();
    const navigate = useNavigate();
    const { user } = useAuth();
    const { getStageColor, getStageLabel } = useStages();
    const queryClient = useQueryClient();
    const [opened, { open, close }] = useDisclosure(false);
    const [editCompanyOpened, { open: openEditCompany, close: closeEditCompany }] = useDisclosure(false);
    const [editingContact, setEditingContact] = useState<Contact | null>(null);
    const [showTranslation, setShowTranslation] = useState(false);
    const isOpsOrAdmin = user?.role === 'superadmin' || user?.role === 'ops_agent';

    const translateMutation = useMutation({
        mutationFn: () => api.post(`/companies/${id}/translate`),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['company', id] });
            setShowTranslation(true);
            notifications.show({ title: t('translate.button'), message: '', color: 'green' });
        },
        onError: () => {
            notifications.show({ title: t('translate.error'), message: '', color: 'red' });
        },
    });

    const { data: company, isLoading } = useQuery<Company>({
        queryKey: ['company', id],
        queryFn: async () => {
            const res = await api.get(`/companies/${id}`);
            return res.data.data;
        },
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
            is_primary: false,
        },
        validate: {
            first_name: (v: string) => (v.trim() ? null : 'Required'),
        },
    });

    const createContactMutation = useMutation({
        mutationFn: async (values: typeof contactForm.values) => {
            await api.post('/contacts', { ...values, company_id: id });
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['company', id] });
            queryClient.invalidateQueries({ queryKey: ['statistics'] });
            notifications.show({ title: t('contact.created'), message: '', color: 'green' });
            close();
            contactForm.reset();
        },
        onError: () => {
            notifications.show({ title: t('common.error'), message: '', color: 'red' });
        },
    });

    const updateContactMutation = useMutation({
        mutationFn: async (values: typeof contactForm.values) => {
            await api.put(`/contacts/${editingContact!.id}`, values);
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['company', id] });
            queryClient.invalidateQueries({ queryKey: ['statistics'] });
            notifications.show({ title: t('contact.updated'), message: '', color: 'green' });
            close();
            setEditingContact(null);
        },
        onError: () => {
            notifications.show({ title: t('common.error'), message: '', color: 'red' });
        },
    });

    const deleteContactMutation = useMutation({
        mutationFn: async (contactId: string) => {
            await api.delete(`/contacts/${contactId}`);
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['company', id] });
            queryClient.invalidateQueries({ queryKey: ['statistics'] });
            notifications.show({ title: '✅', message: t('contact.deleted'), color: 'green' });
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
                <Text c="red">{t('common.error')}</Text>
            </Container>
        );
    }

    return (
        <Container size="lg" py="lg">
            {/* Back button + Edit */}
            <Group mb="lg" justify="space-between">
                <Button
                    variant="subtle"
                    leftSection={<IconArrowLeft size={16} />}
                    onClick={() => navigate(-1)}
                    color="gray"
                >
                    {t('company.back')}
                </Button>
                <Group gap="xs">
                    {isOpsOrAdmin && (
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
                    {isOpsOrAdmin && (
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
                </Group>
            </Group>

            {/* Company Header */}
            <Paper shadow="sm" radius="lg" p="xl" withBorder mb="lg">
                <Group justify="space-between" align="flex-start">
                    {/* Left: name + stage + employee_size + location */}
                    <div>
                        <Group gap="xs" align="baseline">
                            <Title order={2} fw={700}>{company.name}</Title>
                            {company.industry && (
                                <Text size="sm" c="dimmed" fw={400}>— {company.industry}</Text>
                            )}
                        </Group>
                        <Group mt="xs" gap="sm">
                            <Badge color={getStageColor(company.stage)} size="lg" variant="light">
                                {getStageLabel(company.stage)}
                            </Badge>
                            {company.employee_size && (
                                <Group gap={4}>
                                    <IconUsers size={14} color="#adb5bd" />
                                    <Text size="sm" c="dimmed">{company.employee_size}</Text>
                                </Group>
                            )}
                            {company.location && <Text size="sm" c="dimmed">📍 {company.location}</Text>}
                        </Group>
                    </div>

                    {/* Right: website, linkedin icon, phone */}
                    <Stack gap={6} align="flex-end">
                        {company.website && (
                            <Anchor
                                href={company.website.startsWith('http') ? company.website : `https://${company.website}`}
                                target="_blank"
                                size="sm"
                            >
                                <Group gap={4}>
                                    <IconWorld size={15} />
                                    <Text size="sm">{company.website}</Text>
                                </Group>
                            </Anchor>
                        )}
                        {company.linkedin && (
                            <Anchor
                                href={company.linkedin.startsWith('http') ? company.linkedin : `https://${company.linkedin}`}
                                target="_blank"
                            >
                                <Group gap={4}>
                                    <IconBrandLinkedin size={20} color="#0A66C2" />
                                    <Text size="sm" c="dimmed">LinkedIn</Text>
                                </Group>
                            </Anchor>
                        )}
                        {company.company_phone && (
                            <Group gap={4}>
                                <IconPhone size={15} color="gray" />
                                <Text size="sm" c="dimmed">{company.company_phone}</Text>
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

                {/* Details Grid */}
                <SimpleGrid cols={2} mt="lg">
                    {company.product_services && (
                        <Box>
                            <Text size="xs" c="dimmed" fw={600} tt="uppercase">{t('company.productServices')}</Text>
                            <TranslatableField original={company.product_services} translated={company.translations?.product_services} showTranslation={showTranslation} maxLength={350} />
                        </Box>
                    )}
                    {company.product_portfolio && (
                        <Box>
                            <Text size="xs" c="dimmed" fw={600} tt="uppercase">{t('company.productPortfolio')}</Text>
                            <TranslatableField original={company.product_portfolio} translated={company.translations?.product_portfolio} showTranslation={showTranslation} maxLength={350} />
                        </Box>
                    )}
                    {company.company_summary && (
                        <Box>
                            <Text size="xs" c="dimmed" fw={600} tt="uppercase">{t('company.companySummary')}</Text>
                            <TranslatableField original={company.company_summary} translated={company.translations?.company_summary} showTranslation={showTranslation} maxLength={350} />
                        </Box>
                    )}
                    {company.next_step && (
                        <Box>
                            <Text size="xs" c="dimmed" fw={600} tt="uppercase">{t('company.nextStep')}</Text>
                            <TranslatableField original={company.next_step} translated={company.translations?.next_step} showTranslation={showTranslation} maxLength={350} />
                        </Box>
                    )}
                    {company.fit_score && (
                        <Box>
                            <Text size="xs" c="dimmed" fw={600} tt="uppercase">{t('company.fitScore')}</Text>
                            <Text size="sm">{company.fit_score}</Text>
                        </Box>
                    )}
                    {company.partnership_observation_1 && (
                        <Box>
                            <Text size="xs" c="dimmed" fw={600} tt="uppercase">{t('company.partnershipObservation1')}</Text>
                            <Text size="sm">{company.partnership_observation_1}</Text>
                        </Box>
                    )}
                    {company.partnership_observation_2 && (
                        <Box>
                            <Text size="xs" c="dimmed" fw={600} tt="uppercase">{t('company.partnershipObservation2')}</Text>
                            <Text size="sm">{company.partnership_observation_2}</Text>
                        </Box>
                    )}
                    {company.partnership_observation_3 && (
                        <Box>
                            <Text size="xs" c="dimmed" fw={600} tt="uppercase">{t('company.partnershipObservation3')}</Text>
                            <Text size="sm">{company.partnership_observation_3}</Text>
                        </Box>
                    )}
                </SimpleGrid>
            </Paper>

            {/* Contacts Section */}
            <Paper shadow="sm" radius="lg" p="xl" withBorder>
                <Group justify="space-between" mb="lg">
                    <Title order={4} fw={600}>{t('company.contacts')}</Title>
                    {isOpsOrAdmin && (
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

                {company.contacts.length === 0 ? (
                    <Center py="xl">
                        <Stack align="center" gap="xs">
                            <IconUser size={40} color="#ccc" />
                            <Text c="dimmed">{t('company.noContacts')}</Text>
                        </Stack>
                    </Center>
                ) : (
                    (() => {
                        const contacted = company.contacts.filter((c) => Array.isArray(c.notes) && c.notes.length > 0);
                        const notContacted = company.contacts.filter((c) => !Array.isArray(c.notes) || c.notes.length === 0);

                        const renderContactCard = (contact: Contact) => (
                            <Card key={contact.id} withBorder radius="md" p="md" style={{ cursor: 'pointer' }} onClick={() => navigate(`/people/${contact.id}`)}>
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
                                            </Group>
                                        )}
                                        {contact.linkedin && (
                                            <Anchor
                                                href={contact.linkedin.startsWith('http') ? contact.linkedin : `https://${contact.linkedin}`}
                                                target="_blank"
                                                onClick={(e: React.MouseEvent) => e.stopPropagation()}
                                            >
                                                <IconBrandLinkedin size={16} color="#0A66C2" />
                                            </Anchor>
                                        )}
                                        {isOpsOrAdmin && (
                                            <Menu withinPortal position="bottom-end" shadow="sm">
                                                <Menu.Target>
                                                    <ActionIcon variant="subtle" color="gray" size="sm" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
                                                        <IconDotsVertical size={14} />
                                                    </ActionIcon>
                                                </Menu.Target>
                                                <Menu.Dropdown>
                                                    <Menu.Item
                                                        leftSection={<IconPencil size={14} />}
                                                        onClick={() => handleEditContact(contact)}
                                                    >
                                                        {t('contact.editContact')}
                                                    </Menu.Item>
                                                    {user?.role === 'superadmin' && (
                                                        <Menu.Item
                                                            color="red"
                                                            leftSection={<IconTrash size={14} />}
                                                            onClick={() => {
                                                                if (window.confirm(t('contact.deleteConfirm'))) {
                                                                    deleteContactMutation.mutate(contact.id);
                                                                }
                                                            }}
                                                        >
                                                            {t('company.delete')}
                                                        </Menu.Item>
                                                    )}
                                                </Menu.Dropdown>
                                            </Menu>
                                        )}
                                    </Group>
                                </Group>
                                {Array.isArray(contact.notes) && contact.notes.length > 0 && (
                                    <Group gap={4} mt="xs" wrap="nowrap">
                                        <Text size="xs" c="dimmed" lineClamp={1}>{contact.notes[0].text}</Text>
                                        <IconNotes size={14} color="var(--mantine-color-violet-5)" style={{ flexShrink: 0 }} />
                                        <Text size="xs" c="violet" fw={500} style={{ flexShrink: 0 }}>{contact.notes.length}</Text>
                                    </Group>
                                )}
                            </Card>
                        );

                        return (
                            <Stack gap="md">
                                {contacted.length > 0 && (
                                    <Stack gap="sm">
                                        <Group gap="xs">
                                            <IconNotes size={16} color="var(--mantine-color-violet-5)" />
                                            <Text size="sm" fw={600} c="violet">{t('people.contacted')}</Text>
                                            <Badge size="xs" variant="light" color="violet" circle>{contacted.length}</Badge>
                                        </Group>
                                        {contacted.map(renderContactCard)}
                                    </Stack>
                                )}
                                {contacted.length > 0 && notContacted.length > 0 && <Divider />}
                                {notContacted.length > 0 && (
                                    <Stack gap="sm">
                                        {contacted.length > 0 && (
                                            <Group gap="xs">
                                                <IconUser size={16} color="var(--mantine-color-gray-5)" />
                                                <Text size="sm" fw={600} c="dimmed">{t('people.notContacted')}</Text>
                                                <Badge size="xs" variant="light" color="gray" circle>{notContacted.length}</Badge>
                                            </Group>
                                        )}
                                        {notContacted.map(renderContactCard)}
                                    </Stack>
                                )}
                            </Stack>
                        );
                    })()
                )}
            </Paper>

            {/* Company Edit Modal */}
            <CompanyForm
                opened={editCompanyOpened}
                onClose={closeEditCompany}
                company={company}
                onSuccess={() => queryClient.invalidateQueries({ queryKey: ['company', id] })}
            />

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
    );
}
