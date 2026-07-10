/**
 * Giden HTML mailin text/plain alternatifi.
 *
 * Bağımlılıksız, en-iyi-çaba HTML → düz metin dönüştürücü. `htmlText.ts`'teki
 * `htmlToPlainText`'ten AYRIDIR ve onun yerini almaz: bu sürüm giden mailin
 * düz-metin part'ı için link'leri "metin (url)" biçiminde KORUR (özellikle
 * abonelikten-çıkma linki düz metinde tıklanır URL olarak görünmeli) ve
 * <style>/<script> bloklarını metne sızdırmaz. `htmlToPlainText` ise inbound
 * mail normalizasyonu ve istatistik export'unda kullanılıyor; oradaki davranışı
 * (link metnini sadeleştirme) bozmamak için burada ayrı tutulur. HTML entity
 * çözümü ortak (`decodeHtmlEntities`).
 *
 * Not: takip pixel'i bir <img> olduğundan metin üretmez (yalnız HTML part'ta
 * kalır); footer'daki abonelikten-çıkma <a> linki ise URL olarak düz metne düşer.
 */

import { decodeHtmlEntities } from '../htmlText.js';

export function htmlToPlainTextBody(html: string | null | undefined): string {
    if (!html) return '';

    let s = html.replace(/\r\n/g, '\n');

    // <style>/<script> içerikleri metin değildir → CSS/JS metne sızmasın diye tamamen at.
    s = s
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');

    // Link'leri "metin (url)" olarak koru. Görünen metin URL ile aynıysa ya da
    // metin boşsa yalnız URL'i bırak; http(s) dışı hedeflerde (mailto/tel/anchor)
    // yalnız metni bırak. Entity çözümü sondaki tek geçişe bırakılır (href'teki
    // &amp; → & orada çözülür).
    s = s.replace(
        /<a\b[^>]*\bhref\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
        (_m: string, href: string, inner: string) => {
            const text = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
            const url = href.trim();
            if (!/^https?:\/\//i.test(url)) return text || url;
            if (!text || text === url) return ` ${url} `;
            return `${text} (${url})`;
        },
    );

    // Blok/satır-sonu etiketleri → yeni satır (hem açılış hem kapanış: <p>, </p>, <div …>
    // vb. — böylece footer ve paragraflar düz metinde ayrık kalır). \b yerine "isim ardından
    // > veya boşluk" koşulu <pre>/<link>/<track>/<divider> gibi etiketleri dışarıda tutar.
    // Kalan tüm etiketler (tracking pixel <img> dahil) atılır.
    s = s
        .replace(/<\s*br\s*\/?>/gi, '\n')
        .replace(/<\/?(?:p|div|tr|li|h[1-6])(?:\s[^>]*)?>/gi, '\n')
        .replace(/<[^>]+>/g, '');

    return decodeHtmlEntities(s)
        .replace(/[ \t]{2,}/g, ' ')   // ardışık boşluk/tab → tek boşluk
        .replace(/ *\n */g, '\n')     // satır sonlarına yapışan boşlukları kırp
        .replace(/\n{3,}/g, '\n\n')   // en fazla bir boş satır
        .trim();
}
