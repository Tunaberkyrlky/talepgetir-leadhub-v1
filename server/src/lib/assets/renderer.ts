/**
 * Asset renderer (v3 §9.3, WP3). Maps STRUCTURED content JSON onto a FIXED tenant-
 * themed HTML template. The LLM never produces free-form HTML — every user/model
 * value is HTML-escaped and placed into this deterministic template, so the output
 * surface is fully controlled here.
 */
import type { StructuredContent } from './generator.js';

/**
 * Font choice is a CLOSED enum, never a free string. A free `fontFamily` string was a
 * CSS-injection vector (it is interpolated into a `font-family:` declaration, where
 * HTML-escaping does nothing — `x; …` breaks out of the property). We accept only an
 * enum key and map it to a server-owned CSS stack below; anything else falls back to
 * the default, so untrusted theme JSON can never reach the stylesheet.
 */
export type AssetFontFamily = 'system' | 'serif' | 'mono';

export interface RenderTheme {
  primary?: string;
  accent?: string;
  fontFamily?: AssetFontFamily;
}

/** Server-owned CSS font stacks. The only strings that ever reach `font-family:`. */
const FONT_STACKS: Record<AssetFontFamily, string> = {
  system: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
  serif: 'Georgia, Cambria, Times New Roman, Times, serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
};

/** Resolve an (untrusted) theme font key to a whitelisted CSS stack. */
function resolveFontStack(key: unknown): string {
  return typeof key === 'string' && key in FONT_STACKS
    ? FONT_STACKS[key as AssetFontFamily]
    : FONT_STACKS.system;
}

/** Escape a value for safe interpolation into HTML text/attribute context. */
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only http/https CTA links survive; anything else (javascript:, data:) is dropped. */
function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Render structured content to a self-contained HTML document using the recipe's
 * theme tokens. Inline CSS only (the artifact must render standalone from the DB or
 * from R2). Returns the full HTML string.
 */
export function renderHtml(content: StructuredContent, theme: RenderTheme = {}): string {
  const primary = /^#[0-9a-fA-F]{3,8}$/.test(theme.primary || '') ? theme.primary! : '#2f5bea';
  const accent = /^#[0-9a-fA-F]{3,8}$/.test(theme.accent || '') ? theme.accent! : '#0b1220';
  const font = resolveFontStack(theme.fontFamily);

  const sections = content.sections
    .map(
      (s) => `
      <section class="sec">
        <h2>${esc(s.heading)}</h2>
        <p>${esc(s.body)}</p>
      </section>`,
    )
    .join('');

  const ctaHref = safeHref(content.cta?.url ?? null);
  const ctaBlock =
    content.cta && content.cta.label
      ? `<div class="cta">${
          ctaHref
            ? `<a href="${esc(ctaHref)}" rel="noopener noreferrer">${esc(content.cta.label)}</a>`
            : `<span class="cta-disabled">${esc(content.cta.label)}</span>`
        }</div>`
      : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(content.title)}</title>
<style>
  :root { --primary:${esc(primary)}; --accent:${esc(accent)}; }
  * { box-sizing: border-box; }
  body { margin:0; font-family:${font}; color:var(--accent); background:#f6f8fb; line-height:1.55; }
  .wrap { max-width:720px; margin:0 auto; padding:32px 20px 56px; }
  header { border-bottom:3px solid var(--primary); padding-bottom:16px; margin-bottom:24px; }
  h1 { font-size:26px; margin:0 0 6px; color:var(--accent); }
  .subtitle { color:var(--primary); font-weight:600; margin:0; }
  .summary { font-size:16px; margin:20px 0; }
  .sec { background:#fff; border:1px solid #e6ebf2; border-radius:10px; padding:16px 18px; margin:12px 0; }
  .sec h2 { font-size:16px; margin:0 0 6px; color:var(--primary); }
  .sec p { margin:0; }
  .cta { margin-top:28px; text-align:center; }
  .cta a { display:inline-block; background:var(--primary); color:#fff; text-decoration:none; padding:12px 22px; border-radius:8px; font-weight:600; }
  .cta-disabled { display:inline-block; color:#8a94a6; padding:12px 22px; border:1px dashed #c3ccda; border-radius:8px; }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>${esc(content.title)}</h1>
      ${content.subtitle ? `<p class="subtitle">${esc(content.subtitle)}</p>` : ''}
    </header>
    <p class="summary">${esc(content.summary)}</p>
    ${sections}
    ${ctaBlock}
  </div>
</body>
</html>`;
}

/**
 * PDF rendering placeholder (v3 §9 output_kind='pdf'). Not wired in WP3 — returns
 * null so callers keep the HTML path. A real PDF pipeline plugs in behind a flag.
 */
export async function renderPdf(_content: StructuredContent, _theme: RenderTheme = {}): Promise<Buffer | null> {
  return null;
}
