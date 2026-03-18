import { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import { Paper, Text, Loader, Center, Box } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import Globe, { type GlobeMethods } from 'react-globe.gl';
import * as topojson from 'topojson-client';
import topoData from 'world-atlas/countries-110m.json';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import centroid from '@turf/centroid';
import { COUNTRY_NAMES } from '../lib/countryNames';

// Solid dark navy texture for oceans (no photo, just flat color)
const OCEAN_TEXTURE = (() => {
    const canvas = document.createElement('canvas');
    canvas.width = 2; canvas.height = 2;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#0d1b2a';
    ctx.fillRect(0, 0, 2, 2);
    return canvas.toDataURL();
})();

// Building SVG icon (Tabler IconBuilding inline)
const BUILDING_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M5 21V7l8-4v18"/><path d="M19 21V11l-6-4"/><path d="M9 9v.01"/><path d="M9 12v.01"/><path d="M9 15v.01"/><path d="M9 18v.01"/></svg>`;
// Arrow right icon for navigation pointer
const ARROW_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>`;

// Bundled country polygons — computed once at module load, no runtime fetch needed
const GEO_FEATURES: object[] = (
    topojson.feature(
        topoData as Parameters<typeof topojson.feature>[0],
        (topoData as any).objects.countries
    ) as { features: object[] }
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

export default function GlobeMap({ data, isLoading }: GlobeMapProps) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const globeRef = useRef<GlobeMethods | undefined>(undefined);
    const containerRef = useRef<HTMLDivElement>(null);
    const [dimensions, setDimensions] = useState({ width: 600, height: 420 });

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

    // Cleanup any lingering tooltips when component unmounts (e.g. on navigation)
    useEffect(() => {
        return () => {
            document.querySelectorAll('[data-globe-tip]').forEach(el => el.remove());
        };
    }, []);

    // Auto-rotation on mount; pause while user interacts, resume on release
    useEffect(() => {
        if (!globeRef.current) return;
        globeRef.current.pointOfView({ altitude: 1.4 });
        const controls = globeRef.current.controls();
        controls.autoRotate = true;
        controls.autoRotateSpeed = 0.3;
        controls.enableDamping = true;

        const pause  = () => { controls.autoRotate = false; };
        const resume = () => { controls.autoRotate = true; };
        controls.addEventListener('start', pause);
        controls.addEventListener('end',   resume);
        return () => {
            controls.removeEventListener('start', pause);
            controls.removeEventListener('end',   resume);
        };
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
                    const id = feature.id as number;
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
            const stats = countMap.get(feature.id as number) ?? countMap.get(id);
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

        return { countryCompanyCounts: countMap, countryMarkers: markers };
    }, [activeData]);


    const getPolygonCapColor = useCallback((feature: object) => {
        const f = feature as any;
        const stats = countryCompanyCounts.get(f.id as number);
        const count = stats?.total ?? 0;
        if (count === 0) return 'rgba(22, 58, 105, 0.95)';
        const intensity = Math.min(1, 0.3 + count * 0.07);
        return `rgba(80, 140, 220, ${intensity})`;
    }, [countryCompanyCounts]);

    // Build HTML marker element for each country with hover tooltip
    const getHtmlElement = useCallback((d: object) => {
        const marker = d as CountryMarker;
        const { name, stats } = marker;

        const el = document.createElement('div');
        el.style.cssText = 'cursor:pointer;user-select:none;pointer-events:auto';
        el.innerHTML = `
            <div style="
                display:flex;align-items:center;gap:5px;
                background:rgba(10,20,40,0.88);
                border:1.5px solid rgba(100,160,255,0.5);
                color:#e8f0ff;
                padding:4px 8px;
                border-radius:20px;
                font-size:11px;
                font-family:sans-serif;
                font-weight:600;
                white-space:nowrap;
                box-shadow:0 2px 8px rgba(0,0,0,0.5);
                backdrop-filter:blur(4px);
                transition:border-color 0.15s,background 0.15s;
            ">
                <span style="color:#7eb8ff;display:flex;align-items:center">${BUILDING_SVG}</span>
                <span>${stats.total}</span>
                <span class="globe-nav-btn" style="
                    display:flex;align-items:center;
                    margin-left:2px;
                    color:#7eb8ff;
                    opacity:0.7;
                    transition:opacity 0.15s,color 0.15s;
                ">${ARROW_SVG}</span>
            </div>
        `;

        const pill = el.firstElementChild as HTMLElement;

        // Tooltip appended to body to bypass globe's overflow:hidden
        let tip: HTMLDivElement | null = null;

        const showTip = (mx: number, my: number) => {
            if (tip) return;
            tip = document.createElement('div');
            tip.setAttribute('data-globe-tip', '');
            tip.style.cssText = `
                position:fixed;
                top:${my - 12}px;
                left:${mx + 14}px;
                background:rgba(0,0,0,0.88);
                color:#fff;
                padding:9px 13px;
                border-radius:8px;
                font-size:12px;
                font-family:sans-serif;
                white-space:nowrap;
                line-height:1.75;
                pointer-events:none;
                box-shadow:0 4px 16px rgba(0,0,0,0.6);
                border:1px solid rgba(100,160,255,0.25);
                z-index:99999;
                transform:translateY(-50%);
            `;
            const dot = (color: string) =>
                `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${color};margin-right:6px;flex-shrink:0"></span>`;
            const row = (color: string, label: string, count: number) =>
                `<div style="display:flex;align-items:center">${dot(color)}<span style="color:#cdd5e0">${label}: <strong style="color:#fff">${count}</strong> ${t('dashboard.companies').toLowerCase()}</span></div>`;

            tip.innerHTML = `
                <div style="font-size:14px;font-weight:700;color:#7eb8ff;margin-bottom:6px;padding-bottom:5px;border-bottom:1px solid rgba(100,160,255,0.2)">${name || String(marker.id)}</div>
                <div style="color:#adb5bd;margin-bottom:5px">${t('dashboard.totalCompanies')}: <strong style="color:#fff">${stats.total}</strong> ${t('dashboard.companies').toLowerCase()}</div>
                <div style="border-top:1px solid rgba(255,255,255,0.08);margin:4px 0 6px"></div>
                ${row('#339af0', t('stageGroups.firstContact'), stats.ilkTemas)}
                ${row('#ff922b', t('stageGroups.qualification'), stats.kalifikasyon)}
                ${row('#cc5de8', t('stageGroups.evaluation'), stats.degerlendirme)}
                ${row('#51cf66', t('stageGroups.closing'), stats.karar)}
            `;
            document.body.appendChild(tip);
        };

        const hideTip = () => {
            tip?.remove();
            tip = null;
        };

        const navBtn = el.querySelector('.globe-nav-btn') as HTMLElement | null;

        el.addEventListener('mouseenter', (e: MouseEvent) => {
            pill.style.borderColor = 'rgba(100,160,255,0.9)';
            pill.style.background = 'rgba(20,40,80,0.95)';
            if (navBtn) { navBtn.style.opacity = '1'; navBtn.style.color = '#a8d4ff'; }
            showTip(e.clientX, e.clientY);
        });

        el.addEventListener('mousemove', (e: MouseEvent) => {
            if (tip) {
                tip.style.top = `${e.clientY - 12}px`;
                tip.style.left = `${e.clientX + 14}px`;
            }
        });

        el.addEventListener('mouseleave', () => {
            pill.style.borderColor = 'rgba(100,160,255,0.5)';
            pill.style.background = 'rgba(10,20,40,0.88)';
            if (navBtn) { navBtn.style.opacity = '0.7'; navBtn.style.color = '#7eb8ff'; }
            hideTip();
        });

        el.addEventListener('click', (e: MouseEvent) => {
            e.stopPropagation();
            hideTip();
            if (!name) return;
            navigate(`/companies?search=${encodeURIComponent(name)}&fromMap=true`);
        });

        return el;
    }, [t, navigate]);

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
                        <Globe
                            ref={globeRef}
                            width={dimensions.width}
                            height={dimensions.height}
                            globeImageUrl={OCEAN_TEXTURE}
                            backgroundColor="rgba(0,0,0,0)"
                            atmosphereColor="rgba(100,160,230,0.5)"
                            atmosphereAltitude={0.12}
                            polygonsData={GEO_FEATURES}
                            polygonCapColor={getPolygonCapColor}
                            polygonSideColor={() => 'rgba(0,0,0,0)'}
                            polygonStrokeColor={() => 'rgba(115,170,230,0.7)'}
                            polygonAltitude={0.005}
                            htmlElementsData={countryMarkers}
                            htmlLat="lat"
                            htmlLng="lng"
                            htmlAltitude={0.02}
                            htmlElement={getHtmlElement}
                        />
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
