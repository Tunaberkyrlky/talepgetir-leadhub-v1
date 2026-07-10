# Mailbox onboarding and safety policy

## Policy intent

TG Core optimizes for account safety and relevant replies, not maximum volume. This policy applies to automated marketing/sales sequences; it does not attempt to restate provider account ceilings. All numerical volumes and thresholds below are **TG Core product-level safety recommendations**, not official Microsoft, Google, Yahoo, SMTP-provider, legal, or guaranteed-deliverability limits.

No automated sequence may send until the exact mailbox and exact visible sender identity are ready. A connected credential is not a ready mailbox.

## Readiness states

| State | Meaning | Allowed behavior |
|---|---|---|
| `connected_unverified` | Authentication succeeded, identity/domain tests incomplete | Diagnostic recipient only |
| `blocked_identity` | Unauthorized From, unexpected Sender, consumer/business identity mismatch, or DMARC alignment failure | No customer recipients |
| `blocked_security` | Invalid TLS, unsafe credential mode, callback/grant ownership concern, revoked token | No sends or inbound access until corrected |
| `not_ready_new` | New/unknown mailbox or domain lacks sufficient real activity/evidence | Manual mail and diagnostic tests; no sequence by default |
| `ramp_limited` | Identity passes but uses a conservative progressive budget | Sequences within assigned profile |
| `ready` | Identity, auth, sync, compliance and recent health pass | Sequences within healthy profile |
| `cooldown` | Temporary throttle, volume anomaly, soft-bounce or sync issue | New sends paused or reduced until recovery criteria |
| `paused_policy` | Provider policy block, hard-bounce/complaint issue, repeated auth failure, or admin action | No sends; investigation required |
| `disconnected` | Grant revoked/credentials deleted | No access; reconnect required |

Every state has machine-readable reason codes, evidence, observed time, expiry/recheck time, automatic action, and human remediation. There is no aggregate “deliverability score.”

## Connection checks

### Common checks

- Create a one-time connection intent bound to organization, user, provider and expected callback; validate state, expiry, subject and connection ownership.
- Normalize and validate email/domain; reject CR/LF/control characters and deceptive display names.
- Confirm the authenticated subject/account belongs to the mailbox record; persist immutable provider tenant/user IDs.
- Enumerate provider-authorized identities; do not accept a customer-typed From as evidence.
- Confirm required send capability; if inbound sync is enabled, confirm read/sync capability independently.
- Confirm token expiry/refresh or SMTP/IMAP authentication without recording credentials in logs.
- Require TLS with valid hostname/certificate and reject private/special network destinations.
- Run a controlled diagnostic send and collect the full recipient raw message plus provider-side Sent item/log evidence.
- Record privacy/compliance acknowledgements, audience/source policy, sender identity, postal identity, and opt-out configuration.

### Microsoft checks

- Classify work/school versus personal Microsoft account; Microsoft 365 mode requires a work/school tenant.
- Store Entra tenant ID, Graph user ID, `userPrincipalName`, primary mailbox address and account type. A `mail` profile string is not enough.
- Normal user: `/me` identity must equal the selected primary From.
- Shared/other mailbox: require explicit `Mail.Send.Shared` and Exchange **Send As** validation. Detect and block Send on Behalf unless the customer deliberately selects a clearly labeled non-marketing use case.
- Verify the diagnostic raw message has the expected `From`, no distinct unexpected `Sender`, and passing aligned DMARC.
- Record Graph subscription/delta health if reply stop/sync is promised.

### Gmail checks

- Store Google subject and primary address; enumerate Gmail `sendAs` identities.
- Permit only primary or verification-accepted aliases. Never treat a pending alias or Workspace domain membership as send permission.
- Verify OAuth grant scopes and refresh behavior; read access is a distinct capability.
- Verify the diagnostic copy’s `From`, `mailed-by`, `signed-by`, `Authentication-Results` and DMARC alignment; any unexplained “via” is a blocker for sequence activation.
- Record watch/history health if reply stop/sync is promised.

### Generic SMTP/IMAP checks

- Discover and record SMTP/IMAP capabilities and AUTH mechanisms; prefer OAuth.
- Prohibit invalid-certificate bypass in production. Require TLS 1.2+ and safe STARTTLS behavior.
- Authenticate as the configured account and test the exact selected From. A different username is allowed only when the provider proves authorized alias/Send As behavior through the received diagnostic result.
- Discover Sent/INBOX by special-use and namespace capabilities; record folder, UIDVALIDITY and cursor. Confirm whether SMTP saves a Sent copy.
- Run IMAP ingest and recovery tests before claiming reply detection. Unknown SMTP without usable IMAP is send-only and cannot run a multi-step sequence that promises automatic stop-on-reply.

## Domain checks

Run at connection, before first activation, after relevant DNS TTL expiry, after identity/provider changes, and periodically.

| Check | Pass/warn/block policy |
|---|---|
| Domain resolution and MX | Block nonexistent domain/no MX for a reply-capable sender; warn on unusual routing only after confirmation |
| SPF | Parse record, reject multiple SPF records/permerror, calculate lookup budget, verify provider authorization where relevant; warn rather than demand customer changes if DKIM provides aligned DMARC and provider envelope is expected |
| DKIM | DNS selector existence alone is not proof; require passing diagnostic signature. Warn on provider fallback domain; block when diagnostic DMARC fails |
| DMARC | Require valid record for automated campaigns; `p=none` is acceptable initial monitoring with warning. Evaluate relaxed/strict SPF and DKIM alignment and organizational domain |
| Return-Path | Observe from diagnostic message. Do not ask Microsoft/Gmail customers to customize it. Block only if resulting authentication/alignment fails or identity is deceptive |
| MX/TLS | Verify mail receive path and TLS capability where observable; invalid cert is block |
| MTA-STS/TLS-RPT | Useful soft recommendation, not a send prerequisite |
| BIMI | Informational only; never presented as a placement requirement |
| Domain age | External/WHOIS/RDAP age can be unavailable or privacy-redacted; treat as a risk input, never a definitive reputation score |

## Post-connection identity test

Send one plain, direct-link/no-tracking diagnostic to controlled Gmail and Outlook recipients. Store:

- raw headers and a cryptographic hash of the test content;
- `From`, `Sender`, `Reply-To`, `Return-Path`, Message-ID, Received chain;
- SPF result and domain, DKIM result and `d=`, DMARC result and `header.from`;
- Gmail mailed-by/signed-by/via display;
- Microsoft message trace/request IDs and Graph `/me`/Sent item identity;
- selected provider adapter, authenticated provider subject and application egress IP;
- test time, identity validation version, and expiry.

Hard-block if visible From differs from selected identity, an unexpected Sender exists, DMARC fails, a provider rewrites From, or the recipient UI shows an unexplained delegate/via identity. A DNS-only check cannot override a failed live test.

## Mailbox evidence and risk assessment

Use only signals legitimately available to TG Core:

- provider/account type and tenant ID;
- provider-authorized identities and real diagnostic authentication;
- recent Sent counts available under consented scopes;
- customer declaration of mailbox/domain creation and recent activity;
- domain DNS/age evidence with source and confidence;
- TG Core’s own accepted, bounce, complaint, opt-out, throttle, reply and manual-send history;
- token, provider, watch and sync health;
- current campaign load across all campaigns using the mailbox.

Do not claim access to a secret provider reputation score. Mailbox age is often not available from APIs. Recipient engagement outside the product, spam-folder placement at arbitrary providers, and Microsoft/Google internal reputation are generally not observable. “Unknown” remains unknown; it must not be presented as healthy.

## Conservative initial sending profiles

The counts are **automated sequence emails per mailbox per product day**, excluding controlled diagnostics but including all campaigns. Manual user activity still consumes provider capacity and should reduce the available automated budget when observable.

| Profile | Eligibility | Start / ramp | Initial cap | Notes |
|---|---|---|---|---|
| Healthy established business mailbox | Passing identity/auth; customer confirms active ordinary use; at least 30 days old; no adverse TG history | 20/day; add at most 5 after each 3 healthy business days | 50/day | Microsoft 365 or Workspace default healthy profile. Higher volume is not an initial product feature. |
| Established but inactive mailbox | Old mailbox/domain but little recent real activity | 5/day for 5 business days, then +5 per 5 healthy business days | 30/day | Real one-to-one use and relevant replies are preferable to synthetic activity. |
| Newly created mailbox | Less than 30 days old or age unknown with no normal activity evidence | Diagnostic/manual only for first 14 days by default; then 3/day, +2 per 5 healthy business days | 20/day | Admin exception requires evidence; never auto-promote solely because time elapsed. |
| New domain | Less than 30 days or no established mail/auth history | Diagnostic/manual only by default; after domain and mailbox qualify, 2-5/day | 15/day during first 60 days | Domain and each mailbox share an even stricter domain bucket. |
| Unknown generic SMTP mailbox | Provider/age/activity uncertain but identity/TLS pass | 5/day; +5 per 7 healthy business days | 20/day | Must have reliable IMAP for stop-on-reply sequences. |
| Consumer Gmail | Primary identity/auth pass | 5/day; +5 per 7 healthy business days | 15/day | Not recommended for business sequencing; product may disallow based on Google policy/verification review. |
| Consumer Outlook | Primary identity/auth pass with no generated/alias mismatch | 5/day; +5 per 7 healthy business days | 15/day | Not Microsoft 365; generated `outlook_…` or “via/on behalf” result blocks use. |
| Microsoft 365 business | Use evidence-specific profile above | Default 20/day on healthy established account | 50/day | Provider ceilings are much higher but irrelevant to TG Core safety. |
| Google Workspace business | Use evidence-specific profile above | Default 20/day on healthy established account | 50/day | Gmail policy/API verification and verified sendAs are prerequisites. |

A “day” is a configured customer-local window with a rolling-24-hour backstop; timezone changes cannot reset it. Per-hour and minimum-delay buckets prevent packing the daily total into a burst. Default minimum spacing is 3 minutes, default maximum is 10 automated messages/hour/mailbox, and provider concurrency is 1 per mailbox. Randomize within a bounded schedule rather than simulate behavior.

Domain and organization defaults: 100 automated messages/day/domain and 200/day/organization initially, subject to the sum of lower mailbox budgets. Recipient-domain default is no more than 10/hour and 20/day to one organizational recipient domain across the customer. These are anti-burst controls, not provider limits, and should become stricter for new domains.

## Ramp-up rules

- Increase only after the full number of **active sending** business days; idle days do not count.
- Require current identity/DNS/token/sync health, zero complaints, hard-bounce rate below the warning threshold, no policy blocks, no repeated throttling, and stable opt-out levels.
- Consider manual sending volume and other campaigns before reserving automated volume.
- Increase one dimension at a time and never more than the profile increment.
- Any cooldown reduces the budget at least one step; a serious pause resets to a reviewed profile.
- No customer/admin can override a provider rejection, identity mismatch, active suppression, invalid TLS, or legal/compliance block.
- Changes are audited with old/new value, evidence, actor and expiry.

## No-warmup strategy

Not offering an artificial warmup network is acceptable and preferable for this product. Existing healthy mailboxes do not need fake traffic; new or inactive mailboxes need gradual relevant human/sequence use and clean recipient selection.

Artificial warmup cannot guarantee durable reputation. Closed networks can create repetitive reciprocal opens/replies, move messages out of spam, or generate geographically/behaviorally implausible access. Providers can discount or penalize suspicious patterns; it also exposes mailbox content/tokens to another processing system. TG Core should not build fake reply pools.

Build controlled ramp-up, readiness evidence, recipient validation and automatic pauses first. A later “warmup” feature, if considered at all, should mean customer guidance and real-traffic ramp controls—not fabricated correspondence.

## Pre-send enforcement

Every job is checked at enrollment and again atomically immediately before dispatch:

- mailbox connected, token/credentials current, provider not degraded;
- exact sender identity active and validation unexpired;
- domain/auth readiness current and no identity mismatch;
- inbound sync fresh enough to honor replies/unsubscribes for multi-step sequences;
- mailbox, campaign, domain, organization and provider not paused;
- all distributed budgets have capacity and reservation succeeds;
- recipient normalized and absent from organization/global policy suppression;
- no prior hard bounce/do-not-contact/unsubscribe and no concurrent job for same logical step;
- campaign compliance/source record and body identity/opt-out complete;
- content policy has no blocking deception, unsafe link/header, malware or forbidden first-touch attachment;
- campaign and enrollment remain active after the worker obtains its lease.

Failure creates a reasoned `blocked` or `deferred` job; it never silently discards or sends around policy.

## Content and recipient safety rules

Hard-block header injection, hidden text, malware, mismatched/deceptive links, impersonation/misleading From names, fake quoted reply chains, fake `Re:`/`Fwd:` without a real referenced message, absent sender identity/postal details where required, and absent opt-out on automated commercial mail. Also block templates that place secrets or prohibited sensitive personal data into merge fields.

Warn and require correction/acknowledgement for excessive capitalization or punctuation, too many links, URL shorteners, newly registered/suspicious linked domains, heavy or malformed HTML, large/image-only bodies, large images, first-touch attachments, excessive personalization, unverifiable/deceptive claims, or unusual HTML-to-text differences. Default first touch to concise multipart text/HTML, direct branded links, no attachment and no tracking.

Recipient policy rejects purchased or indiscriminately scraped lists under the product acceptable-use policy, preserves source and collection evidence, and flags role accounts, catch-all domains, invalid syntax, disposable domains and previously unengaged/repeatedly ignored recipients. Role/catch-all status is a risk signal rather than proof that a person cannot lawfully or usefully receive mail. A customer must not use validation results to override consent/expectation, suppression or regional restrictions.

These are technical/product safeguards, not a determination that a campaign is lawful. Customers remain responsible for audience/content; TG Core still enforces identity, suppression, opt-out, security and acceptable-use controls.

## Monitoring during and after sending

Monitor provider API/SMTP error class, `Retry-After`, authentication failures, policy/spam blocks, unknown outcomes, queue delay, leases, volume deltas, bounce/complaint/opt-out/reply patterns, watch/subscription expiry and inbox sync lag. Calculate rates over both rolling windows and minimum sample sizes; show numerators and denominators.

### Automatic pause and suppression rules

These are initial product policies and require tuning from real, compliant traffic:

| Signal | Automatic action | Recovery |
|---|---|---|
| Unauthorized From, unexpected Sender, DMARC fail on diagnostic | Block identity and all jobs using it immediately | Reconfigure, re-test raw headers, manual approval |
| Any recipient complaint | Suppress recipient immediately; pause campaign/mailbox for review at low volume | Root-cause review; recipient never unsuppressed automatically |
| Complaint rate >=0.1% with at least 1,000 delivered in rolling 30 days | Pause affected campaign and mailbox | Evidence-based review and reduced profile; remain well below provider 0.3% boundary |
| Any high-confidence hard bounce | Suppress exact address immediately | Lift only with audited proof address is valid/owner requested mail |
| >=3 hard bounces in 24h or hard-bounce rate >=5% with at least 20 attempts | Pause campaign and mailbox | List-source review, remove invalids, restart one profile lower |
| Hard-bounce warning >=3% with at least 20 attempts | Stop ramp, reduce next budget by 50% | Healthy rolling window below warning |
| Soft-bounce/deferral rate >=10% with at least 20 attempts | Cooldown mailbox/campaign; exponential provider retry only | Provider/domain recovery and stable window |
| Provider spam/policy/authentication rejection | Immediate mailbox pause; domain/org pause if repeated across mailboxes | Provider/tenant/DNS investigation and diagnostic test |
| Three consecutive auth/refresh failures | Pause mailbox, stop sync and send, notify reconnect | Successful reauthorization and health test |
| Repeated throttling (three events in one hour) | Reduce hourly budget 50% and cooldown | 24 hours without throttle, gradual recovery |
| Send volume exceeds 150% of trailing 7-active-day median | Stop new reservations pending review | Confirm legitimate campaign and bounded new budget |
| Inbound sync lag >15 minutes with healthy provider notification path, or >2 poll intervals for IMAP | Pause subsequent sequence steps that depend on stop-on-reply | Cursor reconciliation and fresh sync |
| Graph subscription/Gmail watch expired | Pause dependent multi-step sending; renew and reconcile | Valid subscription/watch and caught-up cursor |
| Unknown provider outcome | Pause that job; reconciliation worker only, no automatic resend | Sent evidence -> accepted; absence plus reviewed safe retry; otherwise manual |
| One-click/reply unsubscribe | Suppress atomically, cancel all current/future jobs for address | No automatic recovery |

An organization-wide pause occurs for cross-mailbox policy blocks, shared-domain identity failure, evidence of compromised credentials, repeated suppression bypass attempts, or systemic abnormal volume. A provider-integration-wide pause occurs for signature validation failure, cross-tenant authorization concern, widespread token failures, duplicate-send evidence, or provider incident where safe status cannot be determined.

## Suppression policy

- Organization-wide suppression is mandatory for unsubscribe, do-not-contact, hard bounce and complaint. Campaign-only unsubscribe is not sufficient.
- Normalize with case-insensitive domain and conservative local-part handling; retain original address and a lookup hash/encrypted value. Do not merge Gmail dots/plus tags for business logic unless the mailbox owner proves equivalence.
- Suppression is checked before import/enrollment, at scheduling, claim and immediately before provider I/O.
- Contact deletion does not delete the minimal suppression record needed to honor an objection. Retention/legal review determines pseudonymization and erasure behavior.
- Imports report suppressed rows without exposing suppression data across tenants.
- Admin removal requires a privileged role, a reason, evidence/source, expiration where relevant, and audit. Customer-facing users cannot override complaint/provider/global blocks.

## Customer-facing warnings

Use direct explanations:

- “This Microsoft login is a personal Outlook account, not the Microsoft 365 tenant for `degisimmotor.com`.”
- “Recipients saw `outlook_…@outlook.com` as the actual sender. Select the real Microsoft 365 mailbox or configure verified Send As.”
- “The selected From address is not a verified Gmail send-as identity.”
- “Your SMTP login succeeded, but the provider rewrote or delegated the From address.”
- “DKIM passed for `outlook.com`, but it did not align with the visible `degisimmotor.com` From; DMARC failed.”
- “This mailbox is new or inactive. Automated volume is limited to 3/day and will only rise after healthy active days.”
- “Reply synchronization is stale, so later sequence steps are paused to avoid emailing someone who already replied.”
- “Tracking is off by default. Enabling it can add privacy and deliverability risk; use a verified branded domain.”

Warnings must link to evidence and remediation. Do not promise “inbox ready,” “clean IP,” or guaranteed placement.

## Admin controls

Authorized admins can pause at mailbox/campaign/domain/organization/provider scope; lower a profile; request revalidation; reconnect/revoke; reconcile unknown jobs; inspect redacted provider evidence; and export audit/compliance history. They may not bypass active suppression, sender authorization, invalid TLS, cross-tenant boundaries, or a provider policy rejection. Every control is least-privilege, reason-required, time-stamped and reversible where safety permits.
