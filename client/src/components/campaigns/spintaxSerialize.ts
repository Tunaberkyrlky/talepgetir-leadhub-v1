// Spintax serialization — editörde pill (node), kayıtta düz metin.
//
// body_html backend için kanonik `{{random|A|B|C}}` METNİ olarak tutulur (motor onu
// regex'le çözüyor). Editöre yüklerken bu metni <span data-spintax="A|B|C"> elementine
// çevirip node'a parse ettiriyoruz; kaydederken tersini yapıyoruz. DOM kullandığımız
// için HTML kaçışları (& " < gibi) otomatik ve doğru ele alınır.

// Backend ile aynı desen — seçenekler tek seviye değişken ({{first_name}}) içerebilir.
const SPINTAX_RE = /\{\{\s*random\s*\|((?:[^{}]|\{\{[^{}]*\}\})*)\}\}/gi;

// Metindeki {{random|...}} bloklarını <span data-spintax> elementlerine çevirir (yükleme).
export function spintaxTextToHtml(html: string): string {
    if (!html || !/\{\{\s*random/i.test(html)) return html;
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) textNodes.push(n as Text);

    for (const tn of textNodes) {
        const text = tn.nodeValue || '';
        SPINTAX_RE.lastIndex = 0;
        if (!SPINTAX_RE.test(text)) continue;
        SPINTAX_RE.lastIndex = 0;

        const frag = doc.createDocumentFragment();
        let last = 0;
        let m: RegExpExecArray | null;
        while ((m = SPINTAX_RE.exec(text)) !== null) {
            if (m.index > last) frag.appendChild(doc.createTextNode(text.slice(last, m.index)));
            const span = doc.createElement('span');
            span.setAttribute('data-spintax', m[1]); // ham, pipe ile ayrılmış seçenekler
            frag.appendChild(span);
            last = m.index + m[0].length;
        }
        if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
        tn.parentNode?.replaceChild(frag, tn);
    }
    return doc.body.innerHTML;
}

// Konu (düz metin) → tek paragraflı ProseMirror doc; {{random|...}} blokları spintax
// node'una çevrilir. Konu editörü pill gösterebilsin diye kullanılır.
export function subjectToDoc(text: string): Record<string, unknown> {
    const content: Array<Record<string, unknown>> = [];
    if (text) {
        SPINTAX_RE.lastIndex = 0;
        let last = 0;
        let m: RegExpExecArray | null;
        while ((m = SPINTAX_RE.exec(text)) !== null) {
            if (m.index > last) content.push({ type: 'text', text: text.slice(last, m.index) });
            content.push({ type: 'spintax', attrs: { options: m[1].split('|') } });
            last = m.index + m[0].length;
        }
        if (last < text.length) content.push({ type: 'text', text: text.slice(last) });
    }
    return { type: 'doc', content: [{ type: 'paragraph', content }] };
}

// <span data-spintax="A|B|C"> elementlerini {{random|A|B|C}} metnine çevirir (kayıt).
export function spintaxHtmlToText(html: string): string {
    if (!html || !html.includes('data-spintax')) return html;
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    doc.querySelectorAll('span[data-spintax]').forEach((el) => {
        const opts = el.getAttribute('data-spintax') || '';
        el.replaceWith(doc.createTextNode(`{{random|${opts}}}`));
    });
    return doc.body.innerHTML;
}
