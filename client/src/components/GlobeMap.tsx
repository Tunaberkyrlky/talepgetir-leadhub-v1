import { useRef, useEffect, useCallback, useState } from 'react';
import { Paper, Text, Loader, Center, Box } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import Globe from 'react-globe.gl';
import { stageColors } from '../lib/stages';

// Mantine color name → hex (matches palette used across the app)
const MANTINE_HEX: Record<string, string> = {
    gray:   '#868e96',
    blue:   '#339af0',
    cyan:   '#22b8cf',
    indigo: '#5c7cfa',
    teal:   '#20c997',
    yellow: '#fcc419',
    orange: '#ff922b',
    violet: '#9c36b5',
    grape:  '#cc5de8',
    green:  '#51cf66',
    red:    '#ff6b6b',
};

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

export default function GlobeMap({ data, isLoading }: GlobeMapProps) {
    const { t } = useTranslation();
    const globeRef = useRef<any>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [dimensions, setDimensions] = useState({ width: 600, height: 420 });

    // Responsive sizing based on container width
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

    // Slow auto-rotation after data is ready
    useEffect(() => {
        if (!globeRef.current || data.length === 0) return;
        const controls = globeRef.current.controls();
        controls.autoRotate = true;
        controls.autoRotateSpeed = 0.3;
        controls.enableDamping = true;
    }, [data]);

    const getPointColor = useCallback((point: object) => {
        const p = point as CompanyLocation;
        const colorName = stageColors[p.stage as keyof typeof stageColors] || 'gray';
        return MANTINE_HEX[colorName] || MANTINE_HEX.gray;
    }, []);

    const getLabel = useCallback((point: object) => {
        const p = point as CompanyLocation;
        return `<div style="background:rgba(0,0,0,0.72);color:#fff;padding:6px 10px;border-radius:6px;font-size:12px;font-family:sans-serif;pointer-events:none;white-space:nowrap"><strong>${p.name}</strong>${p.location ? `<br/>${p.location}` : ''}</div>`;
    }, []);

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
                ) : data.length === 0 ? (
                    <Center style={{ height: 160 }}>
                        <Text c="dimmed" size="sm" ta="center" maw={380}>
                            {t('dashboard.noLocations')}
                        </Text>
                    </Center>
                ) : (
                    <Globe
                        ref={globeRef}
                        width={dimensions.width}
                        height={dimensions.height}
                        globeImageUrl="//unpkg.com/three-globe/example/img/earth-blue-marble.jpg"
                        backgroundColor="rgba(0,0,0,0)"
                        atmosphereColor="lightskyblue"
                        atmosphereAltitude={0.1}
                        pointsData={data}
                        pointLat="latitude"
                        pointLng="longitude"
                        pointColor={getPointColor}
                        pointRadius={0.4}
                        pointAltitude={0.02}
                        pointLabel={getLabel}
                    />
                )}
            </Box>
        </Paper>
    );
}
