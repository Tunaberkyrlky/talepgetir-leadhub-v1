/**
 * TG-LinkedIn Faz 4 — message/invite-note personalization (§5).
 *
 * Two layers, applied in order:
 *   1. Spintax  {{A|B|C}}  → one option chosen at random (breaks the exact-duplicate-text
 *      pattern LinkedIn flags across many sends).
 *   2. Variables  {firstName}/{first_name} {lastName}/{last_name} {company} {title} + any CSV
 *      custom var  → substituted from the lead. Both camelCase and snake_case spellings resolve
 *      (the builder UI documents snake_case). An unknown / empty variable renders as empty string
 *      (never the literal "{foo}" — a visible placeholder is worse than a gap).
 *
 * Pure + injectable rng so a test can pin the spintax choice.
 */

export interface PersonalizeVars {
    firstName?: string | null;
    lastName?: string | null;
    company?: string | null;
    title?: string | null;
    /** CSV custom variables (lead.custom). */
    custom?: Record<string, unknown> | null;
}

/** Resolve a single {{a|b|c}} group to one option. */
function resolveSpintax(template: string, rng: () => number): string {
    // Non-nested groups; run a bounded number of passes to also collapse simple nesting.
    let out = template;
    for (let pass = 0; pass < 5 && out.includes('{{'); pass++) {
        out = out.replace(/\{\{([^{}]*)\}\}/g, (_m, body: string) => {
            const opts = String(body).split('|');
            if (opts.length === 0) return '';
            const i = Math.min(opts.length - 1, Math.max(0, Math.floor(rng() * opts.length)));
            return opts[i];
        });
    }
    return out;
}

/** Substitute {key} tokens from the lead vars (unknown → empty). */
function resolveVars(template: string, vars: PersonalizeVars): string {
    const flat: Record<string, string> = {};
    const put = (k: string, v: unknown) => { if (v != null && typeof v !== 'object') flat[k.toLowerCase()] = String(v); };
    // Register both spellings for the core fields so {firstName} AND {first_name} resolve (the
    // steps-editor hint teaches snake_case; without the alias those tokens rendered empty).
    put('firstname', vars.firstName); put('first_name', vars.firstName);
    put('lastname', vars.lastName); put('last_name', vars.lastName);
    put('company', vars.company);
    put('title', vars.title);
    if (vars.custom && typeof vars.custom === 'object') {
        for (const [k, v] of Object.entries(vars.custom)) put(k, v);
    }
    // Only match a conservative token shape so stray braces in prose don't get eaten. Underscores
    // are normalized away so {first_name} also matches a camelCase-registered key and vice versa.
    return template.replace(/\{([a-zA-Z][a-zA-Z0-9_ ]*)\}/g, (_m, key: string) => {
        const norm = key.trim().toLowerCase();
        const v = flat[norm] ?? flat[norm.replace(/_/g, '')];
        return v ?? '';
    });
}

/**
 * Render a template into final text: spintax first (so a var inside a chosen branch survives),
 * then variables. Trims trailing whitespace a collapsed variable can leave behind.
 */
export function personalize(template: string, vars: PersonalizeVars, rng: () => number = Math.random): string {
    if (!template) return '';
    const spun = resolveSpintax(template, rng);
    return resolveVars(spun, vars).replace(/[ \t]+\n/g, '\n').trim();
}
