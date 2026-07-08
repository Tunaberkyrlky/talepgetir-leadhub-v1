/**
 * DialerTab — tek tık arama yüzeyi.
 * Şirket seç (opsiyonel, telefonu otomatik dolar) → numarayı doğrula (ülke
 * tarifesi/engel canlı gösterilir) → ara. Aktif çağrı durumu poll'lanır
 * (mock: simülasyon; twilio: Voice SDK + webhook'lar). Çağrı bitince sonuç
 * (disposition) + not alınır → activities'e düşer.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
    Alert, Badge, Button, Group, Loader, Paper, Select, Stack, Text, TextInput, Textarea, Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
    IconAlertTriangle, IconPhone, IconPhoneOff, IconMicrophone, IconMicrophoneOff, IconCheck,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showErrorFromApi } from '../../lib/notifications';
import { coldcallApi, matchCountry } from './api';
import { CallStatusBadge, TierBadge } from './badges';
import { dispositionLabel } from './labels';
import { DISPOSITION_OPTIONS, TERMINAL_CALL_STATUSES, type CallStatus, type Disposition } from './types';

type TwilioDevice = { destroy: () => void; disconnectAll: () => void };
type TwilioCall = { mute: (m: boolean) => void; disconnect: () => void };

interface CompanyOption {
    id: string;
    name: string;
    company_phone: string | null;
}

export default function DialerTab() {
    const { t, i18n } = useTranslation();
    const qc = useQueryClient();

    const [companySearch, setCompanySearch] = useState('');
    const [companyId, setCompanyId] = useState<string | null>(null);
    const [toNumber, setToNumber] = useState('');
    const [fromNumberId, setFromNumberId] = useState<string | null>(null);

    const [activeCallId, setActiveCallId] = useState<string | null>(null);
    const [muted, setMuted] = useState(false);
    const [nowTick, setNowTick] = useState(Date.now());
    const [disposition, setDisposition] = useState<Disposition | null>(null);
    const [notes, setNotes] = useState('');

    const deviceRef = useRef<TwilioDevice | null>(null);
    const twilioCallRef = useRef<TwilioCall | null>(null);

    const configQuery = useQuery({ queryKey: ['coldcall', 'config'], queryFn: coldcallApi.config });
    const numbersQuery = useQuery({ queryKey: ['coldcall', 'numbers'], queryFn: coldcallApi.numbers });
    const countriesQuery = useQuery({ queryKey: ['coldcall', 'countries'], queryFn: coldcallApi.countries, staleTime: 10 * 60 * 1000 });

    const companiesQuery = useQuery({
        queryKey: ['coldcall', 'companies', companySearch],
        queryFn: async (): Promise<CompanyOption[]> => {
            const res = await api.get('/companies', { params: { search: companySearch || undefined, limit: 20 } });
            return (res.data.data ?? []).map((c: { id: string; name: string; company_phone?: string | null }) => ({
                id: c.id,
                name: c.name,
                company_phone: c.company_phone ?? null,
            }));
        },
        enabled: companySearch.length >= 2,
    });

    const callQuery = useQuery({
        queryKey: ['coldcall', 'call', activeCallId],
        queryFn: () => coldcallApi.callDetail(activeCallId!),
        enabled: !!activeCallId,
        refetchInterval: (query) => {
            const status = query.state.data?.call.status;
            return status && TERMINAL_CALL_STATUSES.includes(status) ? false : 1000;
        },
    });

    const call = callQuery.data?.call;
    const isTerminal = !!call && TERMINAL_CALL_STATUSES.includes(call.status);

    // Konuşma süresi sayacı
    useEffect(() => {
        if (!call || call.status !== 'in_progress') return;
        const id = setInterval(() => setNowTick(Date.now()), 1000);
        return () => clearInterval(id);
    }, [call?.status, call]);

    const elapsedSec = useMemo(() => {
        if (!call?.answered_at) return 0;
        if (call.duration_sec != null && isTerminal) return call.duration_sec;
        return Math.max(0, Math.floor((nowTick - new Date(call.answered_at).getTime()) / 1000));
    }, [call, nowTick, isTerminal]);

    const matchedCountry = useMemo(() => {
        if (!toNumber.startsWith('+') || toNumber.length < 4 || !countriesQuery.data) return undefined;
        return matchCountry(toNumber, countriesQuery.data);
    }, [toNumber, countriesQuery.data]);

    const activeNumbers = (numbersQuery.data ?? []).filter((n) => n.status === 'active');

    const startMutation = useMutation({
        mutationFn: () =>
            coldcallApi.startCall({
                to_e164: toNumber.replace(/[\s()-]/g, ''),
                phone_number_id: fromNumberId ?? undefined,
                company_id: companyId ?? undefined,
            }),
        onSuccess: async ({ call: created, mode }) => {
            setActiveCallId(created.id);
            setDisposition(null);
            setNotes('');
            setMuted(false);
            if (mode === 'webrtc') {
                try {
                    const { Device } = await import('@twilio/voice-sdk');
                    const { token } = await coldcallApi.voiceToken();
                    const device = new Device(token, { edge: 'frankfurt' }) as unknown as TwilioDevice;
                    deviceRef.current = device;
                    const twCall = await (device as unknown as {
                        connect: (o: { params: Record<string, string> }) => Promise<TwilioCall>;
                    }).connect({ params: { callId: created.id } });
                    twilioCallRef.current = twCall;
                } catch {
                    notifications.show({ color: 'red', message: t('coldcall.webrtcFailed', 'Browser call could not start') });
                    await coldcallApi.hangup(created.id).catch(() => undefined);
                }
            }
        },
        onError: (err) => showErrorFromApi(err),
    });

    const hangupMutation = useMutation({
        mutationFn: async () => {
            twilioCallRef.current?.disconnect();
            deviceRef.current?.disconnectAll();
            if (activeCallId) await coldcallApi.hangup(activeCallId);
        },
        onError: (err) => showErrorFromApi(err),
    });

    const dispositionMutation = useMutation({
        mutationFn: async () => {
            if (!activeCallId || !disposition) return;
            await coldcallApi.setDisposition(activeCallId, disposition, notes);
        },
        onSuccess: () => {
            notifications.show({ color: 'green', icon: <IconCheck size={16} />, message: t('coldcall.dispositionSaved', 'Call outcome saved') });
            resetForNextCall();
            qc.invalidateQueries({ queryKey: ['coldcall', 'callsList'] });
            qc.invalidateQueries({ queryKey: ['coldcall', 'config'] });
        },
        onError: (err) => showErrorFromApi(err),
    });

    function resetForNextCall() {
        setActiveCallId(null);
        setDisposition(null);
        setNotes('');
        deviceRef.current?.destroy();
        deviceRef.current = null;
        twilioCallRef.current = null;
    }

    function toggleMute() {
        const next = !muted;
        setMuted(next);
        twilioCallRef.current?.mute(next);
    }

    const config = configQuery.data;
    const quotaExhausted = !!config && config.minutes_used >= config.minutes_quota;
    const countryName = matchedCountry ? (i18n.language === 'tr' ? matchedCountry.name_tr : matchedCountry.name_en) : null;

    const canStart =
        !!config &&
        !quotaExhausted &&
        activeNumbers.length > 0 &&
        /^\+\d{7,15}$/.test(toNumber.replace(/[\s()-]/g, '')) &&
        !!matchedCountry?.callable &&
        !startMutation.isPending &&
        !activeCallId;

    // ── Aktif çağrı görünümü ─────────────────────────────────────────────────
    if (activeCallId) {
        const status: CallStatus = call?.status ?? 'queued';
        return (
            <Paper withBorder p="xl" radius="md" maw={560}>
                <Stack align="center" gap="md">
                    <Text size="sm" c="dimmed">{call?.company?.name ?? t('coldcall.unknownCompany', 'Direct dial')}</Text>
                    <Title order={2}>{call?.to_e164 ?? toNumber}</Title>
                    <CallStatusBadge status={status} />
                    {status === 'in_progress' && (
                        <Text size="xl" fw={600} ff="monospace">
                            {String(Math.floor(elapsedSec / 60)).padStart(2, '0')}:{String(elapsedSec % 60).padStart(2, '0')}
                        </Text>
                    )}
                    {(status === 'queued' || status === 'ringing') && <Loader size="sm" />}

                    {!isTerminal && (
                        <Group>
                            <Button
                                variant="default"
                                leftSection={muted ? <IconMicrophoneOff size={18} /> : <IconMicrophone size={18} />}
                                onClick={toggleMute}
                                disabled={config?.call_mode !== 'webrtc'}
                                title={config?.call_mode !== 'webrtc' ? t('coldcall.muteSimHint', 'Not available in simulation') : undefined}
                            >
                                {muted ? t('coldcall.unmute', 'Unmute') : t('coldcall.mute', 'Mute')}
                            </Button>
                            <Button
                                color="red"
                                leftSection={<IconPhoneOff size={18} />}
                                loading={hangupMutation.isPending}
                                onClick={() => hangupMutation.mutate()}
                            >
                                {t('coldcall.hangup', 'Hang up')}
                            </Button>
                        </Group>
                    )}

                    {isTerminal && (
                        <Stack w="100%" gap="sm">
                            <Alert color={status === 'completed' ? 'green' : 'yellow'} variant="light">
                                {status === 'completed'
                                    ? t('coldcall.callEnded', 'Call ended — recording & AI summary are being prepared.')
                                    : t('coldcall.callNotConnected', 'Call did not connect.')}
                            </Alert>
                            <Select
                                label={t('coldcall.disposition', 'Call outcome')}
                                placeholder={t('coldcall.dispositionPick', 'Select outcome')}
                                data={DISPOSITION_OPTIONS.map((d) => ({ value: d, label: dispositionLabel(t, d) }))}
                                value={disposition}
                                onChange={(v) => setDisposition(v as Disposition | null)}
                            />
                            <Textarea
                                label={t('coldcall.notes', 'Notes')}
                                placeholder={t('coldcall.notesPlaceholder', 'What was discussed, next steps…')}
                                value={notes}
                                onChange={(e) => setNotes(e.currentTarget.value)}
                                minRows={2}
                            />
                            <Group justify="flex-end">
                                <Button variant="default" onClick={resetForNextCall}>
                                    {t('coldcall.skip', 'Skip')}
                                </Button>
                                <Button
                                    disabled={!disposition}
                                    loading={dispositionMutation.isPending}
                                    onClick={() => dispositionMutation.mutate()}
                                >
                                    {t('coldcall.saveOutcome', 'Save outcome')}
                                </Button>
                            </Group>
                        </Stack>
                    )}
                </Stack>
            </Paper>
        );
    }

    // ── Arama başlatma formu ─────────────────────────────────────────────────
    return (
        <Stack maw={560}>
            {config && activeNumbers.length === 0 && (
                <Alert color="orange" icon={<IconAlertTriangle size={18} />}>
                    {t('coldcall.noNumbers', 'Buy a phone number first (Numbers tab) to start calling.')}
                </Alert>
            )}
            {quotaExhausted && (
                <Alert color="red" icon={<IconAlertTriangle size={18} />}>
                    {t('coldcall.quotaExhausted', 'Monthly minute quota is exhausted.')}
                </Alert>
            )}

            <Select
                label={t('coldcall.company', 'Company (optional)')}
                placeholder={t('coldcall.companySearch', 'Type to search companies…')}
                searchable
                clearable
                searchValue={companySearch}
                onSearchChange={setCompanySearch}
                value={companyId}
                onChange={(v) => {
                    setCompanyId(v);
                    const selected = (companiesQuery.data ?? []).find((c) => c.id === v);
                    if (selected?.company_phone) setToNumber(selected.company_phone.replace(/[\s()-]/g, ''));
                }}
                data={(companiesQuery.data ?? []).map((c) => ({
                    value: c.id,
                    label: c.company_phone ? `${c.name} · ${c.company_phone}` : c.name,
                }))}
                nothingFoundMessage={
                    companySearch.length < 2
                        ? t('coldcall.companyTypeMore', 'Type at least 2 characters')
                        : t('coldcall.companyNotFound', 'No company found')
                }
                rightSection={companiesQuery.isFetching ? <Loader size="xs" /> : null}
            />

            <TextInput
                label={t('coldcall.toNumber', 'Number to call')}
                placeholder="+14155551234"
                value={toNumber}
                onChange={(e) => setToNumber(e.currentTarget.value)}
                error={
                    toNumber.length > 3 && !toNumber.startsWith('+')
                        ? t('coldcall.e164Required', 'Use international format starting with +')
                        : undefined
                }
            />

            {matchedCountry && (
                <Group gap="xs">
                    <Badge variant="default">{countryName}</Badge>
                    <TierBadge country={matchedCountry} />
                    {!matchedCountry.callable && (
                        <Text size="sm" c="red">
                            {t('coldcall.destinationBlocked', 'This destination cannot be called.')}
                        </Text>
                    )}
                </Group>
            )}
            {toNumber.startsWith('+') && toNumber.length > 5 && countriesQuery.data && !matchedCountry && (
                <Alert color="red" variant="light">
                    {t('coldcall.unknownDestination', 'No tariff defined for this destination — calling is disabled (fail-closed).')}
                </Alert>
            )}

            <Select
                label={t('coldcall.fromNumber', 'Call from')}
                placeholder={t('coldcall.fromNumberDefault', 'Default number')}
                clearable
                value={fromNumberId}
                onChange={setFromNumberId}
                data={activeNumbers.map((n) => ({ value: n.id, label: `${n.e164} (${n.country_code})` }))}
            />

            <Button
                size="md"
                leftSection={<IconPhone size={20} />}
                disabled={!canStart}
                loading={startMutation.isPending}
                onClick={() => startMutation.mutate()}
            >
                {t('coldcall.call', 'Call')}
            </Button>

            {config && (
                <Text size="xs" c="dimmed">
                    {t('coldcall.quotaLine', '{{used}} / {{quota}} minutes used this month', {
                        used: Math.round(config.minutes_used * 10) / 10,
                        quota: config.minutes_quota,
                    })}
                    {' · '}
                    {config.recording_mode === 'off'
                        ? t('coldcall.recordingOff', 'recording off')
                        : config.recording_mode === 'announce'
                            ? t('coldcall.recordingAnnounce', 'recording with announcement')
                            : t('coldcall.recordingAlways', 'recording on')}
                </Text>
            )}
        </Stack>
    );
}
