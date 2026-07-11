/**
 * MX-record sanity check for an intake email domain (intake hardening, MEGA §3.6).
 *
 * Asks DNS whether the email's domain can receive mail. This is a deliverability
 * SIGNAL, not a gate: a domain with no MX records is suspicious and routes the
 * lead to Review — it does NOT reject it (a legit domain can be misconfigured).
 *
 * Crucially, DNS UNCERTAINTY is never held against the submitter: only a definite
 * negative (NXDOMAIN / no-such-host / an explicitly empty MX set) counts as
 * `mx_missing`. A timeout, SERVFAIL, or any other transient resolver error is
 * `unknown` and leaves the lead untouched.
 *
 * No outbound connection is made — we only query DNS for the MX record, so there
 * is no SSRF surface (unlike ssrfGuard.ts, which pins a dial target).
 */

import { resolveMx } from 'dns/promises';

export type MxResult = 'ok' | 'mx_missing' | 'unknown';

const MX_TIMEOUT_MS = 2_000;

/** DNS error codes that DEFINITIVELY say "this domain cannot receive mail". */
const DEFINITE_NEGATIVE = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);

/**
 * Resolve MX records for `domain` under a tight timeout.
 *  • at least one MX record        → 'ok'
 *  • NXDOMAIN / no-host / empty set → 'mx_missing'  (definite negative)
 *  • timeout / SERVFAIL / other     → 'unknown'      (NOT penalized)
 */
export async function checkMx(domain: string | null | undefined): Promise<MxResult> {
  const host = domain?.trim().toLowerCase();
  if (!host) return 'unknown';

  const timeout = new Promise<MxResult>((resolve) => {
    setTimeout(() => resolve('unknown'), MX_TIMEOUT_MS).unref?.();
  });

  const lookup = resolveMx(host)
    .then<MxResult>((records) => (records && records.length > 0 ? 'ok' : 'mx_missing'))
    .catch<MxResult>((err: NodeJS.ErrnoException) =>
      DEFINITE_NEGATIVE.has(err?.code ?? '') ? 'mx_missing' : 'unknown',
    );

  return Promise.race([lookup, timeout]);
}

/** Convenience: MX check for an email's domain (part after the last '@'). */
export function checkMxForEmail(email: string | null | undefined): Promise<MxResult> {
  if (!email) return Promise.resolve('unknown');
  const at = email.lastIndexOf('@');
  if (at < 0) return Promise.resolve('unknown');
  return checkMx(email.slice(at + 1));
}
