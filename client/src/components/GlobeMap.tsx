import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { Paper, Text, Loader, Center, Box, ActionIcon } from '@mantine/core';
import { IconMaximize, IconMinimize } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ComposableMap, Geographies, Geography, Marker, ZoomableGroup } from 'react-simple-maps';
import * as topojson from 'topojson-client';
import topoData from 'world-atlas/countries-110m.json';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import centroid from '@turf/centroid';
import { COUNTRY_NAMES } from '../lib/countryNames';

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

interface GlobeMapProps {
    data: CompanyLocation[];
    isLoading?: boolean;
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

export default function GlobeMap({ data, isLoading }: GlobeMapProps) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const containerRef = useRef<HTMLDivElement>(null);
    const [dimensions, setDimensions] = useState({ width: 600, height: 420 });
    const [hoveredMarker, setHoveredMarker] = useState<CountryMarker | null>(null);
    const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
    const [zoom, setZoom] = useState(1);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const mapContainerRef = useRef<HTMLDivElement>(null);

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
                setDimensions({ width: w, height: Math.min(420, Math.max(280, Math.floor(w * 0.55))) });
            }
        });
        observer.observe(containerRef.current);
        return () => observer.disconnect();
    }, []);

    // Filter out cold companies
    const activeData = useMemo(() => data.filter(c => c.stage !== 'cold'), [data]);

    // Pre-compute: country feature id → stage group counts + centroid
    const { countryCompanyCounts, countryMarkers } = useMemo(() => {
        const countMap = new Map<number, CountryStats>();
        if (!activeData.length) return { countryCompanyCounts: countMap, countryMarkers: [] };

        const pt = (lng: number, lat: number) => ({
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: [lng, lat] },
            properties: {},
        });

        for (const company of activeData) {
            const point = pt(company.longitude, company.latitude);
            for (const feature of GEO_FEATURES) {
                if (booleanPointInPolygon(point, feature as any)) {
                    const id = Number(feature.id);
                    const cur = countMap.get(id) ?? { total: 0, ilkTemas: 0, kalifikasyon: 0, degerlendirme: 0, karar: 0 };
                    cur.total += 1;
                    if ((STAGE_GROUPS.ilkTemas as readonly string[]).includes(company.stage))      cur.ilkTemas += 1;
                    else if ((STAGE_GROUPS.kalifikasyon as readonly string[]).includes(company.stage))  cur.kalifikasyon += 1;
                    else if ((STAGE_GROUPS.degerlendirme as readonly string[]).includes(company.stage)) cur.degerlendirme += 1;
                    else if ((STAGE_GROUPS.karar as readonly string[]).includes(company.stage))    cur.karar += 1;
                    countMap.set(id, cur);
                    break;
                }
            }
        }

        // Build marker list from country centroids
        const markers: CountryMarker[] = [];
        for (const feature of GEO_FEATURES) {
            const id = Number(feature.id);
            const stats = countMap.get(id);
            if (!stats) continue;
            try {
                const c = centroid(feature as any);
                const [lng, lat] = c.geometry.coordinates;
                const name = COUNTRY_NAMES[id] ?? '';
                markers.push({ id, name, lat, lng, stats });
            } catch {
                // skip unparseable geometry
            }
        }

        // Sort ascending so highest count renders last (on top in SVG)
        markers.sort((a, b) => a.stats.total - b.stats.total);

        return { countryCompanyCounts: countMap, countryMarkers: markers };
    }, [activeData]);

    const getCountryFill = useCallback((geo: any) => {
        const stats = countryCompanyCounts.get(Number(geo.id));
        const count = stats?.total ?? 0;
        if (count === 0) return 'rgba(22, 58, 105, 0.95)';
        const intensity = Math.min(1, 0.3 + count * 0.07);
        return `rgba(80, 140, 220, ${intensity})`;
    }, [countryCompanyCounts]);

    const handleCountryClick = useCallback((geo: any) => {
        const id = Number(geo.id);
        const stats = countryCompanyCounts.get(id);
        if (!stats || stats.total === 0) return;
        const name = COUNTRY_NAMES[id];
        if (name) navigate(`/companies?search=${encodeURIComponent(name)}&fromMap=true`);
    }, [countryCompanyCounts, navigate]);

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
            <Text size="sm" fw={700} mb="xs" tt="uppercase" c="dimmed" style={{ letterSpacing: '0.5px' }}>
                {t('dashboard.companyLocations')}
            </Text>

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
                                background: '#0d1b2a',
                                borderRadius: isFullscreen ? 0 : 12,
                                overflow: 'hidden',
                                position: 'relative',
                            }}
                        >
                            <ActionIcon
                                variant="subtle"
                                color="gray"
                                size="md"
                                onClick={toggleFullscreen}
                                style={{
                                    position: 'absolute',
                                    top: 10,
                                    right: 10,
                                    zIndex: 10,
                                    background: 'rgba(10, 20, 40, 0.7)',
                                    border: '1px solid rgba(100, 160, 255, 0.3)',
                                    color: '#7eb8ff',
                                }}
                                title={isFullscreen ? t('common.exitFullscreen') : t('common.fullscreen')}
                            >
                                {isFullscreen ? <IconMinimize size={16} /> : <IconMaximize size={16} />}
                            </ActionIcon>
                            <ComposableMap
                                projection="geoNaturalEarth1"
                                projectionConfig={{ scale: 140, center: [20, 15] }}
                                width={800}
                                height={440}
                                style={{ width: '100%', height: isFullscreen ? '100vh' : 'auto', display: 'block' }}
                            >
                                <ZoomableGroup
                                    minZoom={1}
                                    maxZoom={8}
                                    onMove={({ zoom: z }: { zoom: number }) => setZoom(z)}
                                >
                                    <Geographies geography={topoData as any}>
                                        {({ geographies }) =>
                                            geographies.map((geo) => {
                                                const fill = getCountryFill(geo);
                                                const id = Number(geo.id);
                                                const hasCompanies = (countryCompanyCounts.get(id)?.total ?? 0) > 0;
                                                return (
                                                    <Geography
                                                        key={geo.rsmKey}
                                                        geography={geo}
                                                        fill={fill}
                                                        stroke="rgba(115, 170, 230, 0.7)"
                                                        strokeWidth={0.4}
                                                        onClick={() => handleCountryClick(geo)}
                                                        style={{
                                                            default: { outline: 'none' },
                                                            hover: {
                                                                fill: hasCompanies ? '#5a9fd4' : fill,
                                                                outline: 'none',
                                                                cursor: hasCompanies ? 'pointer' : 'default',
                                                            },
                                                            pressed: { outline: 'none' },
                                                        }}
                                                    />
                                                );
                                            })
                                        }
                                    </Geographies>

                                    {countryMarkers.map((marker) => (
                                        <Marker
                                            key={marker.id}
                                            coordinates={[marker.lng, marker.lat]}
                                        >
                                            <g
                                                style={{ cursor: 'pointer' }}
                                                transform={`scale(${1 / zoom})`}
                                                onMouseEnter={(e) => handleMarkerHover(marker, e)}
                                                onMouseMove={handleMarkerMove}
                                                onMouseLeave={() => handleMarkerHover(null)}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    if (marker.name) {
                                                        navigate(`/companies?search=${encodeURIComponent(marker.name)}&fromMap=true`);
                                                    }
                                                }}
                                            >
                                                <rect
                                                    x={-22}
                                                    y={-10}
                                                    width={44}
                                                    height={20}
                                                    rx={10}
                                                    fill="rgba(10, 20, 40, 0.88)"
                                                    stroke="rgba(100, 160, 255, 0.5)"
                                                    strokeWidth={1}
                                                />
                                                {/* Building icon */}
                                                <g transform="translate(-14, -6) scale(0.5)" fill="none" stroke="#7eb8ff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                    <path d="M3 21h18" />
                                                    <path d="M5 21V7l8-4v18" />
                                                    <path d="M19 21V11l-6-4" />
                                                    <path d="M9 9v.01" />
                                                    <path d="M9 12v.01" />
                                                    <path d="M9 15v.01" />
                                                    <path d="M9 18v.01" />
                                                </g>
                                                <text
                                                    x={6}
                                                    y={4}
                                                    textAnchor="middle"
                                                    fill="#e8f0ff"
                                                    fontSize={11}
                                                    fontWeight={600}
                                                    fontFamily="sans-serif"
                                                >
                                                    {marker.stats.total}
                                                </text>
                                            </g>
                                        </Marker>
                                    ))}
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
                                    background: 'rgba(0, 0, 0, 0.88)',
                                    color: '#fff',
                                    padding: '9px 13px',
                                    borderRadius: 8,
                                    fontSize: 12,
                                    fontFamily: 'sans-serif',
                                    whiteSpace: 'nowrap',
                                    lineHeight: 1.75,
                                    pointerEvents: 'none',
                                    boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
                                    border: '1px solid rgba(100,160,255,0.25)',
                                    zIndex: 99999,
                                    transform: 'translateY(-50%)',
                                }}
                            >
                                <div style={{ fontSize: 14, fontWeight: 700, color: '#7eb8ff', marginBottom: 6, paddingBottom: 5, borderBottom: '1px solid rgba(100,160,255,0.2)' }}>
                                    {hoveredMarker.name || String(hoveredMarker.id)}
                                </div>
                                <div style={{ color: '#adb5bd', marginBottom: 5 }}>
                                    {t('dashboard.totalCompanies')}: <strong style={{ color: '#fff' }}>{hoveredMarker.stats.total}</strong> {t('dashboard.companies').toLowerCase()}
                                </div>
                                <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', margin: '4px 0 6px' }} />
                                {STAGE_COLORS.map(({ key, color, labelKey }) => (
                                    <div key={key} style={{ display: 'flex', alignItems: 'center' }}>
                                        <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: color, marginRight: 6, flexShrink: 0 }} />
                                        <span style={{ color: '#cdd5e0' }}>
                                            {t(labelKey)}: <strong style={{ color: '#fff' }}>{hoveredMarker.stats[key]}</strong> {t('dashboard.companies').toLowerCase()}
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
                    </>
                )}
            </Box>
        </Paper>
    );
}
