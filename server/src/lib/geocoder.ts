import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { createLogger } from './logger.js';

const log = createLogger('geocoder');

// Each name maps to an array of candidate entries (sorted by population desc).
// Tuple is [lat, lng] or [lat, lng, country]. Multiple entries enable disambiguation
// like "Katy, Texas, USA" — without the country preference we'd pick the most populous
// Katy worldwide (Mali); with it we find Katy in the USA.
type CityEntry = [number, number] | [number, number, string];
type CityIndex = Record<string, CityEntry[]>;

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

// Country centroids — fallback when city lookup fails (location is a country name).
// Tuple is [lat, lng, canonicalName]; canonicalName must match client COUNTRY_NAMES
// so that polygon-derived and geocoder-derived country strings stay identical.
type CountryEntry = [number, number, string];

const COUNTRIES: Record<string, CountryEntry> = {
    'afghanistan': [33.9391, 67.7100, 'Afghanistan'], 'albania': [41.1533, 20.1683, 'Albania'],
    'algeria': [28.0339, 1.6596, 'Algeria'], 'angola': [-11.2027, 17.8739, 'Angola'],
    'argentina': [-38.4161, -63.6167, 'Argentina'], 'armenia': [40.0691, 45.0382, 'Armenia'],
    'australia': [-25.2744, 133.7751, 'Australia'], 'austria': [47.5162, 14.5501, 'Austria'],
    'azerbaijan': [40.1431, 47.5769, 'Azerbaijan'], 'bahrain': [26.0667, 50.5577, 'Bahrain'],
    'bangladesh': [23.6850, 90.3563, 'Bangladesh'], 'belarus': [53.7098, 27.9534, 'Belarus'],
    'belgium': [50.5039, 4.4699, 'Belgium'], 'bolivia': [-16.2902, -63.5887, 'Bolivia'],
    'bosnia': [43.9159, 17.6791, 'Bosnia and Herzegovina'], 'brazil': [-14.2350, -51.9253, 'Brazil'],
    'bulgaria': [42.7339, 25.4858, 'Bulgaria'], 'cambodia': [12.5657, 104.9910, 'Cambodia'],
    'cameroon': [7.3697, 12.3547, 'Cameroon'], 'canada': [56.1304, -106.3468, 'Canada'],
    'chile': [-35.6751, -71.5430, 'Chile'], 'china': [35.8617, 104.1954, 'China'],
    'colombia': [4.5709, -74.2973, 'Colombia'], 'croatia': [45.1000, 15.2000, 'Croatia'],
    'czech republic': [49.8175, 15.4730, 'Czechia'], 'czechia': [49.8175, 15.4730, 'Czechia'],
    'denmark': [56.2639, 9.5018, 'Denmark'], 'ecuador': [-1.8312, -78.1834, 'Ecuador'],
    'egypt': [26.8206, 30.8025, 'Egypt'], 'estonia': [58.5953, 25.0136, 'Estonia'],
    'ethiopia': [9.1450, 40.4897, 'Ethiopia'], 'finland': [61.9241, 25.7482, 'Finland'],
    'france': [46.2276, 2.2137, 'France'], 'georgia': [42.3154, 43.3569, 'Georgia'],
    'germany': [51.1657, 10.4515, 'Germany'], 'ghana': [7.9465, -1.0232, 'Ghana'],
    'greece': [39.0742, 21.8243, 'Greece'], 'hungary': [47.1625, 19.5033, 'Hungary'],
    'india': [20.5937, 78.9629, 'India'], 'indonesia': [-0.7893, 113.9213, 'Indonesia'],
    'iran': [32.4279, 53.6880, 'Iran'], 'iraq': [33.2232, 43.6793, 'Iraq'],
    'ireland': [53.4129, -8.2439, 'Ireland'], 'israel': [31.0461, 34.8516, 'Israel'],
    'italy': [41.8719, 12.5674, 'Italy'], 'ivory coast': [7.5400, -5.5471, 'Ivory Coast'],
    'japan': [36.2048, 138.2529, 'Japan'], 'jordan': [30.5852, 36.2384, 'Jordan'],
    'kazakhstan': [48.0196, 66.9237, 'Kazakhstan'], 'kenya': [-0.0236, 37.9062, 'Kenya'],
    'kosovo': [42.6026, 20.9020, 'Kosovo'], 'kuwait': [29.3117, 47.4818, 'Kuwait'],
    'latvia': [56.8796, 24.6032, 'Latvia'], 'lebanon': [33.8547, 35.8623, 'Lebanon'],
    'libya': [26.3351, 17.2283, 'Libya'], 'lithuania': [55.1694, 23.8813, 'Lithuania'],
    'luxembourg': [49.8153, 6.1296, 'Luxembourg'], 'malaysia': [4.2105, 101.9758, 'Malaysia'],
    'malta': [35.9375, 14.3754, 'Malta'], 'mexico': [23.6345, -102.5528, 'Mexico'],
    'moldova': [47.4116, 28.3699, 'Moldova'], 'mongolia': [46.8625, 103.8467, 'Mongolia'],
    'montenegro': [42.7087, 19.3744, 'Montenegro'], 'morocco': [31.7917, -7.0926, 'Morocco'],
    'mozambique': [-18.6657, 35.5296, 'Mozambique'], 'myanmar': [21.9162, 95.9560, 'Myanmar'],
    'netherlands': [52.1326, 5.2913, 'Netherlands'], 'new zealand': [-40.9006, 174.8860, 'New Zealand'],
    'nigeria': [9.0820, 8.6753, 'Nigeria'], 'north korea': [40.3399, 127.5101, 'North Korea'],
    'north macedonia': [41.6086, 21.7453, 'North Macedonia'], 'norway': [60.4720, 8.4689, 'Norway'],
    'oman': [21.4735, 55.9754, 'Oman'], 'pakistan': [30.3753, 69.3451, 'Pakistan'],
    'palestine': [31.9522, 35.2332, 'Palestine'], 'peru': [-9.1900, -75.0152, 'Peru'],
    'philippines': [12.8797, 121.7740, 'Philippines'], 'poland': [51.9194, 19.1451, 'Poland'],
    'portugal': [39.3999, -8.2245, 'Portugal'], 'qatar': [25.3548, 51.1839, 'Qatar'],
    'romania': [45.9432, 24.9668, 'Romania'], 'russia': [61.5240, 105.3188, 'Russia'],
    'saudi arabia': [23.8859, 45.0792, 'Saudi Arabia'], 'senegal': [14.4974, -14.4524, 'Senegal'],
    'serbia': [44.0165, 21.0059, 'Serbia'], 'singapore': [1.3521, 103.8198, 'Singapore'],
    'slovakia': [48.6690, 19.6990, 'Slovakia'], 'slovenia': [46.1512, 14.9955, 'Slovenia'],
    'south africa': [-30.5595, 22.9375, 'South Africa'], 'south korea': [35.9078, 127.7669, 'South Korea'],
    'spain': [40.4637, -3.7492, 'Spain'], 'sweden': [60.1282, 18.6435, 'Sweden'],
    'switzerland': [46.8182, 8.2275, 'Switzerland'], 'syria': [34.8021, 38.9968, 'Syria'],
    'taiwan': [23.6978, 120.9605, 'Taiwan'], 'thailand': [15.8700, 100.9925, 'Thailand'],
    'tunisia': [33.8869, 9.5375, 'Tunisia'], 'turkey': [38.9637, 35.2433, 'Turkey'],
    'turkiye': [38.9637, 35.2433, 'Turkey'], 'ukraine': [48.3794, 31.1656, 'Ukraine'],
    'united arab emirates': [23.4241, 53.8478, 'United Arab Emirates'], 'uae': [23.4241, 53.8478, 'United Arab Emirates'],
    'united kingdom': [55.3781, -3.4360, 'United Kingdom'], 'uk': [55.3781, -3.4360, 'United Kingdom'],
    'united states': [37.0902, -95.7129, 'United States'], 'usa': [37.0902, -95.7129, 'United States'],
    'us': [37.0902, -95.7129, 'United States'], 'uruguay': [-32.5228, -55.7658, 'Uruguay'],
    'uzbekistan': [41.3775, 64.5853, 'Uzbekistan'], 'venezuela': [6.4238, -66.5897, 'Venezuela'],
    'vietnam': [14.0583, 108.2772, 'Vietnam'], 'yemen': [15.5527, 48.5164, 'Yemen'],
    'zambia': [-13.1339, 27.8493, 'Zambia'], 'zimbabwe': [-19.0154, 29.1549, 'Zimbabwe'],
    'iceland': [64.9631, -19.0208, 'Iceland'],
    'cyprus': [35.1264, 33.4299, 'Cyprus'],
    'liechtenstein': [47.1660, 9.5554, 'Liechtenstein'],
    'bosnia and herzegovina': [43.9159, 17.6791, 'Bosnia and Herzegovina'],
    'makedonya': [41.6086, 21.7453, 'North Macedonia'], // Turkish: North Macedonia
    'kuzey makedonya': [41.6086, 21.7453, 'North Macedonia'],
};

export interface GeocodeResult {
    lat: number;
    lng: number;
    country: string | null;
}

/**
 * Lookup coordinates and country for a free-text location string.
 *
 * Strategy:
 * 1. If the full string is itself a country name → return that country.
 *    (Keeps "Albania" → Albania, not a small US town named Albania.)
 * 2. Detect a "preferred country" by scanning comma-separated parts for any
 *    COUNTRIES key. This biases subsequent city lookups toward that country.
 * 3. Try to find a city — full string, each part, then sub-words of the first
 *    part (for "Greater X", "X Metropolitan Area" patterns). Whenever multiple
 *    cities share a normalized name, prefer the one in the detected country.
 * 4. If no city is found but a country was detected, fall back to that country
 *    centroid so at least the country column gets filled.
 *
 * Returns null if nothing matches.
 */
export function lookupCoordinates(location: string): GeocodeResult | null {
    if (!location?.trim()) return null;

    const index = loadIndex();
    if (!index || Object.keys(index).length === 0) return null;

    const fromCity = (entry: CityEntry): GeocodeResult => ({
        lat: entry[0],
        lng: entry[1],
        country: entry.length === 3 ? entry[2] : null,
    });
    const fromCountry = (entry: CountryEntry): GeocodeResult => ({
        lat: entry[0], lng: entry[1], country: entry[2],
    });
    const pickCity = (entries: CityEntry[] | undefined, preferred: string | null): CityEntry | undefined => {
        if (!entries || entries.length === 0) return undefined;
        if (preferred) {
            const match = entries.find((e) => e.length === 3 && e[2] === preferred);
            if (match) return match;
        }
        return entries[0]; // sorted by population desc at build time
    };

    // Split by comma/slash BEFORE normalizing (normalize strips commas)
    const rawParts = location.split(/[,\/]/).map((p) => p.trim()).filter(Boolean);
    const normalizedParts = rawParts.map(normalize).filter(Boolean);
    const normalized = normalizedParts.join(' ');

    // 1. Full string country match — "Albania" / "Türkiye" / "USA"
    const exactCountry = COUNTRIES[normalized];
    if (exactCountry) return fromCountry(exactCountry);

    // 2. Detect a preferred country from any part
    let preferredCountry: string | null = null;
    let preferredCountryEntry: CountryEntry | null = null;
    for (const p of normalizedParts) {
        const c = COUNTRIES[p];
        if (c) {
            preferredCountry = c[2];
            preferredCountryEntry = c;
            break;
        }
    }

    // 3a. Full string as a city (country-aware)
    const exactCity = pickCity(index[normalized], preferredCountry);
    if (exactCity) return fromCity(exactCity);

    // 3b. Each part as a city (country-aware)
    for (const part of normalizedParts) {
        const hit = pickCity(index[part], preferredCountry);
        if (hit) return fromCity(hit);
    }

    // 3c. Sub-words of the first part — handles "Greater Indianapolis" → "indianapolis",
    //     "Dayton Metropolitan Area" → "dayton". Try multi-word prefixes first (more
    //     specific), then individual words >= 3 chars.
    const words = (normalizedParts[0] || normalized).split(' ').filter(Boolean);
    if (words.length > 1) {
        for (let len = words.length - 1; len >= 2; len--) {
            const candidate = words.slice(0, len).join(' ');
            const hit = pickCity(index[candidate], preferredCountry);
            if (hit) return fromCity(hit);
        }
        for (const w of words) {
            if (w.length < 3) continue;
            const hit = pickCity(index[w], preferredCountry);
            if (hit) return fromCity(hit);
        }
    }

    // 4. Country centroid fallback when we detected one but no city resolved
    if (preferredCountryEntry) return fromCountry(preferredCountryEntry);

    return null;
}
