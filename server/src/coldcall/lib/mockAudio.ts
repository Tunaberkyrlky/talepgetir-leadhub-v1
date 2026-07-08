/**
 * Mock çağrı için stereo WAV üretimi — dual-channel kayıt demosu:
 * sol kanal = agent (440 Hz), sağ kanal = lead (330 Hz). Segment zamanlarıyla
 * hizalı ton patlamaları; player ve pipeline uçtan uca gerçek dosyayla test edilir.
 */

const SAMPLE_RATE = 8000;

export interface AudioSegmentSpec {
    speaker: 'agent' | 'lead';
    start_sec: number;
    end_sec: number;
}

export function generateStereoWav(durationSec: number, segments: AudioSegmentSpec[]): Buffer {
    const dur = Math.max(1, Math.min(durationSec, 120)); // dosya boyutu tavanı
    const frames = SAMPLE_RATE * dur;
    const dataSize = frames * 2 /*ch*/ * 2 /*16-bit*/;
    const buf = Buffer.alloc(44 + dataSize);

    // WAV header (PCM, stereo, 16-bit)
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + dataSize, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);            // PCM
    buf.writeUInt16LE(2, 22);            // stereo
    buf.writeUInt32LE(SAMPLE_RATE, 24);
    buf.writeUInt32LE(SAMPLE_RATE * 4, 28); // byte rate
    buf.writeUInt16LE(4, 32);            // block align
    buf.writeUInt16LE(16, 34);           // bits/sample
    buf.write('data', 36);
    buf.writeUInt32LE(dataSize, 40);

    const FREQ = { agent: 440, lead: 330 } as const;
    const AMP = 6000;

    for (const seg of segments) {
        const from = Math.max(0, Math.floor(seg.start_sec * SAMPLE_RATE));
        const to = Math.min(frames, Math.ceil(seg.end_sec * SAMPLE_RATE));
        const freq = FREQ[seg.speaker];
        const chOffset = seg.speaker === 'agent' ? 0 : 2; // L | R
        for (let i = from; i < to; i++) {
            // Kenarlarda fade — klik sesini önler
            const rel = (i - from) / Math.max(1, to - from);
            const fade = Math.min(1, rel * 10, (1 - rel) * 10);
            const sample = Math.round(Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE) * AMP * fade);
            buf.writeInt16LE(sample, 44 + i * 4 + chOffset);
        }
    }
    return buf;
}
