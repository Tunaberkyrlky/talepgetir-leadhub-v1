/**
 * Asset storage adapter (v3 WP3). Uploads a rendered asset to Cloudflare R2.
 *
 * GUARDRAIL: ENV-GATED INERT. Without the R2_* env the adapter is a NO-OP:
 * uploadRenderedHtml() returns null and the caller keeps the HTML inline in the DB
 * (generated_assets.rendered_html), so the asset is still fully previewable. No
 * Cloudflare account/DNS work is done here. When the env IS present, a real
 * S3-compatible R2 put plugs in at the seam below — but at night the env is unset,
 * so nothing runs and COGS stays $0.
 */

/** True only when every R2 credential is present. Default (unset) ⇒ inert. */
export function r2Configured(): boolean {
  return !!(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET
  );
}

/**
 * Upload rendered HTML for an asset. Returns the R2 object key on success, or null
 * when R2 is inert (caller stores rendered_html inline). The real put is an
 * intentionally-unwired seam (like the enrichment live path) so no build-time R2/S3
 * dependency is pulled in; it throws rather than silently dropping the asset if the
 * env is set without the client being wired.
 */
export async function uploadRenderedHtml(
  tenantId: string,
  assetId: string,
  _html: string,
): Promise<string | null> {
  if (!r2Configured()) {
    // INERT: no-op. The caller keeps rendered_html inline in the DB.
    return null;
  }
  // Seam: a real R2 (S3-compatible) PutObject plugs in here, e.g.
  //   key = `assets/${tenantId}/${assetId}.html`; putObject(bucket, key, _html, 'text/html');
  // Deliberately unwired in WP3 to avoid a build-time dependency.
  void tenantId;
  void assetId;
  throw new Error('R2 upload is not configured (inline storage only)');
}
