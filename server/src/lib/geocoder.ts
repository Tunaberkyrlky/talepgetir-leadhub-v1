import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { createLogger } from './logger.js';

const log = createLogger('geocoder');

type CityIndex = Record<string, [number, number]>;

let _index: CityIndex | null = null;
let _missing = false; // avoid repeated warnings

function loadIndex(): CityIndex {
    if (_index) return _index;
    if (_missing) return {};

    const filePath = path.join(__dirname, '..', 'data', 'citiesIndex.json');
    if (!existsSync(filePath)) {
        _missing = true;
        log.warn('citiesIndex.json not found — run: node server/scripts/buildCitiesIndex.js');
        return {};
    }

    try {
        _index = JSON.parse(readFileSync(filePath, 'utf-8')) as CityIndex;
        log.info({ entries: Object.keys(_index).length }, 'Cities index loaded');
    } catch (err) {
        log.error({ err }, 'Failed to parse citiesIndex.json');
        _index = {};
    }
    return _index;
}

/**
 * Normalize a location string for lookup:
 * lowercase → strip diacritics → keep alphanumeric + spaces → collapse whitespace
 */
function normalize(text: string): string {
    return text
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Country centroids — fallback when city lookup fails (location is a country name)
const COUNTRIES: Record<string, [number, number]> = {
    'afghanistan': [33.9391, 67.7100], 'albania': [41.1533, 20.1683],
    'algeria': [28.0339, 1.6596], 'angola': [-11.2027, 17.8739],
    'argentina': [-38.4161, -63.6167], 'armenia': [40.0691, 45.0382],
    'australia': [-25.2744, 133.7751], 'austria': [47.5162, 14.5501],
    'azerbaijan': [40.1431, 47.5769], 'bahrain': [26.0667, 50.5577],
    'bangladesh': [23.6850, 90.3563], 'belarus': [53.7098, 27.9534],
    'belgium': [50.5039, 4.4699], 'bolivia': [-16.2902, -63.5887],
    'bosnia': [43.9159, 17.6791], 'brazil': [-14.2350, -51.9253],
    'bulgaria': [42.7339, 25.4858], 'cambodia': [12.5657, 104.9910],
    'cameroon': [7.3697, 12.3547], 'canada': [56.1304, -106.3468],
    'chile': [-35.6751, -71.5430], 'china': [35.8617, 104.1954],
    'colombia': [4.5709, -74.2973], 'croatia': [45.1000, 15.2000],
    'czech republic': [49.8175, 15.4730], 'czechia': [49.8175, 15.4730],
    'denmark': [56.2639, 9.5018], 'ecuador': [-1.8312, -78.1834],
    'egypt': [26.8206, 30.8025], 'estonia': [58.5953, 25.0136],
    'ethiopia': [9.1450, 40.4897], 'finland': [61.9241, 25.7482],
    'france': [46.2276, 2.2137], 'georgia': [42.3154, 43.3569],
    'germany': [51.1657, 10.4515], 'ghana': [7.9465, -1.0232],
    'greece': [39.0742, 21.8243], 'hungary': [47.1625, 19.5033],
    'india': [20.5937, 78.9629], 'indonesia': [-0.7893, 113.9213],
    'iran': [32.4279, 53.6880], 'iraq': [33.2232, 43.6793],
    'ireland': [53.4129, -8.2439], 'israel': [31.0461, 34.8516],
    'italy': [41.8719, 12.5674], 'ivory coast': [7.5400, -5.5471],
    'japan': [36.2048, 138.2529], 'jordan': [30.5852, 36.2384],
    'kazakhstan': [48.0196, 66.9237], 'kenya': [-0.0236, 37.9062],
    'kosovo': [42.6026, 20.9020], 'kuwait': [29.3117, 47.4818],
    'latvia': [56.8796, 24.6032], 'lebanon': [33.8547, 35.8623],
    'libya': [26.3351, 17.2283], 'lithuania': [55.1694, 23.8813],
    'luxembourg': [49.8153, 6.1296], 'malaysia': [4.2105, 101.9758],
    'malta': [35.9375, 14.3754], 'mexico': [23.6345, -102.5528],
    'moldova': [47.4116, 28.3699], 'mongolia': [46.8625, 103.8467],
    'montenegro': [42.7087, 19.3744], 'morocco': [31.7917, -7.0926],
    'mozambique': [-18.6657, 35.5296], 'myanmar': [21.9162, 95.9560],
    'netherlands': [52.1326, 5.2913], 'new zealand': [-40.9006, 174.8860],
    'nigeria': [9.0820, 8.6753], 'north korea': [40.3399, 127.5101],
    'north macedonia': [41.6086, 21.7453], 'norway': [60.4720, 8.4689],
    'oman': [21.4735, 55.9754], 'pakistan': [30.3753, 69.3451],
    'palestine': [31.9522, 35.2332], 'peru': [-9.1900, -75.0152],
    'philippines': [12.8797, 121.7740], 'poland': [51.9194, 19.1451],
    'portugal': [39.3999, -8.2245], 'qatar': [25.3548, 51.1839],
    'romania': [45.9432, 24.9668], 'russia': [61.5240, 105.3188],
    'saudi arabia': [23.8859, 45.0792], 'senegal': [14.4974, -14.4524],
    'serbia': [44.0165, 21.0059], 'singapore': [1.3521, 103.8198],
    'slovakia': [48.6690, 19.6990], 'slovenia': [46.1512, 14.9955],
    'south africa': [-30.5595, 22.9375], 'south korea': [35.9078, 127.7669],
    'spain': [40.4637, -3.7492], 'sweden': [60.1282, 18.6435],
    'switzerland': [46.8182, 8.2275], 'syria': [34.8021, 38.9968],
    'taiwan': [23.6978, 120.9605], 'thailand': [15.8700, 100.9925],
    'tunisia': [33.8869, 9.5375], 'turkey': [38.9637, 35.2433],
    'turkiye': [38.9637, 35.2433], 'ukraine': [48.3794, 31.1656],
    'united arab emirates': [23.4241, 53.8478], 'uae': [23.4241, 53.8478],
    'united kingdom': [55.3781, -3.4360], 'uk': [55.3781, -3.4360],
    'united states': [37.0902, -95.7129], 'usa': [37.0902, -95.7129],
    'us': [37.0902, -95.7129], 'uruguay': [-32.5228, -55.7658],
    'uzbekistan': [41.3775, 64.5853], 'venezuela': [6.4238, -66.5897],
    'vietnam': [14.0583, 108.2772], 'yemen': [15.5527, 48.5164],
    'zambia': [-13.1339, 27.8493], 'zimbabwe': [-19.0154, 29.1549],
};

/**
 * Lookup coordinates for a free-text location string.
 *
 * Strategy (in order):
 * 1. Full normalized string  (e.g. "istanbul turkey")
 * 2. Each comma-separated part (e.g. "Istanbul, Turkey" → try "istanbul", "turkey")
 * 3. Progressive prefix reduction (e.g. "New York City" → "new york city" → "new york")
 *
 * Returns null if no match found.
 */
export function lookupCoordinates(location: string): { lat: number; lng: number } | null {
    if (!location?.trim()) return null;

    const index = loadIndex();
    if (!index || Object.keys(index).length === 0) return null;

    const tryKey = (key: string): [number, number] | undefined => index[key];

    const normalized = normalize(location);

    // 1. Full string: country names take priority over same-named cities
    //    e.g. "Albania" → Albania (not a small US town named Albania)
    const exactCountry = COUNTRIES[normalized];
    if (exactCountry) return { lat: exactCountry[0], lng: exactCountry[1] };

    // 2. Exact match on full string in cities index
    const exact = tryKey(normalized);
    if (exact) return { lat: exact[0], lng: exact[1] };

    // 3. Each comma/slash-separated part
    //    Country check first per part, then city — so "Albania, Europe" → Albania
    const parts = normalized.split(/[,\/]/).map((p) => p.trim()).filter(Boolean);
    for (const part of parts) {
        const country = COUNTRIES[part];
        if (country) return { lat: country[0], lng: country[1] };
        const hit = tryKey(part);
        if (hit) return { lat: hit[0], lng: hit[1] };
    }

    // 4. Progressive word-prefix reduction on the first part (cities index only)
    const words = (parts[0] || normalized).split(' ').filter(Boolean);
    for (let len = words.length - 1; len >= 2; len--) {
        const candidate = words.slice(0, len).join(' ');
        const hit = tryKey(candidate);
        if (hit) return { lat: hit[0], lng: hit[1] };
    }

    return null;
}
