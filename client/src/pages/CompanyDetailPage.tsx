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
    Textarea,
    Switch,
    Box,
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
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import { useAuth } from '../contexts/AuthContext';

const stageColors: Record<string, string> = {
    new: 'blue', researching: 'cyan', contacted: 'indigo',
    meeting_scheduled: 'yellow', proposal_sent: 'orange',
    negotiation: 'grape', won: 'green', lost: 'red', on_hold: 'gray',
};

interface Contact {
    id: string;
    full_name: string;
    title: string | null;
    email: string | null;
    phone_e164: string | null;
    is_primary: boolean;
    notes: string | null;
}

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
    contacts: Contact[];
    created_at: string;
    updated_at: string;
}

export default function CompanyDetailPage() {
    const { t } = useTranslation();
    const { id } = useParams();
    const navigate = useNavigate();
    const { user } = useAuth();
    const queryClient = useQueryClient();
    const [opened, { open, close }] = useDisclosure(false);
    const [editingContact, setEditingContact] = useState<Contact | null>(null);

    const isOpsOrAdmin = user?.role === 'superadmin' || user?.role === 'ops_agent';

    const { data: company, isLoading } = useQuery<Company>({
        queryKey: ['company', id],
        queryFn: async () => {
            const res = await api.get(`/companies/${id}`);
            return res.data.data;
        },
    });

    const contactForm = useForm({
        initialValues: {
            full_name: '',
            title: '',
            email: '',
            phone_e164: '',
            is_primary: false,
            notes: '',
        },
        validate: {
            full_name: (v: string) => (v.trim() ? null : 'Required'),
        },
    });

    const createContactMutation = useMutation({
        mutationFn: async (values: typeof contactForm.values) => {
            await api.post('/contacts', { ...values, company_id: id });
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['company', id] });
            notifications.show({ title: '✅', message: t('contact.created'), color: 'green' });
            close();
            contactForm.reset();
        },
    });

    const updateContactMutation = useMutation({
        mutationFn: async (values: typeof contactForm.values) => {
            await api.put(`/contacts/${editingContact!.id}`, values);
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['company', id] });
            notifications.show({ title: '✅', message: t('contact.updated'), color: 'green' });
            close();
            setEditingContact(null);
        },
    });

    const deleteContactMutation = useMutation({
        mutationFn: async (contactId: string) => {
            await api.delete(`/contacts/${contactId}`);
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['company', id] });
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
            full_name: contact.full_name,
            title: contact.title || '',
            email: contact.email || '',
            phone_e164: contact.phone_e164 || '',
            is_primary: contact.is_primary,
            notes: contact.notes || '',
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

    const customFields = company.custom_fields || {};

    return (
        <Container size="lg" py="lg">
            {/* Back button + Title */}
            <Group mb="lg">
                <Button
                    variant="subtle"
                    leftSection={<IconArrowLeft size={16} />}
                    onClick={() => navigate('/')}
                    color="gray"
                >
                    {t('company.back')}
                </Button>
            </Group>

            {/* Company Header */}
            <Paper shadow="sm" radius="lg" p="xl" withBorder mb="lg">
                <Group justify="space-between" align="flex-start">
                    <div>
                        <Title order={2} fw={700}>{company.name}</Title>
                        <Group mt="xs" gap="md">
                            <Badge color={stageColors[company.stage]} size="lg" variant="light">
                                {t(`stages.${company.stage}`)}
                            </Badge>
                            {company.industry && <Text size="sm" c="dimmed">{company.industry}</Text>}
                            {company.location && <Text size="sm" c="dimmed">📍 {company.location}</Text>}
                        </Group>
                        {company.website && (
                            <Text size="sm" c="blue" mt="xs">🌐 {company.website}</Text>
                        )}
                    </div>
                </Group>

                {/* Details Grid */}
                <SimpleGrid cols={2} mt="lg">
                    {company.employee_count && (
                        <Box>
                            <Text size="xs" c="dimmed" fw={600} tt="uppercase">{t('company.employeeCount')}</Text>
                            <Text size="sm">{company.employee_count}</Text>
                        </Box>
                    )}
                    {company.deal_summary && (
                        <Box>
                            <Text size="xs" c="dimmed" fw={600} tt="uppercase">{t('company.dealSummary')}</Text>
                            <Text size="sm">{company.deal_summary}</Text>
                        </Box>
                    )}
                    {company.next_step && (
                        <Box>
                            <Text size="xs" c="dimmed" fw={600} tt="uppercase">{t('company.nextStep')}</Text>
                            <Text size="sm">{company.next_step}</Text>
                        </Box>
                    )}
                    {company.internal_notes && (
                        <Box>
                            <Text size="xs" c="dimmed" fw={600} tt="uppercase">{t('company.internalNotes')}</Text>
                            <Text size="sm">{company.internal_notes}</Text>
                        </Box>
                    )}
                </SimpleGrid>

                {/* Custom Fields */}
                {Object.keys(customFields).length > 0 && (
                    <>
                        <Divider my="lg" />
                        <Text fw={600} mb="sm">{t('company.customFields')}</Text>
                        <SimpleGrid cols={3}>
                            {Object.entries(customFields).map(([key, value]) => (
                                <Box key={key}>
                                    <Text size="xs" c="dimmed" fw={600}>{key}</Text>
                                    <Text size="sm">{String(value)}</Text>
                                </Box>
                            ))}
                        </SimpleGrid>
                    </>
                )}
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
                    <Stack gap="sm">
                        {company.contacts.map((contact) => (
                            <Card key={contact.id} withBorder radius="md" p="md">
                                <Group justify="space-between">
                                    <Group>
                                        {contact.is_primary && (
                                            <Tooltip label={t('contact.isPrimary')}>
                                                <IconStar size={16} color="gold" fill="gold" />
                                            </Tooltip>
                                        )}
                                        <div>
                                            <Text fw={600} size="sm">{contact.full_name}</Text>
                                            {contact.title && <Text size="xs" c="dimmed">{contact.title}</Text>}
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
                                        {isOpsOrAdmin && (
                                            <Group gap="xs">
                                                <ActionIcon variant="subtle" size="sm" onClick={() => handleEditContact(contact)}>
                                                    <IconPencil size={14} />
                                                </ActionIcon>
                                                {user?.role === 'superadmin' && (
                                                    <ActionIcon
                                                        variant="subtle"
                                                        size="sm"
                                                        color="red"
                                                        onClick={() => {
                                                            if (window.confirm(t('contact.deleteConfirm'))) {
                                                                deleteContactMutation.mutate(contact.id);
                                                            }
                                                        }}
                                                    >
                                                        <IconTrash size={14} />
                                                    </ActionIcon>
                                                )}
                                            </Group>
                                        )}
                                    </Group>
                                </Group>
                                {contact.notes && (
                                    <Text size="xs" c="dimmed" mt="xs">{contact.notes}</Text>
                                )}
                            </Card>
                        ))}
                    </Stack>
                )}
            </Paper>

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
                        <TextInput label={t('contact.fullName')} required radius="md" {...contactForm.getInputProps('full_name')} />
                        <TextInput label={t('contact.title')} radius="md" {...contactForm.getInputProps('title')} />
                        <TextInput label={t('contact.email')} radius="md" {...contactForm.getInputProps('email')} />
                        <TextInput label={t('contact.phone')} radius="md" {...contactForm.getInputProps('phone_e164')} />
                        <Switch label={t('contact.isPrimary')} {...contactForm.getInputProps('is_primary', { type: 'checkbox' })} />
                        <Textarea label={t('contact.notes')} autosize minRows={2} radius="md" {...contactForm.getInputProps('notes')} />
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
