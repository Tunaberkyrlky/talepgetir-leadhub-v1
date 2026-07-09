/**
 * LinkedInConnectPage — the extension-pairing bridge (Faz 1 leftover).
 *
 * The "Connect account" button (LinkedInAccountsPanel) issues a single-use token and opens
 * this page at /linkedin/connect#token=<raw>. Here we hand that token to the MV3 extension,
 * which reads the httpOnly li_at cookie the web page itself cannot see and POSTs it to the
 * token-gated capture endpoint. Two paths:
 *   A) app-driven: message the extension by id (VITE_LINKEDIN_EXTENSION_ID) — one click.
 *   B) manual fallback (always shown): copy the token into the extension popup.
 * The token never leaves the browser except through the extension; we never send cookies.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Code, CopyButton, Group, List, Loader, Paper, Stack, Text, Title } from '@mantine/core';
import { IconBrandLinkedin, IconCheck, IconCopy, IconInfoCircle } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';

// Chrome's externally-connectable messaging surface (present only with the extension).
type ChromeRuntime = {
    runtime?: { sendMessage?: (id: string, msg: unknown, cb: (resp?: { ok?: boolean; error?: string }) => void) => void };
};

function tokenFromHash(hash: string): string | null {
    const m = hash.match(/token=([A-Za-z0-9]+)/);
    const raw = m?.[1] ?? null;
    return raw && raw.length >= 32 && raw.length <= 128 ? raw : null;
}

// Where "Connected" lands the user: the LinkedIn tab's Accounts sub-tab.
const ACCOUNTS_URL = '/research?tab=linkedin&sub=accounts';
// Poll long enough to install/open the extension and paste the token.
const CONNECT_WATCH_MS = 4 * 60 * 1000;

export default function LinkedInConnectPage() {
    const { t } = useTranslation();
    const location = useLocation();
    const navigate = useNavigate();
    const token = useMemo(() => tokenFromHash(location.hash), [location.hash]);

    const extensionId = import.meta.env.VITE_LINKEDIN_EXTENSION_ID as string | undefined;
    const chrome = (window as unknown as { chrome?: ChromeRuntime }).chrome;
    const canAutoConnect = !!token && !!extensionId && !!chrome?.runtime?.sendMessage;

    const [state, setState] = useState<'idle' | 'connecting' | 'ok' | 'error'>('idle');
    const [error, setError] = useState<string | null>(null);

    const connect = () => {
        if (!canAutoConnect) return;
        setState('connecting');
        setError(null);
        chrome!.runtime!.sendMessage!(extensionId!, { type: 'CONNECT_LINKEDIN', token }, (resp) => {
            if (resp?.ok) { setState('ok'); return; }
            setState('error');
            setError(resp?.error ?? 'unknown');
        });
    };

    // Auto-fire once when the app-driven path is available (the common one-click case).
    useEffect(() => {
        if (canAutoConnect && state === 'idle') connect();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canAutoConnect]);

    // The manual popup path gives this page no callback: the extension POSTs the capture
    // straight to the server. So watch the accounts list for a bounded window and flip to
    // "Connected" automatically when a new account row shows up — no reload, no callback.
    const baselineIds = useRef<Set<string> | null>(null);
    const watchDeadline = useRef<number>(Date.now() + CONNECT_WATCH_MS);
    const watchQuery = useQuery<{ data: { id: string }[] }>({
        queryKey: ['linkedin', 'connect-watch'],
        queryFn: async () => (await api.get('/linkedin/accounts')).data,
        enabled: !!token && state !== 'ok',
        refetchInterval: () => (Date.now() < watchDeadline.current ? 3000 : false),
    });
    useEffect(() => {
        const ids = watchQuery.data?.data?.map((a) => a.id);
        if (!ids) return;
        if (baselineIds.current === null) { baselineIds.current = new Set(ids); return; }
        if (ids.some((id) => !baselineIds.current!.has(id)) && state !== 'ok') setState('ok');
    }, [watchQuery.data, state]);

    // On success (either path), bring the user back to the Accounts view automatically.
    useEffect(() => {
        if (state !== 'ok') return;
        const id = window.setTimeout(() => navigate(ACCOUNTS_URL), 2000);
        return () => window.clearTimeout(id);
    }, [state, navigate]);

    if (!token) {
        return (
            <Paper withBorder radius="md" p="xl" maw={560} mx="auto" mt="xl">
                <Alert color="red" icon={<IconInfoCircle size={16} />}>
                    {t('research.linkedin.connectPage.noToken', 'No pairing token in the link. Open “Connect account” from the LinkedIn panel to get a fresh link.')}
                </Alert>
            </Paper>
        );
    }

    return (
        <Paper withBorder radius="md" p="xl" maw={560} mx="auto" mt="xl">
            <Stack gap="md">
                <Group gap="xs">
                    <IconBrandLinkedin size={22} />
                    <Title order={4}>{t('research.linkedin.connectPage.title', 'Connect your LinkedIn session')}</Title>
                </Group>

                {state === 'ok' ? (
                    <Stack gap="sm">
                        <Alert color="green" icon={<IconCheck size={16} />}>
                            {t('research.linkedin.connectPage.done', 'Connected. Taking you back to your accounts…')}
                        </Alert>
                        <Button leftSection={<IconBrandLinkedin size={16} />} onClick={() => navigate(ACCOUNTS_URL)}>
                            {t('research.linkedin.connectPage.backToAccounts', 'Back to accounts')}
                        </Button>
                    </Stack>
                ) : (
                    <>
                        {canAutoConnect && (
                            <Group>
                                <Button leftSection={<IconBrandLinkedin size={16} />} onClick={connect} loading={state === 'connecting'}>
                                    {t('research.linkedin.connectPage.action', 'Connect via extension')}
                                </Button>
                                {state === 'connecting' && <Loader size="sm" />}
                            </Group>
                        )}
                        {state === 'error' && (
                            <Alert color="red" icon={<IconInfoCircle size={16} />}>
                                {t('research.linkedin.connectPage.failed', 'The extension could not capture your session')}: {error}
                            </Alert>
                        )}

                        {/* Manual fallback — always available even without the extension id. */}
                        <div>
                            <Text size="sm" fw={600} mb={4}>
                                {t('research.linkedin.connectPage.manualTitle', 'Or connect manually')}
                            </Text>
                            <List size="sm" spacing={4} type="ordered">
                                <List.Item>{t('research.linkedin.connectPage.step1', 'Make sure you are logged into LinkedIn in this browser.')}</List.Item>
                                <List.Item>{t('research.linkedin.connectPage.step2', 'Open the TG Core LinkedIn extension (toolbar icon).')}</List.Item>
                                <List.Item>{t('research.linkedin.connectPage.step3', 'Paste the pairing token below and press Connect.')}</List.Item>
                            </List>
                            <Group mt="sm" gap="xs" wrap="nowrap">
                                <Code style={{ overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}>{token}</Code>
                                <CopyButton value={token}>
                                    {({ copied, copy }) => (
                                        <Button size="xs" variant="light" leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />} onClick={copy}>
                                            {copied ? t('research.linkedin.connectPage.copied', 'Copied') : t('research.linkedin.connectPage.copy', 'Copy token')}
                                        </Button>
                                    )}
                                </CopyButton>
                            </Group>
                        </div>
                    </>
                )}
            </Stack>
        </Paper>
    );
}
