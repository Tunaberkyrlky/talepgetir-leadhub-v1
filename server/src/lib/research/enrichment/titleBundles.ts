/**
 * Title bundles — curated, multilingual keyword sets for contact-enrichment ranking.
 *
 * The customer picks buckets in priority order ("founder first, then purchasing");
 * each bucket ships ready-made query words across the languages our target
 * geographies actually use (EN/DE/FR/ES/IT/NL/PL/TR), so "purchasing" matches
 * Einkäufer in Germany and Satın Alma in Türkiye without the customer writing
 * keyword lists. Matching is normalized substring containment over the contact's
 * position/title — deterministic, no LLM.
 */

export interface TitleBucket {
    code: string;
    label: { tr: string; en: string };
    keywords: string[];
}

export const TITLE_BUCKETS: readonly TitleBucket[] = [
    {
        code: 'founder_exec',
        label: { tr: 'Kurucu / Üst Yönetim', en: 'Founder / Executive' },
        keywords: [
            // NOTE: no bare 'president' — substring matching would swallow 'VICE president of X'
            // titles that belong to their functional bucket (live-smoke finding).
            'founder', 'co-founder', 'cofounder', 'ceo', 'chief executive', 'owner',
            'managing director', 'general manager', 'managing partner',
            'geschäftsführer', 'gründer', 'inhaber', 'mitinhaber', 'eigentümer', 'vorstand',
            'kurucu', 'genel müdür', 'yönetim kurulu',
            'fondateur', 'cofondateur', 'pdg', 'gérant', 'directeur général',
            'fundador', 'propietario', 'director general', 'gerente general', 'consejero delegado',
            'amministratore delegato', 'fondatore', 'titolare', 'direttore generale',
            'oprichter', 'eigenaar', 'algemeen directeur', 'directeur',
            'założyciel', 'właściciel', 'prezes', 'dyrektor generalny', 'dyrektor zarządzający',
        ],
    },
    {
        code: 'purchasing',
        label: { tr: 'Satın Alma / Tedarik', en: 'Purchasing / Procurement' },
        keywords: [
            'purchasing', 'procurement', 'buyer', 'buying', 'sourcing', 'supply chain',
            'category manager', 'supply manager', 'materials manager',
            'einkauf', 'einkäufer', 'einkaufsleiter', 'beschaffung', 'strategischer einkauf', 'disposition',
            'satın alma', 'satınalma', 'tedarik', 'tedarik zinciri',
            'achats', 'acheteur', 'responsable achats', 'directeur achats', 'approvisionnement',
            'compras', 'jefe de compras', 'director de compras', 'aprovisionamiento',
            'acquisti', 'responsabile acquisti', 'ufficio acquisti', 'approvvigionamento',
            'inkoop', 'inkoper', 'inkoopmanager',
            'zakupy', 'zaopatrzenie', 'kierownik zakupów', 'specjalista ds. zakupów',
        ],
    },
    {
        code: 'sales',
        label: { tr: 'Satış / İş Geliştirme / İhracat', en: 'Sales / Business Development / Export' },
        keywords: [
            'sales', 'business development', 'account manager', 'account executive', 'export',
            'commercial director', 'head of sales', 'key account',
            'vertrieb', 'vertriebsleiter', 'verkauf', 'verkaufsleiter', 'außendienst', 'export manager',
            'satış', 'ihracat', 'dış ticaret', 'iş geliştirme',
            'ventes', 'commercial', 'directeur commercial', 'responsable commercial',
            'ventas', 'comercial', 'director comercial', 'desarrollo de negocio', 'exportación',
            'vendite', 'commerciale', 'direttore commerciale', 'sviluppo commerciale',
            'verkoop', 'verkoopmanager', 'business developer',
            'sprzedaż', 'handlowiec', 'dyrektor sprzedaży', 'eksport',
        ],
    },
    {
        code: 'marketing',
        label: { tr: 'Pazarlama', en: 'Marketing' },
        keywords: [
            'marketing', 'brand', 'growth', 'communications', 'cmo', 'digital marketing',
            'marketingleiter', 'kommunikation', 'werbung',
            'pazarlama', 'marka', 'kurumsal iletişim',
            'responsable marketing', 'directeur marketing', 'communication',
            'mercadeo', 'comunicación', 'director de marketing',
            'comunicazione', 'responsabile marketing',
            'marketingmanager', 'marketing communicatie',
            'dyrektor marketingu',
        ],
    },
    {
        code: 'operations',
        label: { tr: 'Operasyon / Üretim', en: 'Operations / Production' },
        keywords: [
            'operations', 'coo', 'plant manager', 'production', 'manufacturing', 'factory manager',
            'betriebsleiter', 'produktionsleiter', 'werksleiter', 'fertigungsleiter', 'produktion',
            'operasyon', 'üretim', 'fabrika müdürü', 'işletme müdürü',
            'directeur des opérations', 'responsable de production', 'directeur d’usine', 'production',
            'operaciones', 'producción', 'jefe de planta', 'director de operaciones',
            'operativo', 'produzione', 'direttore di stabilimento', 'responsabile produzione',
            'operationeel', 'productie', 'productiemanager', 'bedrijfsleider',
            'operacje', 'produkcja', 'kierownik produkcji', 'dyrektor operacyjny',
        ],
    },
    {
        code: 'technical',
        label: { tr: 'Teknik / Mühendislik / Ar-Ge', en: 'Technical / Engineering / R&D' },
        keywords: [
            'engineering', 'engineer', 'cto', 'technical', 'technology', 'r&d', 'research and development',
            'product development',
            'entwicklung', 'technik', 'technischer leiter', 'konstruktion', 'ingenieur', 'entwicklungsleiter',
            'teknik', 'ar-ge', 'mühendis', 'ürün geliştirme',
            'ingénieur', 'technique', 'directeur technique', 'bureau d’études',
            'ingeniería', 'ingeniero', 'técnico', 'director técnico', 'desarrollo',
            'ingegneria', 'ingegnere', 'tecnico', 'direttore tecnico', 'ricerca e sviluppo',
            'techniek', 'technisch directeur', 'ingenieur', 'ontwikkeling',
            'inżynier', 'techniczny', 'dyrektor techniczny', 'badania i rozwój',
        ],
    },
    {
        code: 'quality',
        label: { tr: 'Kalite', en: 'Quality' },
        keywords: [
            'quality', 'qa ', 'qc ', 'quality assurance', 'quality control', 'quality manager', 'qhse', 'hse',
            'qualität', 'qualitätsmanagement', 'qualitätsleiter', 'qualitätssicherung', 'qs-leiter',
            'kalite', 'kalite güvence', 'kalite kontrol',
            'qualité', 'responsable qualité', 'assurance qualité',
            'calidad', 'jefe de calidad', 'aseguramiento de calidad',
            'qualità', 'responsabile qualità', 'assicurazione qualità',
            'kwaliteit', 'kwaliteitsmanager',
            'jakość', 'kierownik jakości', 'zapewnienie jakości',
        ],
    },
    {
        code: 'logistics',
        label: { tr: 'Lojistik / Depo', en: 'Logistics / Warehouse' },
        keywords: [
            'logistics', 'warehouse', 'shipping', 'freight', 'distribution', 'fulfillment',
            'logistik', 'lager', 'versand', 'spedition', 'logistikleiter', 'lagerleiter',
            'lojistik', 'depo', 'sevkiyat', 'nakliye',
            'logistique', 'entrepôt', 'responsable logistique', 'transport',
            'logística', 'almacén', 'jefe de logística', 'distribución',
            'logistica', 'magazzino', 'responsabile logistica', 'spedizioni',
            'logistiek', 'magazijn', 'logistiek manager',
            'logistyka', 'magazyn', 'kierownik logistyki', 'spedycja',
        ],
    },
] as const;

export const TITLE_BUCKET_CODES: readonly string[] = TITLE_BUCKETS.map((b) => b.code);

export function isKnownBucket(code: string): boolean {
    return TITLE_BUCKET_CODES.includes(code);
}

/** Lowercase, strip diacritics (ı→i, ö→o, ü→u, ß→ss …), collapse whitespace. Applied to BOTH
 *  sides of the match so "Einkäufer" the keyword meets "EINKAUFER" the title. */
export function normalizeTitle(s: string): string {
    return s
        .toLocaleLowerCase('en')
        .replace(/ß/g, 'ss')
        .replace(/ı/g, 'i')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// Normalized keyword sets are precomputed once (module scope) — the matcher runs per contact.
const NORMALIZED: ReadonlyMap<string, string[]> = new Map(
    TITLE_BUCKETS.map((b) => [b.code, b.keywords.map(normalizeTitle)])
);

export interface BucketMatch {
    bucket: string;
    /** Lower = higher priority: custom keywords are 0, then the customer's bucket order from 1. */
    priority: number;
}

/**
 * Match a contact's position/title against the customer's ordered bucket selection.
 * `customKeywords` (already customer-provided words, any language) outrank every bucket.
 * Returns null when nothing matches (the contact can still fill leftover slots, unranked).
 */
export function matchTitleBucket(
    position: string | null | undefined,
    orderedBuckets: readonly string[],
    customKeywords: readonly string[] = []
): BucketMatch | null {
    if (!position) return null;
    const title = normalizeTitle(position);
    if (title.length === 0) return null;
    for (const kw of customKeywords) {
        const norm = normalizeTitle(kw);
        if (norm.length > 0 && title.includes(norm)) return { bucket: 'custom', priority: 0 };
    }
    for (let i = 0; i < orderedBuckets.length; i++) {
        const kws = NORMALIZED.get(orderedBuckets[i]);
        if (!kws) continue;
        if (kws.some((kw) => title.includes(kw))) return { bucket: orderedBuckets[i], priority: i + 1 };
    }
    return null;
}
