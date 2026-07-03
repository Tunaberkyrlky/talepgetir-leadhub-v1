/**
 * Discovery junk filter (engine, Y1+). SearXNG returns real company sites mixed with social
 * networks, search engines, encyclopedias, news, and B2B aggregators/directories. None of those
 * are a single buyer FIRM, so they must be dropped before a result URL becomes a candidate
 * (otherwise we'd fetch+validate+bill a directory as if it were a company).
 *
 * Operates on the registrable domain (eTLD+1 from canonical.normalizeDomain), so a subdomain
 * like m.facebook.com or careers.indiamart.com is caught by its parent.
 */

// Registrable domains that are never a buyer firm. Kept flat + lowercase for O(1) lookup.
const JUNK_DOMAINS = new Set<string>([
    // search / infra
    'google.com', 'bing.com', 'yahoo.com', 'duckduckgo.com', 'yandex.com', 'yandex.ru', 'baidu.com',
    'ecosia.org', 'startpage.com', 'brave.com',
    // social / UGC
    'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'linkedin.com', 'youtube.com',
    'tiktok.com', 'pinterest.com', 'reddit.com', 'medium.com', 'tumblr.com', 'vk.com', 'ok.ru',
    't.me', 'telegram.org', 'whatsapp.com', 'quora.com', 'threads.net', 'snapchat.com',
    // encyclopedic / reference / news
    'wikipedia.org', 'wikimedia.org', 'wikidata.org', 'fandom.com', 'britannica.com',
    'bbc.com', 'bbc.co.uk', 'cnn.com', 'forbes.com', 'bloomberg.com', 'reuters.com',
    'nytimes.com', 'theguardian.com', 'ft.com', 'wsj.com',
    // dev / docs / misc platforms
    'github.com', 'github.io', 'gitlab.com', 'stackoverflow.com', 'slideshare.net',
    'scribd.com', 'issuu.com', 'archive.org', 'blogspot.com', 'wordpress.com', 'wixsite.com',
    'apple.com', 'microsoft.com', 'amazonaws.com', 'cloudflare.com',
    // marketplaces / retail
    'amazon.com', 'ebay.com', 'aliexpress.com', 'alibaba.com', 'etsy.com', 'walmart.com',
    // B2B aggregators / directories / lead-databases (NOT the firm itself)
    'made-in-china.com', 'indiamart.com', 'tradeindia.com', 'exportersindia.com', 'tradekey.com',
    'ec21.com', 'go4worldbusiness.com', 'exporthub.com', 'globalsources.com', 'europages.com',
    'europages.co.uk', 'kompass.com', 'yellowpages.com', 'yelp.com', 'glassdoor.com',
    'crunchbase.com', 'dnb.com', 'zoominfo.com', 'thomasnet.com', 'manta.com', 'bbb.org',
    'panjiva.com', 'importgenius.com', 'volza.com', 'seair.co.in', 'trademap.org',
    'trademo.com', 'fibre2fashion.com', 'ensun.io', 'esources.co.uk', 'esources.com',
    'textileinfomedia.com', 'textile-network.com', 'apparelsearch.com', 'garmentbuyingagents.com',
    'connect2india.com', 'eworldtrade.com', 'b2brazil.com', 'businesslist.io', 'cybo.com',
]);

// Institutional / non-commercial suffixes: gov/edu/mil/int are gTLDs (bare or with a ccTLD, e.g.
// gov.uk). "ac" is academic ONLY as ac.<cctld> (ac.uk, ac.jp) — bare ".ac" is Ascension Island's
// commercial ccTLD, so it must NOT be dropped.
const JUNK_SUFFIX_RE = /(^|\.)(gov|edu|mil|int)(\.[a-z]{2,})?$|\.ac\.[a-z]{2,}$/;

/** True when this registrable domain is not a candidate buyer firm and should be skipped. */
export function isJunkDomain(registrableDomain: string | null | undefined): boolean {
    if (!registrableDomain) return true;
    const d = registrableDomain.toLowerCase();
    if (JUNK_DOMAINS.has(d)) return true;
    if (JUNK_SUFFIX_RE.test(d)) return true;
    return false;
}
