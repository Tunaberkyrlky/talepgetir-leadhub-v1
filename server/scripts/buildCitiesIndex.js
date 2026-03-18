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

    // tempIndex: normalizedName → { lat, lng, population }
    // When the same normalized name appears multiple times, keep highest population.
    const tempIndex = new Map();

    for (const line of lines) {
        if (!line.trim()) continue;
        const cols = line.split('\t');
        if (cols.length < 15) continue;

        const name       = cols[1];   // unicode name
        const asciiname  = cols[2];   // ascii transliteration
        const altnames   = cols[3];   // comma-separated alternate names
        const lat        = parseFloat(cols[4]);
        const lng        = parseFloat(cols[5]);
        const population = parseInt(cols[14], 10) || 0;

        if (isNaN(lat) || isNaN(lng)) continue;

        // Index all name variants: official + ascii + alternates
        const candidates = [name, asciiname, ...altnames.split(',')].filter(Boolean);

        for (const c of candidates) {
            const key = normalize(c);
            if (!key || key.length < 2) continue;
            const existing = tempIndex.get(key);
            if (!existing || population > existing.population) {
                tempIndex.set(key, { lat, lng, population });
            }
        }
    }

    // Build compact output: { name: [lat, lng], ... }
    const index = {};
    for (const [key, val] of tempIndex) {
        index[key] = [val.lat, val.lng];
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
