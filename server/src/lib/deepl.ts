/**
 * DeepL Free API wrapper for user-triggered translations.
 * Uses native fetch (Node 18+) — no extra dependencies.
 * Env: DEEPL_API_KEY
 */
import { createLogger } from './logger.js';

const log = createLogger('deepl');

const DEEPL_URL = 'https://api-free.deepl.com/v2/translate';
const TARGET_LANG = 'TR';

/**
 * Translate multiple text fields in a single DeepL API call.
 * Returns a map of field -> translated text.
 */
export async function translateTexts(
    texts: Array<{ field: string; text: string }>,
): Promise<Record<string, string>> {
    const apiKey = process.env.DEEPL_API_KEY;
    if (!apiKey) {
        throw new Error('DEEPL_API_KEY environment variable is not set');
    }

    // Filter out empty/short texts
    const valid = texts.filter((t) => t.text && t.text.trim().length >= 2);
    if (valid.length === 0) return {};

    // Build form body — DeepL accepts multiple 'text' params
    const params = new URLSearchParams();
    for (const { text } of valid) {
        params.append('text', text);
    }
    params.append('target_lang', TARGET_LANG);

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        const res = await fetch(DEEPL_URL, {
            method: 'POST',
            headers: {
                Authorization: `DeepL-Auth-Key ${apiKey}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: params.toString(),
            signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!res.ok) {
            const body = await res.text();
            log.error({ status: res.status, body }, 'DeepL API error');
            throw new Error(`DeepL API returned ${res.status}`);
        }

        const data = (await res.json()) as { translations: Array<{ text: string; detected_source_language: string }> };

        const result: Record<string, string> = {};
        for (let i = 0; i < valid.length; i++) {
            const translated = data.translations[i]?.text;
            if (translated && translated.trim().toLowerCase() !== valid[i].text.trim().toLowerCase()) {
                result[valid[i].field] = translated;
            }
        }

        log.info({ fields: valid.length, translated: Object.keys(result).length }, 'Translation complete');
        return result;
    } catch (err) {
        log.error({ err }, 'DeepL translation failed');
        throw err;
    }
}
