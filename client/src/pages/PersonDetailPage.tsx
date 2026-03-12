import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
    Container,
    Title,
    Text,
    Stack,
    Group,
    Badge,
    Button,
    Paper,
    Loader,
    Center,
    Anchor,
    Divider,
    ActionIcon,
    Tooltip,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
    IconArrowLeft,
    IconPencil,
    IconMail,
    IconPhone,
    IconBrandLinkedin,
    IconBuilding,
    IconUser,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { isInternal } from '../lib/permissions';
import { getStageColor } from '../lib/stages';
import ContactForm from '../components/ContactForm';
import TruncatedText from '../components/TruncatedText';

interface ContactDetail {
    id: string;
    company_id: string;
    first_name: string;
    last_name: string | null;
    title: string | null;
    seniority: string | null;
    country: string | null;
    email: string | null;
    phone_e164: string | null;
    linkedin: string | null;
    is_primary: boolean;
    notes: string | null;
    updated_at: string;
    companies: {
        id: string;
        name: string;
        website: string | null;
        stage: string;
        location: string | null;
        industry: string | null;
    } | null;
}

export default function PersonDetailPage() {
    const { id } = useParams<{ id: string }>();
    const navigate = useNavigate();
    const { t } = useTranslation();
    const { user } = useAuth();

    const [formOpened, { open: openForm, close: closeForm }] = useDisclosure(false);

    const userIsInternal = isInternal(user?.role || '');

    const { data, isLoading, error } = useQuery<{ data: ContactDetail }>({
        queryKey: ['person', id],
        queryFn: () => api.get(`/contacts/${id}`).then((r) => r.data),
        enabled: !!id,
    });

    const contact = data?.data;

    if (isLoading) {
        return (
            <Center h={400}>
                <Loader />
            </Center>
        );
    }

    if (error || !contact) {
        return (
            <Center h={400}>
                <Stack align="center" gap="xs">
                    <IconUser size={48} stroke={1.5} color="var(--mantine-color-gray-4)" />
                    <Text c="dimmed">{t('common.error')}</Text>
                    <Button variant="subtle" onClick={() => navigate('/people')}>
                        {t('people.back')}
                    </Button>
                </Stack>
            </Center>
        );
    }

    return (
        <Container size="md">
            {/* Header */}
            <Group mb="md">
                <Tooltip label={t('people.back')}>
                    <ActionIcon variant="subtle" onClick={() => navigate('/people')}>
                        <IconArrowLeft size={20} />
                    </ActionIcon>
                </Tooltip>
                <Title order={2} style={{ flex: 1 }}>
                    {contact.first_name} {contact.last_name || ''}
                </Title>
                {userIsInternal && (
                    <Button leftSection={<IconPencil size={16} />} variant="light" onClick={openForm}>
                        {t('contact.editContact')}
                    </Button>
                )}
            </Group>

            <Stack gap="md">
                {/* Identity card */}
                <Paper withBorder p="lg" radius="md">
                    <Group align="flex-start" gap="lg">
                        <Stack gap={4} style={{ flex: 1 }}>
                            <Group gap="xs">
                                <IconUser size={18} color="var(--mantine-color-violet-6)" />
                                <Text fw={600} size="lg">
                                    {contact.first_name} {contact.last_name || ''}
                                </Text>
                                {contact.is_primary && (
                                    <Badge size="sm" variant="dot" color="violet">primary</Badge>
                                )}
                            </Group>

                            {contact.title && (
                                <Text c="dimmed" size="sm">
                                    {contact.title}
                                </Text>
                            )}

                            <Group gap="xs" mt={4}>
                                {contact.seniority && (
                                    <Badge size="sm" variant="light" color="blue">
                                        {contact.seniority}
                                    </Badge>
                                )}
                                {contact.country && (
                                    <Badge size="sm" variant="light" color="gray">
                                        {contact.country}
                                    </Badge>
                                )}
                            </Group>
                        </Stack>
                    </Group>
                </Paper>

                {/* Contact info */}
                <Paper withBorder p="lg" radius="md">
                    <Text fw={600} mb="sm">{t('people.contactInfo')}</Text>
                    <Stack gap="xs">
                        <Group gap="sm">
                            <IconMail size={16} color="var(--mantine-color-gray-5)" />
                            {contact.email ? (
                                <Anchor href={`mailto:${contact.email}`} size="sm">
                                    {contact.email}
                                </Anchor>
                            ) : (
                                <Text size="sm" c="dimmed">{t('people.noEmail')}</Text>
                            )}
                        </Group>
                        <Group gap="sm">
                            <IconPhone size={16} color="var(--mantine-color-gray-5)" />
                            {contact.phone_e164 ? (
                                <Anchor href={`tel:${contact.phone_e164}`} size="sm">
                                    {contact.phone_e164}
                                </Anchor>
                            ) : (
                                <Text size="sm" c="dimmed">{t('people.noPhone')}</Text>
                            )}
                        </Group>
                        <Group gap="sm">
                            <IconBrandLinkedin size={16} color="var(--mantine-color-gray-5)" />
                            {contact.linkedin ? (
                                <Anchor href={contact.linkedin} target="_blank" rel="noopener noreferrer" size="sm">
                                    LinkedIn
                                </Anchor>
                            ) : (
                                <Text size="sm" c="dimmed">{t('people.noLinkedIn')}</Text>
                            )}
                        </Group>
                    </Stack>
                </Paper>

                {/* Linked company */}
                {contact.companies && (
                    <Paper withBorder p="lg" radius="md">
                        <Text fw={600} mb="sm">{t('people.linkedCompany')}</Text>
                        <Group
                            gap="sm"
                            style={{ cursor: 'pointer' }}
                            onClick={() => navigate(`/companies/${contact.companies!.id}`)}
                        >
                            <IconBuilding size={20} color="var(--mantine-color-violet-6)" />
                            <Stack gap={2}>
                                <Text fw={500} c="blue">{contact.companies.name}</Text>
                                <Group gap="xs">
                                    <Badge
                                        size="sm"
                                        variant="light"
                                        color={getStageColor(contact.companies.stage)}
                                    >
                                        {t(`stages.${contact.companies.stage}`)}
                                    </Badge>
                                    {contact.companies.industry && (
                                        <Text size="xs" c="dimmed">{contact.companies.industry}</Text>
                                    )}
                                    {contact.companies.location && (
                                        <Text size="xs" c="dimmed">{contact.companies.location}</Text>
                                    )}
                                </Group>
                            </Stack>
                        </Group>
                    </Paper>
                )}

                {/* Notes */}
                {contact.notes && (
                    <Paper withBorder p="lg" radius="md">
                        <Text fw={600} mb="sm">{t('people.notes')}</Text>
                        <TruncatedText size="sm" maxLength={350} inline>{contact.notes}</TruncatedText>
                    </Paper>
                )}
            </Stack>

            <ContactForm
                opened={formOpened}
                onClose={closeForm}
                contact={contact as any}
            />
        </Container>
    );
}
