import {
    Modal, Stack, Group, Text, Badge, Button, Code, CopyButton, ActionIcon, Tooltip, Divider, Anchor, List,
} from '@mantine/core';
import { IconCopy, IconCheck, IconRefresh, IconExternalLink } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { DomainCheck, DomainHealthResult } from '../../types/campaign';
import { statusColor } from '../../lib/domainHealthUtils';

interface DomainHealthModalProps {
    opened: boolean;
    onClose: () => void;
    result: DomainHealthResult | { managed: true; domain: string; provider: string; checkedAt: string };
    onRefresh: () => void;
    refreshing: boolean;
}

function foundText(found: string[] | string | null): string | null {
    if (found === null) return null;
    if (Array.isArray(found)) return found.join('\n');
    return found;
}

function CheckDetail({ label, check, portalInstructions }: { label: string; check: DomainCheck; portalInstructions?: string }) {
    const { t } = useTranslation();
    const found = foundText(check.found);

    return (
        <Stack gap={6}>
            <Group gap={8}>
                <Badge size="sm" variant="light" color={statusColor(check.status)}>{label}</Badge>
                <Text size="xs" c="dimmed" tt="capitalize">
                    {t(`campaign.domainHealth.status.${check.status}`, check.status)}
                </Text>
            </Group>

            {found && (
                <Code block style={{ whiteSpace: 'pre-wrap', fontSize: 11 }}>{found}</Code>
            )}
            {!found && (
                <Text size="xs" c="dimmed">{t('campaign.domainHealth.notFound', 'Kayıt bulunamadı')}</Text>
            )}

            {check.notes.length > 0 && (
                <List size="xs" spacing={2} c="dimmed">
                    {check.notes.map((note) => (
                        <List.Item key={note}>
                            {t(`campaign.domainHealth.notes.${note}`, note)}
                        </List.Item>
                    ))}
                </List>
            )}

            {check.suggested && (
                <Stack gap={4}>
                    <Text size="xs" fw={600}>{t('campaign.domainHealth.suggestedRecord', 'Önerilen kayıt')}</Text>
                    <CopyButton value={check.suggested} timeout={2000}>
                        {({ copied, copy }) => (
                            <Group gap={6} wrap="nowrap" align="flex-start">
                                <Code block style={{ whiteSpace: 'pre-wrap', fontSize: 11, flex: 1 }}>{check.suggested}</Code>
                                <Tooltip label={copied ? t('campaign.domainHealth.copied', 'Kopyalandı!') : t('campaign.domainHealth.copy', 'Kopyala')} withArrow>
                                    <ActionIcon variant="subtle" color={copied ? 'teal' : 'gray'} onClick={copy}>
                                        {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                                    </ActionIcon>
                                </Tooltip>
                            </Group>
                        )}
                    </CopyButton>
                </Stack>
            )}

            {check.portalUrl && (
                <Stack gap={2}>
                    <Anchor href={check.portalUrl} target="_blank" rel="noopener noreferrer" size="xs">
                        <Group gap={4}>
                            {t('campaign.domainHealth.openProviderPortal', 'Sağlayıcı panelini aç')}
                            <IconExternalLink size={12} />
                        </Group>
                    </Anchor>
                    {portalInstructions && (
                        <Text size="xs" c="dimmed">{portalInstructions}</Text>
                    )}
                </Stack>
            )}
        </Stack>
    );
}

export default function DomainHealthModal({ opened, onClose, result, onRefresh, refreshing }: DomainHealthModalProps) {
    const { t } = useTranslation();

    if (result.managed) {
        return (
            <Modal opened={opened} onClose={onClose} title={t('campaign.domainHealth.title', 'Alan Adı Sağlık Durumu')} size="md">
                <Text size="sm" c="dimmed">
                    {t('campaign.domainHealth.managedByProvider', 'Bu alan adı sağlayıcı tarafından yönetiliyor')} ({result.provider})
                </Text>
            </Modal>
        );
    }

    const { checks, provider } = result;

    const dkimPortalInstructions = provider === 'm365'
        ? t('campaign.domainHealth.dkimInstructionsM365', 'Defender portalı → E-posta kimlik doğrulama ayarları → DKIM → anahtar oluşturun → 2 CNAME kaydını ekleyin → Etkinleştirin.')
        : provider === 'google'
            ? t('campaign.domainHealth.dkimInstructionsGoogle', 'Yönetici Konsolu → Gmail → E-posta kimliğini doğrulayın.')
            : undefined;

    return (
        <Modal opened={opened} onClose={onClose} title={t('campaign.domainHealth.title', 'Alan Adı Sağlık Durumu')} size="lg">
            <Stack gap="md">
                <Group justify="space-between">
                    <Text size="sm" fw={600}>{result.domain}</Text>
                    <Button
                        size="xs"
                        variant="light"
                        leftSection={<IconRefresh size={14} />}
                        loading={refreshing}
                        onClick={onRefresh}
                    >
                        {t('campaign.domainHealth.recheck', 'Tekrar kontrol et')}
                    </Button>
                </Group>

                <CheckDetail label="MX" check={checks.mx} />
                <Divider />
                <CheckDetail label="SPF" check={checks.spf} />
                <Divider />
                <CheckDetail label="DKIM" check={checks.dkim} portalInstructions={dkimPortalInstructions} />
                <Divider />
                <CheckDetail label="DMARC" check={checks.dmarc} />
            </Stack>
        </Modal>
    );
}
