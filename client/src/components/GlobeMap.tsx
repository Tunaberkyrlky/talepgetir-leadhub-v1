import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import {
    Paper, Text, Loader, Center, Box, ActionIcon, Modal, Table, Badge,
    ScrollArea, Group, Button, Stack, Menu,
} from '@mantine/core';
import { IconMaximize, IconMinimize, IconExternalLink, IconMapPin, IconCheck, IconX, IconWorld, IconChevronDown, IconRefresh, IconPlus, IconMinus } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ComposableMap, Geographies, Geography, ZoomableGroup } from 'react-simple-maps';
import * as topojson from 'topojson-client';
import topoData from 'world-atlas/countries-110m.json';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { COUNTRY_NAMES } from '../lib/countryNames';
import { useStages } from '../contexts/StagesContext';
import api from '../lib/api';

type GeoFeature = { id?: string | number; [key: string]: unknown };

// Bundled country polygons — computed once at module load, no runtime fetch needed
const GEO_FEATURES: GeoFeature[] = (
    topojson.feature(
        topoData as unknown as Parameters<typeof topojson.feature>[0],
        (topoData as any).objects.countries
    ) as unknown as { features: GeoFeature[] }
).features ?? [];

export interface CompanyLocation {
    id: string;
    name: string;
    location: string | null;
    latitude: number;
    longitude: number;
    stage: string;
}

export interface GeocodeStageItem {
    message: string;
    status: 'active' | 'done' | 'error';
}

interface GlobeMapProps {
    data: CompanyLocation[];
    isLoading?: boolean;
    /** Called when the user clicks "Update Locations" from the map menu */
    onGeocode?: () => void;
    /** Whether a geocode batch job is currently running */
    geocodeLoading?: boolean;
    /** Whether the current user is allowed to trigger geocoding */
    canGeocode?: boolean;
    /** Number of pipeline companies lacking coordinates */
    missingCount?: number;
    /** Live stage messages from the geocode stream */
    geocodeStages?: GeocodeStageItem[];
}

// Stage group definitions
const STAGE_GROUPS = {
    ilkTemas:      ['in_queue', 'first_contact', 'connected'],
    kalifikasyon:  ['qualified', 'in_meeting', 'follow_up'],
    degerlendirme: ['proposal_sent', 'negotiation'],
    karar:         ['won', 'lost', 'on_hold'],
} as const;

type CountryStats = { total: number; ilkTemas: number; kalifikasyon: number; degerlendirme: number; karar: number };
type CountryMarker = { id: number; name: string; lat: number; lng: number; stats: CountryStats };

const STAGE_COLORS = [
    { key: 'ilkTemas', color: '#339af0', labelKey: 'stageGroups.firstContact' },
    { key: 'kalifikasyon', color: '#ff922b', labelKey: 'stageGroups.qualification' },
    { key: 'degerlendirme', color: '#cc5de8', labelKey: 'stageGroups.evaluation' },
    { key: 'karar', color: '#51cf66', labelKey: 'stageGroups.closing' },
] as const;

interface ModalCompany {
    id: string;
    name: string;
    industry: string | null;
    stage: string;
    location: string | null;
    contact_count: number;
}

/** Popup table showing companies for a selected country */
function CountryCompaniesModal({
    countryName,
    onClose,
}: {
    countryName: string;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { getStageColor, getStageLabel } = useStages();

    const { data, isLoading } = useQuery<{ data: ModalCompany[] }>({
        queryKey: ['companies', 'map', countryName],
        queryFn: async () => (await api.get(`/companies?search=${encodeURIComponent(countryName)}&limit=100`)).data,
        enabled: !!countryName,
    });

    const companies = data?.data || [];

    return (
        <Modal
            opened
            onClose={onClose}
            title={
                <Group gap="xs" justify="space-between" style={{ flex: 1, marginRight: 32 }}>
                    <Group gap="xs">
                        <Text fw={600}>{countryName}</Text>
                        <Badge size="sm" variant="light" color="violet">{companies.length}</Badge>
                    </Group>
                    <Button
                        variant="light"
                        size="compact-xs"
                        rightSection={<IconExternalLink size={12} />}
                        onClick={() => navigate(`/companies?locations=${encodeURIComponent(countryName)}&fromMap=true`)}
                    >
                        {t('dashboard.goToTable', 'Tabloda göster')}
                    </Button>
                </Group>
            }
            size="lg"
            radius="lg"
        >
            {isLoading ? (
                <Center py="xl"><Loader size="sm" /></Center>
            ) : companies.length === 0 ? (
                <Center py="xl"><Text c="dimmed">{t('pipeline.emptyColumn')}</Text></Center>
            ) : (
                <ScrollArea.Autosize mah={450}>
                    <Table striped highlightOnHover verticalSpacing="xs" horizontalSpacing="sm">
                        <Table.Thead>
                            <Table.Tr>
                                <Table.Th>{t('company.name')}</Table.Th>
                                <Table.Th>{t('company.stage')}</Table.Th>
                                <Table.Th>{t('company.industry')}</Table.Th>
                                <Table.Th style={{ width: 40 }} />
                            </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                            {companies.map((c) => (
                                <Table.Tr
                                    key={c.id}
                                    style={{ cursor: 'pointer' }}
                                    onClick={() => navigate(`/companies/${c.id}`)}
                                >
                                    <Table.Td>
                                        <Text size="sm" fw={500} lineClamp={1}>{c.name}</Text>
                                    </Table.Td>
                                    <Table.Td>
                                        <Badge size="xs" variant="light" color={getStageColor(c.stage)} radius="sm">
                                            {getStageLabel(c.stage)}
                                        </Badge>
                                    </Table.Td>
                                    <Table.Td>
                                        <Text size="xs" c="dimmed" lineClamp={1}>{c.industry || '—'}</Text>
                                    </Table.Td>
                                    <Table.Td>
                                        <ActionIcon variant="subtle" size="xs" color="gray">
                                            <IconExternalLink size={14} />
                                        </ActionIcon>
                                    </Table.Td>
                                </Table.Tr>
                            ))}
                        </Table.Tbody>
                    </Table>
                </ScrollArea.Autosize>
            )}
        </Modal>
    );
}

export default function GlobeMap({ data, isLoading, onGeocode, geocodeLoading, canGeocode, missingCount = 0, geocodeStages = [] }: GlobeMapProps) {
    const { t } = useTranslation();
    const containerRef = useRef<HTMLDivElement>(null);
    const [dimensions, setDimensions] = useState({ width: 600, height: 320 });
    const [hoveredMarker, setHoveredMarker] = useState<CountryMarker | null>(null);
    const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [selectedCountry, setSelectedCountry] = useState<string | null>(null);
    const mapContainerRef = useRef<HTMLDivElement>(null);
    const [mapKey, setMapKey] = useState(0);
    const [projCenter, setProjCenter] = useState<[number, number]>([20, 15]);
    const [projScale, setProjScale] = useState(140);
    // Track current pan center so zoom buttons don't reset it
    const currentCenterRef = useRef<[number, number]>([20, 15]);

    const goToRegion = useCallback((center: [number, number], scale: number) => {
        currentCenterRef.current = center;
        setProjCenter(center);
        setProjScale(scale);
        setMapKey(k => k + 1);
    }, []);

    const handleZoomIn = useCallback(() => {
        setProjCenter(currentCenterRef.current);
        setProjScale(s => Math.min(Math.round(s * 1.6), 4000));
        setMapKey(k => k + 1);
    }, []);

    const handleZoomOut = useCallback(() => {
        setProjCenter(currentCenterRef.current);
        setProjScale(s => Math.max(Math.round(s / 1.6), 80));
        setMapKey(k => k + 1);
    }, []);

    const OTHER_REGIONS = useMemo(() => [
        { label: t('map.regionNorthAmerica', 'Kuzey Amerika'), center: [-95, 45]  as [number, number], scale: 320 },
        { label: t('map.regionSouthAmerica', 'Güney Amerika'), center: [-60, -15] as [number, number], scale: 320 },
        { label: t('map.regionAsia', 'Asya'),                  center: [90, 35]   as [number, number], scale: 320 },
        { label: t('map.regionAfrica', 'Afrika'),              center: [20, 5]    as [number, number], scale: 320 },
        { label: t('map.regionMiddleEast', 'Orta Doğu'),       center: [45, 28]   as [number, number], scale: 600 },
        { label: t('map.regionOceania', 'Okyanusya'),          center: [140, -25] as [number, number], scale: 450 },
    ], [t]);

    // Toggle fullscreen
    const toggleFullscreen = useCallback(() => {
        if (!mapContainerRef.current) return;
        if (!document.fullscreenElement) {
            mapContainerRef.current.requestFullscreen().then(() => setIsFullscreen(true));
        } else {
            document.exitFullscreen().then(() => setIsFullscreen(false));
        }
    }, []);

    // Sync state when user exits fullscreen via Escape key
    useEffect(() => {
        const handler = () => {
            if (!document.fullscreenElement) setIsFullscreen(false);
        };
        document.addEventListener('fullscreenchange', handler);
        return () => document.removeEventListener('fullscreenchange', handler);
    }, []);

    // Responsive sizing
    useEffect(() => {
        if (!containerRef.current) return;
        const observer = new ResizeObserver((entries) => {
            const entry = entries[0];
            if (entry) {
                const w = Math.floor(entry.contentRect.width);
                setDimensions({ width: w, height: Math.min(320, Math.max(220, Math.floor(w * 0.4))) });
            }
        });
        observer.observe(containerRef.current);
        return () => observer.disconnect();
    }, []);

    // Filter out cold companies
    const activeData = useMemo(() => data.filter(c => c.stage !== 'cold'), [data]);

    // Pre-compute: country feature id → stage group counts + markers
    //
    // Strategy: group companies by coordinate pair first (companies in the same country
    // share identical centroids), then try booleanPointInPolygon per unique coordinate to
    // get the feature ID for country fill color. Markers are emitted regardless of whether
    // the polygon lookup succeeds — this fixes rendering for small/simplified countries at
    // 110m atlas resolution where the centroid can fall outside the simplified polygon.
    const { countryCompanyCounts, countryMarkers } = useMemo(() => {
        const countMap = new Map<number, CountryStats>();
        if (!activeData.length) return { countryCompanyCounts: countMap, countryMarkers: [] };

        const addStage = (stats: CountryStats, stage: string) => {
            stats.total += 1;
            if ((STAGE_GROUPS.ilkTemas as readonly string[]).includes(stage))           stats.ilkTemas += 1;
            else if ((STAGE_GROUPS.kalifikasyon as readonly string[]).includes(stage))  stats.kalifikasyon += 1;
            else if ((STAGE_GROUPS.degerlendirme as readonly string[]).includes(stage)) stats.degerlendirme += 1;
            else if ((STAGE_GROUPS.karar as readonly string[]).includes(stage))         stats.karar += 1;
        };

        // Step 1: group by coordinate pair — each unique (lat,lng) = one country centroid.
        // PostgreSQL numeric columns are returned as strings by Supabase JSON serialization,
        // so we must parse to float explicitly before any arithmetic or projection.
        type CoordGroup = { lat: number; lng: number; location: string; stats: CountryStats };
        const coordGroups = new Map<string, CoordGroup>();
        for (const company of activeData) {
            const lat = parseFloat(String(company.latitude));
            const lng = parseFloat(String(company.longitude));
            if (!isFinite(lat) || !isFinite(lng)) continue;
            const key = `${lat},${lng}`;
            let g = coordGroups.get(key);
            if (!g) {
                g = { lat, lng, location: company.location || '', stats: { total: 0, ilkTemas: 0, kalifikasyon: 0, degerlendirme: 0, karar: 0 } };
                coordGroups.set(key, g);
            }
            addStage(g.stats, company.stage);
        }

        // Step 2: for each unique coordinate, try to find the matching country feature
        // (used only for polygon fill color). Fallback synthetic IDs start above real
        // ISO numeric codes (max ~900) to avoid collisions.
        const pt = (lng: number, lat: number) => ({
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: [lng, lat] },
            properties: {},
        });

        // featureId → marker (for merging multiple coord groups that land in the same polygon)
        const mergedMarkers = new Map<number, CountryMarker>();
        const fallbackMarkers: CountryMarker[] = [];
        let syntheticId = 100_000;

        const mergeStats = (target: CountryStats, src: CountryStats) => {
            target.total        += src.total;
            target.ilkTemas     += src.ilkTemas;
            target.kalifikasyon += src.kalifikasyon;
            target.degerlendirme += src.degerlendirme;
            target.karar        += src.karar;
        };

        for (const group of coordGroups.values()) {
            const point = pt(group.lng, group.lat);
            let featureId: number | null = null;

            try {
                for (const feature of GEO_FEATURES) {
                    if (booleanPointInPolygon(point, feature as any)) {
                        featureId = Number(feature.id);
                        break;
                    }
                }
            } catch {
                // booleanPointInPolygon can throw for degenerate geometries in the atlas
            }

            if (featureId !== null) {
                const existing = mergedMarkers.get(featureId);
                if (existing) {
                    // Another coord group already matched this country polygon — merge stats.
                    // This happens when a neighbouring country's centroid falls inside a
                    // simplified 110m polygon (e.g. North Macedonia inside Bulgaria).
                    mergeStats(existing.stats, group.stats);
                    countMap.set(featureId, existing.stats);
                } else {
                    const stats = { ...group.stats };
                    countMap.set(featureId, stats);
                    const name = COUNTRY_NAMES[featureId] ?? group.location;
                    const marker: CountryMarker = { id: featureId, name, lat: group.lat, lng: group.lng, stats };
                    mergedMarkers.set(featureId, marker);
                }
            } else {
                // Polygon lookup failed (centroid outside simplified 110m border) —
                // still emit the marker so the company count is visible on the map.
                fallbackMarkers.push({ id: syntheticId++, name: group.location, lat: group.lat, lng: group.lng, stats: { ...group.stats } });
            }
        }

        const markers = [...mergedMarkers.values(), ...fallbackMarkers];

        // Sort ascending so highest count renders last (on top in SVG)
        markers.sort((a, b) => a.stats.total - b.stats.total);

        return { countryCompanyCounts: countMap, countryMarkers: markers };
    }, [activeData]);

    const getCountryFill = useCallback((geo: any) => {
        const stats = countryCompanyCounts.get(Number(geo.id));
        const count = stats?.total ?? 0;
        if (count === 0) return '#d9e2ec';
        // Light → dark blue scale
        const t = Math.min(1, 0.2 + count * 0.12);
        const r = Math.round(180 - t * 150);
        const g = Math.round(210 - t * 110);
        const b = Math.round(255 - t * 40);
        return `rgb(${r}, ${g}, ${b})`;
    }, [countryCompanyCounts]);

    const handleCountryClick = useCallback((geo: any) => {
        const id = Number(geo.id);
        const stats = countryCompanyCounts.get(id);
        if (!stats || stats.total === 0) return;
        const name = COUNTRY_NAMES[id];
        if (name) setSelectedCountry(name);
    }, [countryCompanyCounts]);

    const handleMarkerHover = useCallback((marker: CountryMarker | null, e?: React.MouseEvent) => {
        setHoveredMarker(marker);
        if (e && marker) {
            setTooltipPos({ x: e.clientX + 14, y: e.clientY - 12 });
        }
    }, []);

    const handleMarkerMove = useCallback((e: React.MouseEvent) => {
        if (hoveredMarker) {
            setTooltipPos({ x: e.clientX + 14, y: e.clientY - 12 });
        }
    }, [hoveredMarker]);

    return (
        <Paper shadow="sm" radius="lg" p="lg" mb="lg" withBorder>
            <Group justify="space-between" mb={geocodeStages.length > 0 ? 'xs' : 'xs'} align="flex-start">
                <Text size="sm" fw={700} tt="uppercase" c="dimmed" style={{ letterSpacing: '0.5px', marginTop: 2 }}>
                    {t('dashboard.companyLocations')}
                </Text>
                <Group gap="xs" align="center">
                    {geocodeStages.length > 0 && (() => {
                        const last = geocodeStages[geocodeStages.length - 1];
                        return (
                            <Group gap={6} align="center" wrap="nowrap">
                                <Box style={{ width: 12, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                    {last.status === 'active' && <Loader size={10} color="blue" />}
                                    {last.status === 'done' && <IconCheck size={12} color="var(--mantine-color-green-6)" />}
                                    {last.status === 'error' && <IconX size={12} color="var(--mantine-color-red-6)" />}
                                </Box>
                                <Text
                                    size="xs"
                                    c={last.status === 'error' ? 'red' : last.status === 'active' ? 'blue' : 'dimmed'}
                                    style={{ fontFamily: 'monospace', letterSpacing: '0.2px' }}
                                >
                                    {last.message}
                                </Text>
                            </Group>
                        );
                    })()}
                    {canGeocode && onGeocode && (
                        <Button
                            size="compact-xs"
                            variant="light"
                            color="blue"
                            leftSection={geocodeLoading ? <Loader size={10} color="blue" /> : <IconMapPin size={12} />}
                            onClick={onGeocode}
                            disabled={geocodeLoading}
                            rightSection={!geocodeLoading && missingCount > 0
                                ? <Badge size="xs" color="yellow" variant="filled">{missingCount}</Badge>
                                : undefined
                            }
                        >
                            {t('dashboard.geocodeBtn', 'Konumları Güncelle')}
                        </Button>
                    )}
                </Group>
            </Group>

            <Box ref={containerRef} style={{ width: '100%' }}>
                {isLoading ? (
                    <Center style={{ height: dimensions.height }}>
                        <Loader size="lg" color="violet" />
                    </Center>
                ) : (
                    <>
                        <Box
                            ref={mapContainerRef}
                            style={{
                                background: '#f4f6f8',
                                borderRadius: isFullscreen ? 0 : 12,
                                overflow: 'hidden',
                                position: 'relative',
                                border: '1px solid #e2e8f0',
                            }}
                        >
                            <Group
                                gap={6}
                                style={{
                                    position: 'absolute',
                                    top: 10,
                                    right: 10,
                                    zIndex: 10,
                                }}
                            >
                                {/* Region selector */}
                                <Menu shadow="md" width={180} position="bottom-end">
                                    <Menu.Target>
                                        <Button
                                            size="compact-sm"
                                            variant="default"
                                            rightSection={<IconChevronDown size={12} />}
                                            leftSection={<IconWorld size={13} />}
                                            style={{
                                                background: 'rgba(255,255,255,0.85)',
                                                border: '1px solid #d1d5db',
                                                color: '#374151',
                                                fontSize: 12,
                                            }}
                                        >
                                            {t('map.regions', 'Bölgeler')}
                                        </Button>
                                    </Menu.Target>
                                    <Menu.Dropdown>
                                        <Menu.Item
                                            leftSection={<IconRefresh size={14} />}
                                            onClick={() => goToRegion([20, 15], 140)}
                                        >
                                            {t('map.reset', 'Sıfırla')}
                                        </Menu.Item>
                                        <Menu.Divider />
                                        <Menu.Item
                                            leftSection={<IconWorld size={14} />}
                                            onClick={() => goToRegion([15, 54], 500)}
                                        >
                                            {t('map.regionEurope', 'Avrupa')}
                                        </Menu.Item>
                                        <Menu.Divider />
                                        <Menu.Label>{t('map.otherRegions', 'Diğer Bölgeler')}</Menu.Label>
                                        {OTHER_REGIONS.map(r => (
                                            <Menu.Item
                                                key={r.label}
                                                onClick={() => goToRegion(r.center, r.scale)}
                                            >
                                                {r.label}
                                            </Menu.Item>
                                        ))}
                                    </Menu.Dropdown>
                                </Menu>

                                {/* Fullscreen toggle */}
                                <ActionIcon
                                    variant="default"
                                    size="md"
                                    onClick={toggleFullscreen}
                                    style={{
                                        background: 'rgba(255,255,255,0.85)',
                                        color: '#6b7280',
                                    }}
                                    title={isFullscreen ? t('common.exitFullscreen') : t('common.fullscreen')}
                                >
                                    {isFullscreen ? <IconMinimize size={16} /> : <IconMaximize size={16} />}
                                </ActionIcon>
                            </Group>
                            {/* Zoom controls — bottom right */}
                            <Stack
                                gap={2}
                                style={{
                                    position: 'absolute',
                                    bottom: 10,
                                    right: 10,
                                    zIndex: 10,
                                }}
                            >
                                <ActionIcon
                                    variant="default"
                                    size="md"
                                    onClick={handleZoomIn}
                                    title={t('map.zoomIn', 'Yakınlaştır')}
                                    style={{ background: 'rgba(255,255,255,0.85)', color: '#374151' }}
                                >
                                    <IconPlus size={14} />
                                </ActionIcon>
                                <ActionIcon
                                    variant="default"
                                    size="md"
                                    onClick={handleZoomOut}
                                    title={t('map.zoomOut', 'Uzaklaştır')}
                                    style={{ background: 'rgba(255,255,255,0.85)', color: '#374151' }}
                                >
                                    <IconMinus size={14} />
                                </ActionIcon>
                            </Stack>

                            <ComposableMap
                                key={mapKey}
                                projection="geoNaturalEarth1"
                                projectionConfig={{ scale: projScale, center: projCenter }}
                                width={800}
                                height={340}
                                style={{ width: '100%', height: isFullscreen ? '100vh' : 'auto', display: 'block' }}
                            >
                                <ZoomableGroup
                                    minZoom={1}
                                    maxZoom={8}
                                    onMoveEnd={({ coordinates }) => {
                                        currentCenterRef.current = coordinates as [number, number];
                                    }}
                                >
                                    <Geographies geography={topoData as any}>
                                        {({ geographies }) =>
                                            geographies.map((geo) => {
                                                const fill = getCountryFill(geo);
                                                const id = Number(geo.id);
                                                const hasCompanies = (countryCompanyCounts.get(id)?.total ?? 0) > 0;
                                                const marker = hasCompanies ? countryMarkers.find(m => m.id === id) : undefined;
                                                return (
                                                    <Geography
                                                        key={geo.rsmKey}
                                                        geography={geo}
                                                        fill={hoveredMarker?.id === id ? '#bfdbfe' : fill}
                                                        stroke="#ffffff"
                                                        strokeWidth={0.5}
                                                        onClick={() => handleCountryClick(geo)}
                                                        onMouseEnter={(e: React.MouseEvent) => marker && handleMarkerHover(marker, e)}
                                                        onMouseLeave={() => handleMarkerHover(null)}
                                                        style={{
                                                            default: { outline: 'none', filter: hoveredMarker?.id === id ? 'drop-shadow(0 0 6px rgba(59,130,246,0.7))' : 'none' },
                                                            hover: { outline: 'none' },
                                                            pressed: { outline: 'none' },
                                                        }}
                                                    />
                                                );
                                            })
                                        }
                                    </Geographies>
                                </ZoomableGroup>
                            </ComposableMap>
                        </Box>

                        {/* Tooltip */}
                        {hoveredMarker && (
                            <div
                                style={{
                                    position: 'fixed',
                                    top: tooltipPos.y,
                                    left: tooltipPos.x,
                                    background: '#1f2937',
                                    color: '#f9fafb',
                                    padding: '11px 16px',
                                    borderRadius: 8,
                                    fontSize: 14,
                                    fontFamily: 'sans-serif',
                                    whiteSpace: 'nowrap',
                                    lineHeight: 1.75,
                                    pointerEvents: 'none',
                                    boxShadow: '0 4px 20px rgba(0,0,0,0.25)',
                                    border: '1px solid #374151',
                                    zIndex: 99999,
                                    transform: 'translateY(-50%)',
                                }}
                            >
                                <div style={{ fontSize: 17, fontWeight: 700, color: '#f9fafb', marginBottom: 7, paddingBottom: 6, borderBottom: '1px solid #374151' }}>
                                    {hoveredMarker.name || String(hoveredMarker.id)}
                                </div>
                                <div style={{ color: '#9ca3af', marginBottom: 6, fontSize: 15 }}>
                                    {t('dashboard.totalCompanies')}: <strong style={{ color: '#ffffff', fontSize: 16 }}>{hoveredMarker.stats.total}</strong> {t('dashboard.companies').toLowerCase()}
                                </div>
                                <div style={{ borderTop: '1px solid #374151', margin: '4px 0 7px' }} />
                                {STAGE_COLORS.map(({ key, color, labelKey }) => (
                                    <div key={key} style={{ display: 'flex', alignItems: 'center' }}>
                                        <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: color, marginRight: 7, flexShrink: 0 }} />
                                        <span style={{ color: '#d1d5db' }}>
                                            {t(labelKey)}: <strong style={{ color: '#f9fafb' }}>{hoveredMarker.stats[key]}</strong> {t('dashboard.companies').toLowerCase()}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}

                        {!isLoading && data.length === 0 && (
                            <Center mt="xs">
                                <Text c="dimmed" size="sm" ta="center" maw={380}>
                                    {t('dashboard.noLocations')}
                                </Text>
                            </Center>
                        )}

                        {/* Country badge list below map */}
                        {countryMarkers.length > 0 && (
                            <Group gap={6} mt="sm" wrap="wrap">
                                {[...countryMarkers]
                                    .sort((a, b) => b.stats.total - a.stats.total)
                                    .map((marker) => (
                                        <div
                                            key={marker.id}
                                            onClick={() => {
                                                const name = COUNTRY_NAMES[marker.id] ?? marker.name;
                                                if (name) setSelectedCountry(name);
                                            }}
                                            onMouseEnter={(e) => handleMarkerHover(marker, e)}
                                            onMouseMove={(e) => handleMarkerMove(e)}
                                            onMouseLeave={() => handleMarkerHover(null)}
                                            style={{ cursor: 'pointer' }}
                                        >
                                            <div style={{
                                                display: 'inline-flex',
                                                alignItems: 'center',
                                                gap: 6,
                                                padding: '4px 10px',
                                                borderRadius: 6,
                                                border: '1px solid #d1d5db',
                                                background: '#ffffff',
                                                fontSize: 13,
                                                fontWeight: 500,
                                                color: '#374151',
                                                userSelect: 'none',
                                            }}>
                                                {marker.name || String(marker.id)}
                                                <span style={{
                                                    fontWeight: 700,
                                                    color: '#111827',
                                                    fontSize: 13,
                                                }}>
                                                    {marker.stats.total}
                                                </span>
                                            </div>
                                        </div>
                                    ))
                                }
                            </Group>
                        )}
                    </>
                )}
            </Box>

            {/* Country companies popup */}
            {selectedCountry && (
                <CountryCompaniesModal
                    countryName={selectedCountry}
                    onClose={() => setSelectedCountry(null)}
                />
            )}
        </Paper>
    );
}
