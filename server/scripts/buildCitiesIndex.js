#!/usr/bin/env node
/**
 * Builds a city → [lat, lng] lookup index from GeoNames data.
 *
 * Run once from the server directory:
 *   node scripts/buildCitiesIndex.js
 *
 * Output: src/data/citiesIndex.json (~3-4MB, covers ~140k cities)
 *
 * Requires: curl + unzip (available on macOS/Linux by default)
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { execSync } = require('child_process');

const DOWNLOAD_URL = 'https://download.geonames.org/export/dump/cities1000.zip';
const TMP_ZIP      = '/tmp/geonames_cities1000.zip';
const TMP_TXT      = '/tmp/cities1000.txt';
const OUTPUT_DIR   = path.join(__dirname, '../src/data');
const OUTPUT_FILE  = path.join(OUTPUT_DIR, 'citiesIndex.json');

// ---------------------------------------------------------------------------
// ISO2 country code → canonical English name
// Names must match client/src/lib/countryNames.ts (COUNTRY_NAMES) so that the
// globe map's polygon-derived country name and the geocoder-derived country
// name use identical strings (filtering is exact-match on this string).
// ---------------------------------------------------------------------------
const ISO2_TO_NAME = {
    AF: 'Afghanistan', AL: 'Albania', DZ: 'Algeria', AS: 'American Samoa',
    AD: 'Andorra', AO: 'Angola', AI: 'Anguilla', AQ: 'Antarctica',
    AG: 'Antigua and Barbuda', AR: 'Argentina', AM: 'Armenia', AW: 'Aruba',
    AU: 'Australia', AT: 'Austria', AZ: 'Azerbaijan', BS: 'Bahamas',
    BH: 'Bahrain', BD: 'Bangladesh', BB: 'Barbados', BY: 'Belarus',
    BE: 'Belgium', BZ: 'Belize', BJ: 'Benin', BM: 'Bermuda',
    BT: 'Bhutan', BO: 'Bolivia', BA: 'Bosnia and Herzegovina', BW: 'Botswana',
    BR: 'Brazil', IO: 'British Indian Ocean Territory', VG: 'British Virgin Islands',
    BN: 'Brunei', BG: 'Bulgaria', BF: 'Burkina Faso', BI: 'Burundi',
    KH: 'Cambodia', CM: 'Cameroon', CA: 'Canada', CV: 'Cape Verde',
    KY: 'Cayman Islands', CF: 'Central African Republic', TD: 'Chad', CL: 'Chile',
    CN: 'China', CX: 'Christmas Island', CC: 'Cocos Islands', CO: 'Colombia',
    KM: 'Comoros', CK: 'Cook Islands', CR: 'Costa Rica', HR: 'Croatia',
    CU: 'Cuba', CW: 'Curaçao', CY: 'Cyprus', CZ: 'Czechia',
    CD: 'DR Congo', DK: 'Denmark', DJ: 'Djibouti', DM: 'Dominica',
    DO: 'Dominican Republic', EC: 'Ecuador', EG: 'Egypt', SV: 'El Salvador',
    GQ: 'Equatorial Guinea', ER: 'Eritrea', EE: 'Estonia', SZ: 'Eswatini',
    ET: 'Ethiopia', FK: 'Falkland Islands', FO: 'Faroe Islands', FJ: 'Fiji',
    FI: 'Finland', FR: 'France', GF: 'French Guiana', PF: 'French Polynesia',
    GA: 'Gabon', GM: 'Gambia', GE: 'Georgia', DE: 'Germany',
    GH: 'Ghana', GI: 'Gibraltar', GR: 'Greece', GL: 'Greenland',
    GD: 'Grenada', GP: 'Guadeloupe', GU: 'Guam', GT: 'Guatemala',
    GG: 'Guernsey', GN: 'Guinea', GW: 'Guinea-Bissau', GY: 'Guyana',
    HT: 'Haiti', HN: 'Honduras', HK: 'Hong Kong', HU: 'Hungary',
    IS: 'Iceland', IN: 'India', ID: 'Indonesia', IR: 'Iran',
    IQ: 'Iraq', IE: 'Ireland', IM: 'Isle of Man', IL: 'Israel',
    IT: 'Italy', CI: 'Ivory Coast', JM: 'Jamaica', JP: 'Japan',
    JE: 'Jersey', JO: 'Jordan', KZ: 'Kazakhstan', KE: 'Kenya',
    KI: 'Kiribati', XK: 'Kosovo', KW: 'Kuwait', KG: 'Kyrgyzstan',
    LA: 'Laos', LV: 'Latvia', LB: 'Lebanon', LS: 'Lesotho',
    LR: 'Liberia', LY: 'Libya', LI: 'Liechtenstein', LT: 'Lithuania',
    LU: 'Luxembourg', MO: 'Macao', MG: 'Madagascar', MW: 'Malawi',
    MY: 'Malaysia', MV: 'Maldives', ML: 'Mali', MT: 'Malta',
    MH: 'Marshall Islands', MQ: 'Martinique', MR: 'Mauritania', MU: 'Mauritius',
    YT: 'Mayotte', MX: 'Mexico', FM: 'Micronesia', MD: 'Moldova',
    MC: 'Monaco', MN: 'Mongolia', ME: 'Montenegro', MS: 'Montserrat',
    MA: 'Morocco', MZ: 'Mozambique', MM: 'Myanmar', NA: 'Namibia',
    NR: 'Nauru', NP: 'Nepal', NL: 'Netherlands', NC: 'New Caledonia',
    NZ: 'New Zealand', NI: 'Nicaragua', NE: 'Niger', NG: 'Nigeria',
    NU: 'Niue', NF: 'Norfolk Island', KP: 'North Korea', MK: 'North Macedonia',
    MP: 'Northern Mariana Islands', NO: 'Norway', OM: 'Oman', PK: 'Pakistan',
    PW: 'Palau', PS: 'Palestine', PA: 'Panama', PG: 'Papua New Guinea',
    PY: 'Paraguay', PE: 'Peru', PH: 'Philippines', PN: 'Pitcairn',
    PL: 'Poland', PT: 'Portugal', PR: 'Puerto Rico', QA: 'Qatar',
    CG: 'Republic of the Congo', RE: 'Réunion', RO: 'Romania', RU: 'Russia',
    RW: 'Rwanda', BL: 'Saint Barthélemy', SH: 'Saint Helena', KN: 'Saint Kitts and Nevis',
    LC: 'Saint Lucia', MF: 'Saint Martin', PM: 'Saint Pierre and Miquelon',
    VC: 'Saint Vincent and the Grenadines', WS: 'Samoa', SM: 'San Marino',
    ST: 'São Tomé and Príncipe', SA: 'Saudi Arabia', SN: 'Senegal', RS: 'Serbia',
    SC: 'Seychelles', SL: 'Sierra Leone', SG: 'Singapore', SX: 'Sint Maarten',
    SK: 'Slovakia', SI: 'Slovenia', SB: 'Solomon Islands', SO: 'Somalia',
    ZA: 'South Africa', GS: 'South Georgia', KR: 'South Korea', SS: 'South Sudan',
    ES: 'Spain', LK: 'Sri Lanka', SD: 'Sudan', SR: 'Suriname',
    SJ: 'Svalbard and Jan Mayen', SE: 'Sweden', CH: 'Switzerland', SY: 'Syria',
    TW: 'Taiwan', TJ: 'Tajikistan', TZ: 'Tanzania', TH: 'Thailand',
    TL: 'Timor-Leste', TG: 'Togo', TK: 'Tokelau', TO: 'Tonga',
    TT: 'Trinidad and Tobago', TN: 'Tunisia', TR: 'Turkey', TM: 'Turkmenistan',
    TC: 'Turks and Caicos Islands', TV: 'Tuvalu', UG: 'Uganda', UA: 'Ukraine',
    AE: 'United Arab Emirates', GB: 'United Kingdom', US: 'United States',
    UY: 'Uruguay', UZ: 'Uzbekistan', VU: 'Vanuatu', VA: 'Vatican City',
    VE: 'Venezuela', VN: 'Vietnam', VI: 'U.S. Virgin Islands', WF: 'Wallis and Futuna',
    EH: 'Western Sahara', YE: 'Yemen', ZM: 'Zambia', ZW: 'Zimbabwe',
};

// ---------------------------------------------------------------------------
// Normalize a city name for case/diacritic-insensitive lookup
// ---------------------------------------------------------------------------
function normalize(text) {
    return text
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // strip diacritics (ı→i, ö→o, etc.)
        .replace(/[^a-z0-9\s]/g, ' ')    // non-alphanum → space
        .replace(/\s+/g, ' ')
        .trim();
}

// ---------------------------------------------------------------------------
// Download helper (follows redirects)
// ---------------------------------------------------------------------------
function download(url, dest) {
    return new Promise((resolve, reject) => {
        const proto = url.startsWith('https') ? https : http;
        const file  = fs.createWriteStream(dest);
        proto.get(url, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                file.close();
                download(res.headers.location, dest).then(resolve).catch(reject);
                return;
            }
            res.pipe(file);
            file.on('finish', () => file.close(resolve));
        }).on('error', (err) => {
            fs.unlink(dest, () => {});
            reject(err);
        });
    });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    console.log('⬇️  Downloading GeoNames cities1000.zip (~7MB)...');
    await download(DOWNLOAD_URL, TMP_ZIP);
    console.log('    Downloaded:', TMP_ZIP);

    console.log('📦  Extracting...');
    execSync(`unzip -o "${TMP_ZIP}" cities1000.txt -d /tmp/`);

    console.log('🔍  Parsing city data...');
    const raw   = fs.readFileSync(TMP_TXT, 'utf-8');
    const lines = raw.split('\n');

    // tempIndex: normalizedName → { lat, lng, country, population }
    // When the same normalized name appears multiple times, keep highest population.
    const tempIndex = new Map();
    let unknownCountryCount = 0;

    for (const line of lines) {
        if (!line.trim()) continue;
        const cols = line.split('\t');
        if (cols.length < 15) continue;

        const name        = cols[1];   // unicode name
        const asciiname   = cols[2];   // ascii transliteration
        const altnames    = cols[3];   // comma-separated alternate names
        const lat         = parseFloat(cols[4]);
        const lng         = parseFloat(cols[5]);
        const countryCode = (cols[8] || '').toUpperCase(); // ISO2
        const population  = parseInt(cols[14], 10) || 0;

        if (isNaN(lat) || isNaN(lng)) continue;

        const country = ISO2_TO_NAME[countryCode] || null;
        if (!country) unknownCountryCount++;

        // Index all name variants: official + ascii + alternates
        const candidates = [name, asciiname, ...altnames.split(',')].filter(Boolean);

        for (const c of candidates) {
            const key = normalize(c);
            if (!key || key.length < 2) continue;
            const existing = tempIndex.get(key);
            if (!existing || population > existing.population) {
                tempIndex.set(key, { lat, lng, country, population });
            }
        }
    }

    // Build compact output: { name: [lat, lng, "Country"], ... }
    // Country is omitted (entry length 2) when ISO2 code is unknown.
    const index = {};
    for (const [key, val] of tempIndex) {
        index[key] = val.country ? [val.lat, val.lng, val.country] : [val.lat, val.lng];
    }
    if (unknownCountryCount > 0) {
        console.log(`ℹ️   ${unknownCountryCount} rows had unknown ISO2 — country left null`);
    }

    const json = JSON.stringify(index);
    fs.writeFileSync(OUTPUT_FILE, json);

    const sizeMB = (Buffer.byteLength(json) / 1024 / 1024).toFixed(1);
    console.log(`✅  Done! ${Object.keys(index).length.toLocaleString()} entries → ${OUTPUT_FILE} (${sizeMB}MB)`);

    // Cleanup
    fs.unlinkSync(TMP_ZIP);
    fs.unlinkSync(TMP_TXT);
}

main().catch((err) => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
