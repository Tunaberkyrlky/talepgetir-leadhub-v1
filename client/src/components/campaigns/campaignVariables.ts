// Kampanya editöründe paylaşılan değişken + spintax listesi (gövde autocomplete'i,
// konu autocomplete'i ve öneri eklentisi aynı kaynağı kullanır).
export interface VariableItem {
    key: string;
    label: string;
    insert: string;
    spintax?: boolean;
}

export const VARIABLE_ITEMS: VariableItem[] = [
    { key: 'first_name', label: 'First Name', insert: '{{first_name}}' },
    { key: 'last_name', label: 'Last Name', insert: '{{last_name}}' },
    { key: 'email', label: 'Email', insert: '{{email}}' },
    { key: 'company_name', label: 'Company', insert: '{{company_name}}' },
    { key: 'title', label: 'Title', insert: '{{title}}' },
    { key: 'website', label: 'Website', insert: '{{website}}' },
    { key: 'industry', label: 'Industry', insert: '{{industry}}' },
    { key: 'random', label: 'Spintax', insert: '{{random|A|B|C}}', spintax: true },
];

// {{ ile başlayan, henüz kapanmamış sorguyu yakalar (autocomplete tetikleyici).
export const TRIGGER_RE = /\{\{([^{}|]*)$/;

export function filterVariables(query: string): VariableItem[] {
    const q = query.toLowerCase();
    return VARIABLE_ITEMS.filter((i) => (`${i.key} ${i.label}`).toLowerCase().includes(q)).slice(0, 8);
}
