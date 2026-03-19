declare module 'react-simple-maps' {
    import { ComponentType, ReactNode, CSSProperties } from 'react';

    interface ComposableMapProps {
        projection?: string;
        projectionConfig?: {
            scale?: number;
            center?: [number, number];
            rotate?: [number, number, number];
        };
        width?: number;
        height?: number;
        style?: CSSProperties;
        children?: ReactNode;
    }

    interface ZoomableGroupProps {
        center?: [number, number];
        zoom?: number;
        minZoom?: number;
        maxZoom?: number;
        translateExtent?: [[number, number], [number, number]];
        onMoveStart?: (event: any) => void;
        onMove?: (event: any) => void;
        onMoveEnd?: (event: any) => void;
        children?: ReactNode;
    }

    interface GeographiesProps {
        geography: any;
        children: (data: { geographies: any[] }) => ReactNode;
    }

    interface GeographyStyleProps {
        default?: CSSProperties;
        hover?: CSSProperties;
        pressed?: CSSProperties;
    }

    interface GeographyProps {
        geography: any;
        fill?: string;
        stroke?: string;
        strokeWidth?: number;
        style?: GeographyStyleProps;
        onClick?: (event: any) => void;
        onMouseEnter?: (event: any) => void;
        onMouseLeave?: (event: any) => void;
    }

    interface MarkerProps {
        coordinates: [number, number];
        children?: ReactNode;
        style?: GeographyStyleProps;
        onClick?: (event: any) => void;
        onMouseEnter?: (event: any) => void;
        onMouseLeave?: (event: any) => void;
    }

    export const ComposableMap: ComponentType<ComposableMapProps>;
    export const ZoomableGroup: ComponentType<ZoomableGroupProps>;
    export const Geographies: ComponentType<GeographiesProps>;
    export const Geography: ComponentType<GeographyProps>;
    export const Marker: ComponentType<MarkerProps>;
    export const Graticule: ComponentType<any>;
    export const Line: ComponentType<any>;
    export const Sphere: ComponentType<any>;
    export const Annotation: ComponentType<any>;
}
