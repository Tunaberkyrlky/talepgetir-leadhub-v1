/**
 * Mock çağrı transkripti — şirket/kişi adıyla kişiselleştirilmiş, zaman
 * damgalı, gerçekçi bir cold call diyaloğu üretir. AI özet adımı bu metin
 * üzerinde GERÇEK LLM ile çalışır; yani özet pipeline'ı mock'ta bile canlıdır.
 */

export interface TranscriptSegment {
    speaker: 'agent' | 'lead';
    start_sec: number;
    end_sec: number;
    text: string;
}

interface MockTranscriptInput {
    durationSec: number;
    companyName?: string | null;
    contactName?: string | null;
    toCountry?: string | null;
    announce: boolean;
}

export function generateMockTranscript(input: MockTranscriptInput): { segments: TranscriptSegment[]; language: string } {
    const turkish = input.toCountry === 'TR';
    const company = input.companyName || (turkish ? 'firmanız' : 'your company');
    const contact = input.contactName || (turkish ? 'Bey/Hanım' : 'there');

    const lines: Array<{ speaker: 'agent' | 'lead'; text: string }> = turkish
        ? [
            { speaker: 'agent', text: `Merhaba, ${contact}, ben TG Core'dan arıyorum. ${company} için ihracat alıcıları konusunda kısa bir konu için aramıştım, birkaç dakikanız var mı?` },
            { speaker: 'lead', text: 'Merhaba, buyrun, kısa olursa dinliyorum.' },
            { speaker: 'agent', text: `Teşekkürler. ${company} olarak yurt dışına satış yaptığınızı gördük. Biz hedef pazarlarda doğrulanmış alıcı listeleri ve doğrudan ulaşılabilir karar verici verisi sağlıyoruz.` },
            { speaker: 'lead', text: 'Şu an birkaç pazarda distribütör arıyoruz aslında, hangi ülkelerde veriniz var?' },
            { speaker: 'agent', text: 'Almanya, ABD ve Körfez başta olmak üzere 40\'tan fazla pazarda. Sektörünüze özel bir örnek listeyi yarın e-postayla iletebilirim.' },
            { speaker: 'lead', text: 'Olur, örnek listeyi görmek isterim. Fiyatlandırma nasıl çalışıyor?' },
            { speaker: 'agent', text: 'Aylık paketlerle çalışıyoruz, örnek listeyle birlikte fiyat tablosunu da ekleyeyim. Perşembe günü kısa bir demo görüşmesi ayarlayalım mı?' },
            { speaker: 'lead', text: 'Perşembe öğleden sonra uygun olur.' },
            { speaker: 'agent', text: 'Harika, perşembe 14:00 için davet gönderiyorum. Vakit ayırdığınız için teşekkürler, iyi günler.' },
            { speaker: 'lead', text: 'Teşekkürler, görüşmek üzere.' },
        ]
        : [
            { speaker: 'agent', text: `Hi ${contact}, this is TG Core calling. I'm reaching out to ${company} about sourcing from Turkish manufacturers — do you have two minutes?` },
            { speaker: 'lead', text: "Hi, sure, if it's quick." },
            { speaker: 'agent', text: `Thanks. We work with vetted Turkish exporters and I noticed ${company} imports in this category. We can connect you directly with factory-level suppliers at better unit costs.` },
            { speaker: 'lead', text: 'We already have suppliers, but lead times have been a problem lately, to be honest.' },
            { speaker: 'agent', text: 'That is exactly what we hear. Our partner factories typically quote 3 to 4 week lead times to Europe. Would it help if I sent a shortlist with references and pricing?' },
            { speaker: 'lead', text: 'You can send it over, and include minimum order quantities please.' },
            { speaker: 'agent', text: 'Will do. Could we also book a 15 minute call on Thursday to walk through the shortlist together?' },
            { speaker: 'lead', text: 'Thursday afternoon works for me.' },
            { speaker: 'agent', text: 'Perfect, I will send an invite for Thursday 2 PM your time. Thanks for your time, have a great day.' },
            { speaker: 'lead', text: 'Thanks, bye.' },
        ];

    if (input.announce) {
        lines.unshift({
            speaker: 'agent',
            text: turkish
                ? 'Bu görüşme hizmet kalitesi için kaydedilmektedir.'
                : 'This call may be recorded for quality purposes.',
        });
    }

    // Zaman damgalarını süreye orantılı dağıt (segment payı metin uzunluğuna göre)
    const totalChars = lines.reduce((s, l) => s + l.text.length, 0);
    const usable = Math.max(10, input.durationSec - 1);
    let cursor = 0.5;
    const segments: TranscriptSegment[] = lines.map((l) => {
        const span = Math.max(1.2, (l.text.length / totalChars) * usable);
        const seg = { speaker: l.speaker, start_sec: Math.round(cursor * 10) / 10, end_sec: Math.round((cursor + span) * 10) / 10, text: l.text };
        cursor += span + 0.3;
        return seg;
    });

    return { segments, language: turkish ? 'tr' : 'en' };
}
