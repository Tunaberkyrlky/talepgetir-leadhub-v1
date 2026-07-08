/**
 * AI özet — transkript üzerinden özet + aksiyon maddeleri + duygu çıkarımı.
 * DeepSeek (OpenAI-uyumlu) doğrudan çağrılır; research modülünün LLM router'ına
 * bilinçli olarak BAĞIMLI DEĞİLİZ (modül izolasyonu). LLM erişilemezse
 * heuristik fallback devreye girer — özet adımı çağrıyı asla bloklamaz.
 */
import { createLogger } from '../../lib/logger.js';
import type { TranscriptSegment } from './mockTranscript.js';

const log = createLogger('coldcall:summarize');

const BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const MODEL = process.env.COLDCALL_SUMMARY_MODEL || 'deepseek-v4-pro';
const TIMEOUT_MS = 30_000;

export interface CallSummary {
    summary: string;
    action_items: string[];
    sentiment: 'positive' | 'neutral' | 'negative';
    provider: string;
}

export async function summarizeTranscript(segments: TranscriptSegment[], language: string): Promise<CallSummary> {
    const text = segments.map((s) => `${s.speaker === 'agent' ? 'AGENT' : 'LEAD'}: ${s.text}`).join('\n');
    const apiKey = process.env.DEEPSEEK_KEY;
    if (apiKey) {
        try {
            return await llmSummarize(text, language, apiKey);
        } catch (err) {
            log.warn({ reason: (err as Error).message }, 'LLM summary failed — falling back to heuristic');
        }
    } else {
        log.warn('DEEPSEEK_KEY not set — using heuristic summary');
    }
    return heuristicSummary(segments, language);
}

async function llmSummarize(text: string, language: string, apiKey: string): Promise<CallSummary> {
    const sys =
        'You summarize B2B cold call transcripts. Respond with ONLY a JSON object: ' +
        '{"summary": string (2-3 sentences), "action_items": string[] (0-5 concrete follow-ups), ' +
        '"sentiment": "positive"|"neutral"|"negative" (the LEAD\'s attitude)}. ' +
        `Write summary and action_items in ${language === 'tr' ? 'Turkish' : 'English'}.`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(`${BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: MODEL,
                messages: [
                    { role: 'system', content: sys },
                    { role: 'user', content: text.slice(0, 24_000) },
                ],
                response_format: { type: 'json_object' },
                temperature: 0.2,
                // Reasoning model: düşünme tokenleri de bu limitten yer — final JSON
                // için bol pay bırakılmalı (600 iken içerik boş dönüyordu).
                max_tokens: 2400,
            }),
            signal: controller.signal,
        });
        if (!res.ok) throw new Error(`deepseek http ${res.status}`);
        const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const raw = (body.choices?.[0]?.message?.content ?? '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
        if (!raw) throw new Error('empty LLM content (max_tokens exhausted by reasoning?)');
        const parsed = JSON.parse(raw) as Partial<CallSummary>;
        if (!parsed.summary || typeof parsed.summary !== 'string') throw new Error('missing summary in LLM output');
        const sentiment = (['positive', 'neutral', 'negative'] as const).includes(parsed.sentiment as never)
            ? (parsed.sentiment as CallSummary['sentiment'])
            : 'neutral';
        return {
            summary: parsed.summary.slice(0, 2000),
            action_items: Array.isArray(parsed.action_items)
                ? parsed.action_items.filter((a): a is string => typeof a === 'string').slice(0, 5).map((a) => a.slice(0, 500))
                : [],
            sentiment,
            provider: `deepseek:${MODEL}`,
        };
    } finally {
        clearTimeout(timer);
    }
}

function heuristicSummary(segments: TranscriptSegment[], language: string): CallSummary {
    const leadLines = segments.filter((s) => s.speaker === 'lead').length;
    const answered = leadLines > 0;
    const tr = language === 'tr';
    return {
        summary: answered
            ? tr
                ? `Görüşme gerçekleşti; karşı taraf ${leadLines} kez yanıt verdi. Ayrıntı için transkripte bakın.`
                : `Call connected; the lead responded ${leadLines} times. See transcript for details.`
            : tr
                ? 'Görüşme kurulamadı veya karşı taraf konuşmadı.'
                : 'Call did not connect or the lead did not speak.',
        action_items: [],
        sentiment: 'neutral',
        provider: 'heuristic',
    };
}
