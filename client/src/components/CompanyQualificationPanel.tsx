import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
    Paper,
    Title,
    Text,
    Group,
    Badge,
    Stack,
    SimpleGrid,
    Box,
    Select,
    Popover,
    TextInput,
    Button,
    ActionIcon,
    ColorSwatch,
    Divider,
} from '@mantine/core';
import { IconPlus, IconX, IconTag } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { showErrorFromApi } from '../lib/notifications';
import {
    PRIORITY_BADGE_COLOR,
    QUALIFICATION_STATUS_BADGE_COLOR,
    TAG_COLORS,
    type CompanyPriority,
    type QualificationStatus,
} from '../lib/qualification';

// The qualification subset of a company we render/read here.
interface QualCompany {
    id: string;
    lead_source: string | null;
    priority: CompanyPriority | null;
    qualification_status: QualificationStatus | null;
    fit_score_num: number | null;
    competitor_notes: string | null;
    objection_notes: string | null;
}

interface CompanyTag {
    id: string;        // company_tags row id
    tag_id: string;
    name: string | null;
    color: string | null;
}

interface Tag {
    id: string;
    name: string;
    color: string;
}

interface Props {
    company: QualCompany;
    canEdit: boolean;
}

export default function CompanyQualificationPanel({ company, canEdit }: Props) {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const { activeTenantId } = useAuth();
    const [addOpen, setAddOpen] = useState(false);
    const [newName, setNewName] = useState('');
    const [newColor, setNewColor] = useState<string>('blue');

    // Tags linked to this company. Tenant pinned into the KEY (internal roles switch
    // tenant via X-Tenant-Id) so a refetch after a switch targets the right tenant and
    // no other tenant's links can surface under a stale key; enabled guards no-tenant.
    const { data: companyTags } = useQuery<CompanyTag[]>({
        queryKey: ['company-tags', company.id, activeTenantId],
        queryFn: async ({ queryKey, signal }) => {
            const tid = queryKey[2] as string;
            return (await api.get(`/tags/companies/${company.id}`, { headers: { 'X-Tenant-Id': tid }, signal })).data.data;
        },
        enabled: !!activeTenantId,
    });

    // Tenant tag catalogue (for the "add existing" picker).
    const { data: allTags } = useQuery<Tag[]>({
        queryKey: ['tags', activeTenantId],
        queryFn: async ({ queryKey, signal }) => {
            const tid = queryKey[1] as string;
            return (await api.get('/tags', { headers: { 'X-Tenant-Id': tid }, signal })).data.data;
        },
        enabled: !!activeTenantId,
    });

    const linkedTagIds = useMemo(() => new Set((companyTags ?? []).map((ct) => ct.tag_id)), [companyTags]);
    const availableTags = useMemo(
        () => (allTags ?? []).filter((tag) => !linkedTagIds.has(tag.id)),
        [allTags, linkedTagIds],
    );

    const invalidate = () => {
        queryClient.invalidateQueries({ queryKey: ['company-tags', company.id] });
        queryClient.invalidateQueries({ queryKey: ['tags'] });
    };

    const linkMutation = useMutation({
        mutationFn: async (tagId: string) => (await api.post(`/tags/companies/${company.id}`, { tag_id: tagId })).data,
        onSuccess: invalidate,
        onError: showErrorFromApi,
    });

    const unlinkMutation = useMutation({
        mutationFn: async (tagId: string) => api.delete(`/tags/companies/${company.id}/${tagId}`),
        onSuccess: invalidate,
        onError: showErrorFromApi,
    });

    // Create a new tenant tag, then link it to this company.
    const createMutation = useMutation({
        mutationFn: async () => {
            const created = (await api.post('/tags', { name: newName.trim(), color: newColor })).data.data as Tag;
            await api.post(`/tags/companies/${company.id}`, { tag_id: created.id });
            return created;
        },
        onSuccess: () => {
            setNewName('');
            setNewColor('blue');
            setAddOpen(false);
            invalidate();
        },
        onError: showErrorFromApi,
    });

    const hasQualData =
        company.lead_source ||
        company.priority ||
        company.qualification_status ||
        company.fit_score_num != null ||
        company.competitor_notes ||
        company.objection_notes;

    return (
        <Paper shadow="sm" radius="lg" p="xl" withBorder mb="lg">
            <Group gap="xs" mb="md">
                <IconTag size={18} />
                <Title order={5}>{t('qualification.sectionTitle')}</Title>
            </Group>

            {hasQualData ? (
                <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                    {company.priority && (
                        <Box>
                            <Text size="xs" c="dimmed" fw={600} tt="uppercase">{t('qualification.priority')}</Text>
                            <Badge color={PRIORITY_BADGE_COLOR[company.priority]} variant="light" radius="sm">
                                {t(`qualification.priorityOptions.${company.priority}`)}
                            </Badge>
                        </Box>
                    )}
                    {company.qualification_status && (
                        <Box>
                            <Text size="xs" c="dimmed" fw={600} tt="uppercase">{t('qualification.status')}</Text>
                            <Badge color={QUALIFICATION_STATUS_BADGE_COLOR[company.qualification_status]} variant="light" radius="sm">
                                {t(`qualification.statusOptions.${company.qualification_status}`)}
                            </Badge>
                        </Box>
                    )}
                    {company.fit_score_num != null && (
                        <Box>
                            <Text size="xs" c="dimmed" fw={600} tt="uppercase">{t('qualification.fitScoreNum')}</Text>
                            <Text size="sm">{company.fit_score_num} / 100</Text>
                        </Box>
                    )}
                    {company.lead_source && (
                        <Box>
                            <Text size="xs" c="dimmed" fw={600} tt="uppercase">{t('qualification.leadSource')}</Text>
                            <Text size="sm">{company.lead_source}</Text>
                        </Box>
                    )}
                    {company.competitor_notes && (
                        <Box>
                            <Text size="xs" c="dimmed" fw={600} tt="uppercase">{t('qualification.competitorNotes')}</Text>
                            <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{company.competitor_notes}</Text>
                        </Box>
                    )}
                    {company.objection_notes && (
                        <Box>
                            <Text size="xs" c="dimmed" fw={600} tt="uppercase">{t('qualification.objectionNotes')}</Text>
                            <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{company.objection_notes}</Text>
                        </Box>
                    )}
                </SimpleGrid>
            ) : (
                <Text size="sm" c="dimmed">{t('qualification.empty')}</Text>
            )}

            <Divider my="md" />

            {/* Tags */}
            <Text size="xs" c="dimmed" fw={600} tt="uppercase" mb="xs">{t('qualification.tags')}</Text>
            <Group gap="xs">
                {(companyTags ?? []).map((ct) => (
                    <Badge
                        key={ct.id}
                        color={ct.color || 'gray'}
                        variant="light"
                        radius="sm"
                        rightSection={
                            canEdit ? (
                                <ActionIcon
                                    size="xs"
                                    variant="transparent"
                                    color={ct.color || 'gray'}
                                    aria-label={t('qualification.removeTag')}
                                    onClick={() => unlinkMutation.mutate(ct.tag_id)}
                                >
                                    <IconX size={12} />
                                </ActionIcon>
                            ) : undefined
                        }
                    >
                        {ct.name || '—'}
                    </Badge>
                ))}
                {(companyTags ?? []).length === 0 && (
                    <Text size="sm" c="dimmed">{t('qualification.noTags')}</Text>
                )}

                {canEdit && (
                    <Popover opened={addOpen} onChange={setAddOpen} position="bottom-start" withArrow shadow="md" width={260}>
                        <Popover.Target>
                            <Button
                                size="compact-xs"
                                variant="light"
                                leftSection={<IconPlus size={12} />}
                                onClick={() => setAddOpen((o) => !o)}
                            >
                                {t('qualification.addTag')}
                            </Button>
                        </Popover.Target>
                        <Popover.Dropdown>
                            <Stack gap="sm">
                                <Select
                                    label={t('qualification.existingTag')}
                                    placeholder={t('qualification.selectTag')}
                                    searchable
                                    radius="md"
                                    data={availableTags.map((tag) => ({ value: tag.id, label: tag.name }))}
                                    nothingFoundMessage={t('qualification.noTagsAvailable')}
                                    value={null}
                                    onChange={(v) => { if (v) linkMutation.mutate(v); }}
                                />
                                <Divider label={t('qualification.orCreate')} labelPosition="center" />
                                <TextInput
                                    label={t('qualification.newTagName')}
                                    placeholder={t('qualification.newTagName')}
                                    radius="md"
                                    value={newName}
                                    onChange={(e) => setNewName(e.currentTarget.value)}
                                />
                                <Group gap={6}>
                                    {TAG_COLORS.map((c) => (
                                        <ColorSwatch
                                            key={c}
                                            component="button"
                                            type="button"
                                            color={`var(--mantine-color-${c}-6)`}
                                            size={20}
                                            style={{ cursor: 'pointer', outline: newColor === c ? '2px solid var(--mantine-color-blue-5)' : 'none' }}
                                            onClick={() => setNewColor(c)}
                                            aria-label={c}
                                        />
                                    ))}
                                </Group>
                                <Button
                                    size="xs"
                                    radius="md"
                                    disabled={!newName.trim()}
                                    loading={createMutation.isPending}
                                    onClick={() => createMutation.mutate(undefined)}
                                >
                                    {t('qualification.createTag')}
                                </Button>
                            </Stack>
                        </Popover.Dropdown>
                    </Popover>
                )}
            </Group>
        </Paper>
    );
}
