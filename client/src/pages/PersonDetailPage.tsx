import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useNavigateBack } from '../hooks/useNavigateBack';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
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
    ActionIcon,
    Tooltip,
    Textarea,
    Divider,
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
    IconNotes,
    IconPlus,
    IconSend,
    IconTrash,
    IconX,
    IconLanguage,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import { showErrorFromApi } from '../lib/notifications';
import { useAuth } from '../contexts/AuthContext';
import { isInternal } from '../lib/permissions';
import { useStages } from '../contexts/StagesContext';
import { safeUrl } from '../lib/url';
import ContactForm from '../components/ContactForm';
import ActivityTimeline from '../components/ActivityTimeline';
import type { ContactNote } from '../types/contact';

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
    notes: ContactNote[];
    translations: { title?: string; notes?: Record<string, string>; translated_at?: string } | null;
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

function formatNoteDate(isoString: string, locale: string): string {
    const date = new Date(isoString);
    return date.toLocaleDateString(locale, {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

export default function PersonDetailPage() {
    const { id } = useParams<{ id: string }>();
    const navigate = useNavigate();
    const goBack = useNavigateBack();
    const { t, i18n } = useTranslation();
    const { user } = useAuth();
    const { getStageColor, getStageLabel } = useStages();

    const queryClient = useQueryClient();
    const [formOpened, { open: openForm, close: closeForm }] = useDisclosure(false);
    const [noteInputOpen, setNoteInputOpen] = useState(false);
    const [noteValue, setNoteValue] = useState('');
    const [noteSaving, setNoteSaving] = useState(false);
    const [deletingNoteId, setDeletingNoteId] = useState<string | null>(null);
    const [showTranslation, setShowTranslation] = useState(false);

    const userIsInternal = isInternal(user?.role || '');

    const translateMutation = useMutation({
        mutationFn: () => api.post(`/contacts/${id}/translate`),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['person', id] });
            setShowTranslation(true);
        },
        onError: () => {
            // handled by interceptor
        },
    });

    const { data, isLoading, error } = useQuery<{ data: ContactDetail }>({
        queryKey: ['person', id],
        queryFn: () => api.get(`/contacts/${id}`).then((r) => r.data),
        enabled: !!id,
    });

    const contact = data?.data;
    const notes: ContactNote[] = Array.isArray(contact?.notes) ? contact.notes : [];

    const handleAddNote = async () => {
        if (!contact || !noteValue.trim()) return;
        setNoteSaving(true);
        try {
            await api.post(`/contacts/${contact.id}/notes`, { text: noteValue.trim() });
            await queryClient.invalidateQueries({ queryKey: ['person', id] });
            setNoteValue('');
            setNoteInputOpen(false);
        } catch (err) {
            showErrorFromApi(err);
        } finally {
            setNoteSaving(false);
        }
    };

    const handleDeleteNote = async (noteId: string) => {
        if (!contact) return;
        setDeletingNoteId(noteId);
        try {
            await api.delete(`/contacts/${contact.id}/notes/${noteId}`);
            await queryClient.invalidateQueries({ queryKey: ['person', id] });
        } catch (err) {
            showErrorFromApi(err);
        } finally {
            setDeletingNoteId(null);
        }
    };

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
                    <Button variant="subtle" onClick={() => goBack('/people')}>
                        {t('people.back')}
                    </Button>
                </Stack>
            </Center>
        );
    }

    return (
        <>
        <Container size="md">
            {/* Header */}
            <Group mb="md">
                <Tooltip label={t('people.back')}>
                    <ActionIcon variant="subtle" onClick={() => goBack('/people')}>
                        <IconArrowLeft size={20} />
                    </ActionIcon>
                </Tooltip>
                <Title order={2} style={{ flex: 1 }}>
                    {contact.first_name} {contact.last_name || ''}
                </Title>
                <Group gap="xs">
                    {userIsInternal && (
                        <Button
                            variant="light"
                            color="blue"
                            leftSection={<IconLanguage size={16} />}
                            onClick={() => translateMutation.mutate()}
                            loading={translateMutation.isPending}
                        >
                            {contact.translations ? t('translate.retranslate') : t('translate.button')}
                        </Button>
                    )}
                    {contact.translations && (
                        <Button
                            variant={showTranslation ? 'filled' : 'light'}
                            color="violet"
                            size="sm"
                            onClick={() => setShowTranslation((v) => !v)}
                        >
                            {showTranslation ? t('translate.hideTranslation') : t('translate.showTranslation')}
                        </Button>
                    )}
                    {userIsInternal && (
                        <Button leftSection={<IconPencil size={16} />} variant="light" onClick={openForm}>
                            {t('contact.editContact')}
                        </Button>
                    )}
                </Group>
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
                                <div>
                                    <Text c="dimmed" size="sm">{contact.title}</Text>
                                    {showTranslation && contact.translations?.title && (
                                        <Group gap={4} mt={2}>
                                            <Badge size="xs" variant="light" color="violet" style={{ flexShrink: 0 }}>TR</Badge>
                                            <Text size="sm" c="violet" fs="italic">{contact.translations.title}</Text>
                                        </Group>
                                    )}
                                </div>
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
                            {(() => {
                                const href = safeUrl(contact.linkedin);
                                return href ? (
                                    <Anchor href={href} target="_blank" rel="noopener noreferrer" size="sm">
                                        LinkedIn
                                    </Anchor>
                                ) : contact.linkedin ? (
                                    <Text size="sm" c="dimmed">{contact.linkedin}</Text>
                                ) : (
                                    <Text size="sm" c="dimmed">{t('people.noLinkedIn')}</Text>
                                );
                            })()}
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
                                        {getStageLabel(contact.companies.stage)}
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
                <Paper withBorder p="lg" radius="md">
                    <Group justify="space-between" mb="sm">
                        <Group gap="xs">
                            <IconNotes size={18} color="var(--mantine-color-violet-6)" />
                            <Text fw={600}>{t('people.notes')}</Text>
                            {notes.length > 0 && (
                                <Badge size="sm" variant="light" color="gray" circle>
                                    {notes.length}
                                </Badge>
                            )}
                        </Group>
                        {userIsInternal && !noteInputOpen && (
                            <Button
                                variant="light"
                                size="xs"
                                leftSection={<IconPlus size={14} />}
                                onClick={() => setNoteInputOpen(true)}
                            >
                                {t('people.addNote')}
                            </Button>
                        )}
                    </Group>

                    {/* Add note input */}
                    {noteInputOpen && (
                        <>
                            <Group align="flex-end" gap="xs" mb={notes.length > 0 ? 'md' : 0}>
                                <Textarea
                                    value={noteValue}
                                    onChange={(e) => setNoteValue(e.currentTarget.value)}
                                    placeholder={t('people.notePlaceholder')}
                                    minRows={2}
                                    maxRows={6}
                                    autosize
                                    autoFocus
                                    style={{ flex: 1 }}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' && !e.shiftKey) {
                                            e.preventDefault();
                                            handleAddNote();
                                        }
                                        if (e.key === 'Escape') {
                                            setNoteInputOpen(false);
                                            setNoteValue('');
                                        }
                                    }}
                                />
                                <Stack gap={4}>
                                    <Tooltip label={t('common.save') + ' (Ctrl+Enter)'}>
                                        <ActionIcon
                                            variant="filled"
                                            color="violet"
                                            size="lg"
                                            onClick={handleAddNote}
                                            loading={noteSaving}
                                            disabled={!noteValue.trim()}
                                        >
                                            <IconSend size={16} />
                                        </ActionIcon>
                                    </Tooltip>
                                    <Tooltip label={t('common.cancel')}>
                                        <ActionIcon
                                            variant="subtle"
                                            color="gray"
                                            size="lg"
                                            onClick={() => {
                                                setNoteInputOpen(false);
                                                setNoteValue('');
                                            }}
                                            disabled={noteSaving}
                                        >
                                            <IconX size={16} />
                                        </ActionIcon>
                                    </Tooltip>
                                </Stack>
                            </Group>
                            {notes.length > 0 && <Divider />}
                        </>
                    )}

                    {/* Notes list */}
                    {notes.length > 0 ? (
                        <Stack gap="sm">
                            {notes.map((note, idx) => (
                                <div key={note.id}>
                                    <Group justify="space-between" align="flex-start" wrap="nowrap">
                                        <Stack gap={2} style={{ flex: 1 }}>
                                            <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                                                {note.text}
                                            </Text>
                                            {showTranslation && contact.translations?.notes?.[note.id] && (
                                                <Group gap={4} mt={2}>
                                                    <Badge size="xs" variant="light" color="violet" style={{ flexShrink: 0 }}>TR</Badge>
                                                    <Text size="sm" c="violet" fs="italic" style={{ whiteSpace: 'pre-wrap' }}>
                                                        {contact.translations.notes[note.id]}
                                                    </Text>
                                                </Group>
                                            )}
                                            <Group gap="xs">
                                                <Text size="xs" c="dimmed">
                                                    {formatNoteDate(note.created_at, i18n.language)}
                                                </Text>
                                                {note.created_by && note.created_by !== 'system' && (
                                                    <Text size="xs" c="dimmed">
                                                        &middot; {note.created_by}
                                                    </Text>
                                                )}
                                            </Group>
                                        </Stack>
                                        {userIsInternal && (
                                            <Tooltip label={t('people.deleteNote')}>
                                                <ActionIcon
                                                    variant="subtle"
                                                    color="gray"
                                                    size="sm"
                                                    onClick={() => handleDeleteNote(note.id)}
                                                    loading={deletingNoteId === note.id}
                                                >
                                                    <IconTrash size={14} />
                                                </ActionIcon>
                                            </Tooltip>
                                        )}
                                    </Group>
                                    {idx < notes.length - 1 && <Divider mt="sm" />}
                                </div>
                            ))}
                        </Stack>
                    ) : !noteInputOpen ? (
                        <Text size="sm" c="dimmed" fs="italic">{t('people.noNotes')}</Text>
                    ) : null}
                </Paper>
            </Stack>

            <ContactForm
                opened={formOpened}
                onClose={closeForm}
                contact={{
                    id: contact.id,
                    company_id: contact.company_id,
                    first_name: contact.first_name,
                    last_name: contact.last_name,
                    title: contact.title,
                    seniority: contact.seniority,
                    country: contact.country,
                    email: contact.email,
                    phone_e164: contact.phone_e164,
                    linkedin: contact.linkedin,
                    is_primary: contact.is_primary,
                    notes: contact.notes,
                }}
            />
        </Container>

        {/* Activity Timeline — show only when contact has a company */}
        {contact.companies?.id && (
            <Container size="xl" pb="xl" px={{ base: 'md', sm: 'xl' }}>
                <ActivityTimeline
                    companyId={contact.companies.id}
                    contactId={contact.id}
                />
            </Container>
        )}
        </>
    );
}
