# Remediation and coding plan for the active TG Core repository

## Planning rules

- This plan starts from revision `1458ccb`; it is not a greenfield rewrite.
- Complexity is relative (`S`, `M`, `L`, `XL`), not a time estimate.
- Runtime behavior must remain feature-flagged until raw-header and duplicate-send acceptance tests pass.
- Allocate migration sequence numbers at implementation time. The current repository already has both `supabase/migrations/055_activities_campaign_step_order.sql` and `supabase/migrations/055_campaign_prefix_rules.sql`; avoid another collision and normalize the migration registry first.
- Database changes are additive first, dual-written/verified second, and destructive cleanup only after rollback windows close.

## Phase 0 — immediate safety fixes

These changes precede any new customer or unattended campaign.

| Work item | Current file/module and behavior | Proposed behavior and reason | Dependencies / migration | Tests and acceptance | Compatibility / rollout / risk | Size |
|---|---|---|---|---|---|---|
| Emergency send gate | `server/src/routes/campaigns.ts:291-320` activates with any connection; `campaignEngine.ts:397-653` sends automatically | Add `EMAIL_SEQUENCER_ENABLED`, tenant allowlist, mailbox `sending_enabled`, and an emergency provider/organization pause. Activation and pre-dispatch enforce all gates. This limits current blast radius. | Add state/reason columns to `email_connections` or new `mailbox_health`; admin endpoint/UI | Disabled flag produces no provider call; pause wins after job claim; audit entry exists | Default off outside named staging tenants; rollback is flag reversal | S |
| Authorized sender identity | `email-connections.ts:92-185` and `smtpAdapter.ts:75-128` allow SMTP username and visible address to differ; Graph/Gmail lack identity inventory | Create `mailbox_identities`; stop accepting a free-form From at send time. SMTP requires a controlled test of the exact From; Microsoft normal mailbox uses `/me`; Gmail uses verified `sendAs`. Hard-block mismatch. | New identity/validation tables; provider discovery services | Wrong From is rejected before SMTP/API; shared/alias fixtures require explicit verified identity; raw diagnostic results stored | Backfill existing connection address as `unverified`; existing campaigns stay paused until validated | L |
| Safe tracking defaults | `campaignEngine.ts:562-569`, `email-replies.ts:44-59`, and client switches enable tracking unless false; `mailTracking.ts:16-19` has fallback secret | Default both off, stop rewriting first-touch links, require configured secret, and reject tracking in production without a validated tracking domain. | Settings migration converting null/default to false; UI copy | Newly created and existing unspecified campaigns send no pixel/redirect; missing secret fails closed | Existing explicit opt-ins remain but are paused until domain validation; easy flag rollback | S-M |
| Global suppression | Enrollment and pre-send paths do not consult a durable no-send registry; unsubscribe GET changes one enrollment | Add organization-scoped `suppressions` and `unsubscribes`; check at enrollment, scheduling, claim, and pre-dispatch. Any opt-out/do-not-contact atomically suppresses and cancels active enrollments. | Add suppression tables, normalized address/hash indexes, backfill existing `unsubscribed` enrollments | Re-enroll/import/cross-campaign tests cannot send; concurrent unsubscribe wins before dispatch | Backfill can only reduce sending; admin lift requires audited reason | L |
| Standards-compliant unsubscribe | `server/src/routes/tracking.ts:71-108` mutates via GET; no headers | GET displays confirmation or supports a non-stateful legacy flow; authenticated opaque POST performs RFC 8058 one-click without redirects. Add `List-Unsubscribe` and `List-Unsubscribe-Post`; keep visible body link. | Signed token versioning and suppression service | Link-scanner GET cannot opt out; one-click POST suppresses immediately and idempotently; headers covered by DKIM in provider test | Preserve old tokens during a bounded transition; route version identifies semantics | M |
| Header and MIME safety | `emailSender.ts:110-180` manually builds incomplete raw MIME and accepts unsafe display/header values | Introduce a canonical message builder using a maintained MIME library; reject CR/LF/control characters; multipart text/HTML; unique Date/Message-ID; real reply headers; provider-owned transport fields prohibited | Update `CanonicalSendRequest`; store RFC IDs | Injection corpus, folded/non-ASCII headers, multipart snapshots, threading and unsubscribe tests | Feature flag by provider; compare raw messages before cutover | M |
| Stop ambiguous automatic retries | `campaignEngine.ts:615-653` retries every five minutes indefinitely; manual sends have no idempotency | Add idempotency key to all send endpoints and campaign execution. Classify `unknown` separately and never automatically resend it. Cap temporary retries with exponential backoff. | Initial `send_jobs`/`send_attempts` tables or a minimal precursor; client sends idempotency header | Same key returns prior outcome; provider timeout creates `unknown`, not a second send; permanent failure never retries | Existing endpoints accept missing key only under admin/test flag during migration | L |
| Hard-bounce intake and suppression | No DSN classifier; IMAP drops unmatched mailer-daemon messages | Ingest candidate DSNs before contact matching; parse RFC 3464/enhanced status; hard bounce suppresses exact address and cancels enrollments. Provider-specific formats become adapters. | `bounces`, `delivery_events`, raw-message quarantine | Fixtures for invalid mailbox/domain, mailbox full, policy block, deferral; false positives do not hard-suppress | Start observe-only in staging, then enforce high-confidence hard bounces | L |
| TLS and secret safety | UI exposes `allow_invalid_cert`; disconnect only marks inactive; attachments public | Remove production certificate bypass, revoke/delete OAuth and passwords on disconnect, make attachments private, rotate tracking/encryption secrets | Private storage migration; key version fields; Nango deletion API/config | Invalid certificate rejected; disconnected mailbox cannot refresh/send; cross-tenant attachment access denied | Migrate object ACLs before disabling public bucket; retain encrypted backup under short rollback policy | L |
| Microsoft incident gate | Current Graph path accepts consumer/work identities and records no identity evidence | Add Microsoft account-type/tenant checks and a diagnostic test recipient workflow. A generated Outlook transport identity or unexpected Sender hard-blocks business campaigns. | Graph profile enrichment, diagnostic mailbox, parser | Normal M365 and consumer Outlook fixtures; raw header and message trace checklist required | Consumer Outlook can remain manual/test-only rather than silently treated as M365 | M |

### Phase 0 acceptance gate

No additional customer can send until all are true: exact From identity is verified; tracking defaults off; suppression is global within the organization; hard-bounce candidates are ingested; every send has an idempotency record; ambiguous outcomes do not auto-retry; production TLS cannot be bypassed; and Microsoft/Gmail raw-header tests pass SPF/DKIM/DMARC and expected `Sender`/`From` behavior.

## Phase 1 — correct provider integrations

| Work item | Current file/module and behavior | Proposed behavior and reason | Dependencies / migration | Tests and acceptance | Compatibility / rollout / risk | Size |
|---|---|---|---|---|---|---|
| Provider contract refactor | `server/src/lib/mail/types.ts:51-119` exposes only a thin send operation; router selects by string address | Extend the existing directory into `providers/{microsoft,gmail,smtp}` implementing the contract in `03-ideal-email-architecture.md`. Resolve immutable mailbox/identity IDs. | Add capability/state fields; adapt router and callers | Contract suite runs against all adapters; no caller can supply arbitrary From | Keep legacy adapter shim during dual-run; remove only after all callers migrate | L |
| Microsoft delegated OAuth | `email-connections.ts:210-341` delegates to Nango with external configuration; callback ownership/account evidence incomplete | Create tenant/user-bound connection intents; verify state/connection ownership; persist Entra tenant, Graph object and account type, scopes and grant reference; require work/school account for M365 | Nango provider audit; OAuth app config; schema fields | Cross-tenant callback rejected; consent/revocation/Conditional Access/MFA tests; refresh failure pauses mailbox | New OAuth app/environment can run beside old connection; reconnect required for insufficient scopes | L |
| Correct Graph send | `emailSender.ts:229-270` calls `/me/sendMail`, returns request ID as message ID | Keep `/me/sendMail` for primary mailbox but introduce draft/send or immediate Sent reconciliation, real provider/RFC IDs and `X-TG-Send-Id`. Separate shared Send As path; never request Send on Behalf as a fallback. | `sent_messages`, attempts, identity permission fields | Primary, alias rejection, shared Send As, Send on Behalf rejection, 202/reconciliation and timeout tests | Per-mailbox feature flag; compare Sent item and recipient raw headers | L |
| Graph inbound sync | No Graph subscriptions/delta | Add notification endpoint, client-state/lifecycle validation, subscription renewal, per-folder delta cursors, periodic reconciliation and Sent/Inbox processing | `webhook_subscriptions`, `sync_cursors`, provider events; public HTTPS route | Duplicate/out-of-order/missed notification, cursor expiry, subscription expiry and shared mailbox limitation tests | Read scope needs incremental consent; sending remains available if sync is disabled, but campaigns requiring reply stop must not | XL |
| Gmail delegated OAuth | UI uses app password; Gmail API Nango path exists but scopes/config are not auditable | Make Gmail API OAuth primary; production consent/verification; bind Google subject; enumerate primary/verified `sendAs`; revoke on disconnect | Google Cloud project, verified consent, possible restricted-scope assessment for read | Primary/verified/pending aliases, token rotation/revocation, multiple Google accounts and cross-tenant callback tests | App-password connections remain labeled legacy and capped; reconnect migration | L |
| Correct Gmail send/threading | `emailSender.ts:110-221` posts manual raw MIME without robust identity/thread metadata | Use canonical MIME builder; store Gmail message/thread/RFC IDs and deterministic job ID; use `threadId` only with valid reply headers | `sent_messages`; provider adapter | Raw MIME/authentication, Unicode, attachment, alias, thread and timeout reconciliation tests | Dual-send only to diagnostic sink; never duplicate real recipient during comparison | L |
| Gmail inbound sync | No watch/history/Pub/Sub | Add watch creation/renewal, authenticated Pub/Sub endpoint, history sync, fallback poll/full resync and per-user one-event/sec handling | Pub/Sub project/topic/service identity; `gmail_watches`, cursors/events | Dropped/duplicate notifications, stale history, renewal, wrong project/topic/audience tests | Read scopes may delay launch; send-only remains explicit capability | XL |
| Generic SMTP/IMAP hardening | Current adapter verifies login, allows cert bypass; poller is password-only/INBOX-only | Capability/auth discovery, OAuth where available, mandatory TLS, exact identity test, special-use Sent discovery, mailbox/folder-scoped cursors, IDLE plus reconciliation; advance cursor transactionally | Extend connection/cursor tables; provider presets | Local SMTP/IMAP matrix, cert/STARTTLS downgrade, UIDVALIDITY reset, localized Sent, ingest failure/recovery | Existing legacy password connections reconnect if unsafe; no silent downgrade | XL |
| Connection lifecycle UI | Settings panel reports simplistic provider limits and state | Show provider, primary/alias/shared identity, scopes, account type, sync capability, test status, reason codes, reauthorize/revoke controls; remove universal limit copy | New API read models | Accessible UI tests; user cannot select unverified identity | Old connections display “validation required” rather than false healthy | M |

## Phase 2 — deliverability safeguards

| Work item | Current behavior | Proposed behavior and reason | Dependencies / migration | Tests and acceptance | Compatibility / rollout / risk | Size |
|---|---|---|---|---|---|---|
| DNS/domain service | `server/src/routes/campaigns.ts:291-320` has no DNS gate; no current DNS module | Add `server/src/lib/mail/health/domainHealth.ts`, a resolver with TTL/caching/timeouts, SPF parser/lookup count, DKIM selector/test evidence, DMARC organizational alignment, MX/TLS/MTA-STS/TLS-RPT observations | `sending_domains`, `dns_checks`, `domain_health`; public-suffix library | Multiple SPF, >10 lookup, NXDOMAIN, relaxed/strict alignment, subdomain and transient DNS tests | Observe first; hard-block only deterministic failures | L |
| Readiness workflow | `server/src/routes/campaigns.ts:291-320` checks only steps/connection; `server/src/routes/email-connections.ts` records no readiness evidence | Add connection/readiness service and endpoints: pre-connection DNS scan, post-connection identity inventory, controlled test send, raw-auth parser, classification and expiry | Diagnostic recipient infrastructure; identity/domain health | Cannot activate without current passing identity test and suppression/compliance configuration | Existing campaigns paused pending validation; staged tenant rollout | L |
| Central distributed limits | `server/src/lib/emailSender.ts:60-108` uses a process-local `Map`; `server/src/lib/validation.ts:383-404` makes campaign caps optional | Replace both with `rateLimitService.ts` and atomic reservations across mailbox, identity, domain, tenant, campaign, step and recipient domain; rolling-hour/day windows | `rate_limit_counters`; PostgreSQL RPC/transaction | Concurrent workers never exceed a bucket; restart/timezone/daylight-saving tests | Shadow-count current traffic before enforce; strictest limit wins | L |
| Controlled ramp and cooldown | `server/src/lib/campaignEngine.ts:256-302,479-521` has windows/counts but no mailbox readiness/ramp | Add `mailboxHealth.ts` and scheduling integration using profiles from `05-mailbox-onboarding-and-safety-policy.md`, audited evidence overrides, adaptive reductions and cooldown | Mailbox health/history and counters | New/inactive/unknown mailbox scenarios; no automatic upward jump after downtime | Default conservative; admin override audited and bounded | M |
| Content safety | `server/src/lib/validation.ts` and `server/src/lib/emailHtmlBuilder.ts` provide only basic validation/rendering | Add `contentPolicyService.ts` for deceptive prefixes/chains, identity/postal/opt-out, link count/shorteners/mismatch, HTML/image/attachment weight, hidden text and sensitive merge data | Template policy tables; URL/domain resolver | Deterministic fixture corpus; warning vs block reason stable | Start warnings except deception/header injection/compliance omissions | L |
| Tracking policy | `server/src/lib/mailTracking.ts`, `server/src/routes/tracking.ts`, and `CampaignSettingsPanel.tsx` use a shared redirect/pixel and default-on semantics | Default off, direct links, custom-domain validation and tenant isolation, privacy notice/retention, and reply metrics primary | Tracking-domain table, DNS/TLS validation | No shared redirect on default messages; custom domain cannot cross tenants | Legacy tracking links continue to resolve for retention window | M |
| Reply/opt-out classifier | `server/src/lib/imapInbound.ts` and `server/src/lib/campaignEngine.ts:767-819` only match replies/stop current enrollments | Add inbound classifier modules with deterministic header/DSN rules plus bounded human/positive/negative/OOO/challenge/unsubscribe classification; high-confidence safety actions only | Inbound normalization, suppressions | Multilingual unsubscribe/do-not-contact fixtures; OOO does not count positive; uncertain reviewed | Observe classifier before automations; suppression errs toward no-send | L |
| Compliance enforcement | `supabase/migrations/032_campaigns.sql` and campaign routes have no source/lawful-basis/postal records | Add `compliance_records`, route validation and campaign UI: source, collection date, region/entity class, customer basis/consent reference, notice, sender identity/postal details; block missing mandatory fields | Customer terms/UI and legal-policy configuration | Campaign export/audit; suppression survives contact deletion/reimport; region policies tested | Legal review required; feature flag policies by jurisdiction | L |

## Phase 3 — operational reliability

| Work item | Current file/module and behavior | Proposed behavior and reason | Dependencies / migration | Tests and acceptance | Compatibility / rollout / risk | Size |
|---|---|---|---|---|---|---|
| Durable job/outbox model | `campaignScheduler.ts` process timer and optimistic enrollment claim | In transaction create immutable send job/outbox; scheduler publishes/claims; separate provider workers use leases and `SKIP LOCKED` | `send_jobs`, `send_attempts`, `outbox_events`; DB claim functions | crash at every boundary, multi-worker concurrency, lease expiry, cancellation tests | Dual-write current activity/job, shadow worker, then cut over one tenant | XL |
| Provider retry/DLQ | Uniform indefinite five-minute retries | Error taxonomy, Retry-After, exponential jitter, max attempts, permanent rejection, unknown reconciliation and visible DLQ | attempts/error tables; adapter mappings | 4xx/5xx/429/auth/policy/network matrices; no provider call after terminal state | Conservative unknown/manual path can delay mail but prevents duplicate | L |
| Inbound worker pipeline | IMAP directly parses/inserts; PlusVibe routes differ | Durable provider event intake, normalized message, classification workers, suppression/enrollment actions; idempotent at each stage | `provider_events`, inbound/delivery tables | duplicate/out-of-order/malformed events, poison message quarantine | Dual-write canonical tables; current UI reads compatibility view | XL |
| Observability | Pino logs only; sensitive fields present | Structured redacted logs, OpenTelemetry/request/job IDs, metrics/alerts for sends, auth, throttles, bounces, sync lag, watches, queue and identity | Metrics backend and alert routes | log-secret scans; alert fixtures; tenant cardinality controls | Add before removing old logs; reduce content logging immediately | L |
| Health/admin dashboard | No explainable mailbox health | Reason-code state with evidence, scope, action and remediation; controls for pause/reconnect/revalidate/reconcile | APIs and frontend pages | Each automatic pause is visible/audited; no opaque score | Read-only first, controls after RBAC review | L |
| Audit and privacy lifecycle | Only admin audit; public attachment storage/no deletion path | Append-only mailbox/provider/send/compliance audit; private content storage, configurable retention, export/deletion/revocation jobs | Audit/retention tables and storage migration | tenant export/delete, legal-hold exception, signed URL expiry, cross-tenant tests | Deletion jobs dry-run and report before enforcement | L |
| Environment separation | `.env.example:10-12` says environments share Supabase | Separate Supabase/Nango/OAuth/Pub/Sub/storage/key resources; anonymized staging fixtures | Infrastructure provisioning and migration | staging action cannot read/write production; secret/environment assertions at boot | Highest operational migration risk; backup/restore and rehearsed cutover | XL |
| Dependency and test baseline | No automated tests; audit findings | Add test runner, lockfile update policy, SCA/secret scanning, CI build/test/migration checks; triage all audit findings by reachability | CI environment and test tenants | clean required checks; documented accepted residual findings | Upgrade incrementally; avoid unrelated major versions in safety changes | L |

## Phase 4 — optional enhancements

| Enhancement | Current/affected module and proposed behavior | Reason / dependency / migration | Tests and acceptance | Compatibility / rollout risk | Size |
|---|---|---|---|---|---|
| Controlled ramp assistant | Extend new `mailboxHealth.ts`, `rateLimitService.ts` and health UI; suggest/automate only bounded increases from real healthy sends | Safer alternative to warmup; depends on stable health/counter history; add ramp-decision history | Replays of health histories never exceed profile; no fake messages generated | Suggestions first, bounded automation later; rollback disables automation | M |
| Customer custom tracking domains | Replace optional shared behavior in `server/src/lib/mailTracking.ts`/`routes/tracking.ts` with branded HTTPS domains, DNS/TLS ownership proof and tenant binding | Only for explicit tracking opt-in; add `tracking_domains` and certificates/provider references | Cross-tenant host, dangling DNS, cert expiry and redirect-safety tests | Direct-link default remains; legacy links resolve during retention window | L |
| Advanced reply classification | Extend new inbound classifier and current `email_replies` read models with explainable multilingual intent/confidence and human correction | Depends on mature labeled data and privacy review; add classification revisions/feedback | Fixed multilingual evaluation set, confidence calibration and correction audit | Observe-only first; deterministic suppression rules always take precedence | L |
| Inbox-placement diagnostics | Extend diagnostic/header analysis workers with controlled seed inboxes; never promise placement | Provider terms/privacy review; diagnostic result storage | Seed isolation, header capture, auth interpretation and retention tests | Admin/test only before customer UI; easy feature-flag removal | L |
| Customer deliverability guidance | Extend new health APIs and settings/campaign pages with reason-specific exportable remediation | Depends on health evidence; no score migration | Each reason maps to evidence/action/source and accessible UI | Read-only guidance; no automatic DNS changes | M |
| POP3 legacy adapter | Add `providers/pop3` behind generic connection UI; inbound-only UIDL/polling with explicit limitations | Only after mature SMTP/IMAP abstraction; add POP cursor/capabilities | UIDL instability, reconnect, duplicate, deletion and no-Sent behavior | Disabled by default; cannot advertise guaranteed stop-on-reply | M |
| ESP adapter | Add `providers/esp` as a separate authenticated-domain product mode, not a mailbox alias | For opted-in bulk/transactional use; new domain auth/event tables and compliance mode | SPF/DKIM/return-path onboarding, webhook idempotency, bounce/complaint and separation tests | No automatic migration from connected mailboxes; legal/product approval | L |

Own MTA, artificial warmup pools, rotating proxies, domain rotation, and provider-limit evasion are explicitly outside the roadmap.

## New service/module map

Preserve existing import boundaries while moving toward:

```text
server/src/lib/mail/
  canonicalMessageBuilder.ts
  identityService.ts
  suppressionService.ts
  sendJobService.ts
  rateLimitService.ts
  errorClassifier.ts
  providers/
    microsoft/{connection,identity,send,sync,subscriptions}.ts
    gmail/{connection,identity,send,sync,watches}.ts
    smtp/{connection,identity,send,imapSync}.ts
  inbound/{normalize,correlate,classifyDsn,classifyReply}.ts
  health/{domainHealth,mailboxHealth,rawHeaderAnalysis}.ts
server/src/workers/
  schedulerWorker.ts
  microsoftSendWorker.ts
  gmailSendWorker.ts
  smtpSendWorker.ts
  inboundEventWorker.ts
  mailboxSyncWorker.ts
  subscriptionRenewalWorker.ts
  tokenHealthWorker.ts
  dnsHealthWorker.ts
  reconciliationWorker.ts
server/src/routes/
  mailboxConnections.ts
  providerCallbacks.ts
  graphNotifications.ts
  gmailNotifications.ts
  unsubscribe.ts
  mailboxHealth.ts
  adminEmailOperations.ts
```

Existing `server/src/lib/mail/router.ts`, `emailSender.ts`, `smtpAdapter.ts`, `imapInbound.ts`, `campaignEngine.ts`, and `routes/email-replies.ts` should become compatibility callers and then be reduced/retired after measured cutover. Do not replace them all in one release.

## Migration sequence

1. Normalize migration numbering and capture a schema snapshot.
2. Add mailbox identity/connection capability/health tables and backfill every current connection as `validation_required`.
3. Add suppressions/unsubscribes/compliance records; backfill existing unsubscribed enrollments and known bounce statuses before enabling checks.
4. Add send jobs/attempts/sent messages/outbox/rate counters and provider event/inbound/bounce tables.
5. Add sync cursors, Graph subscriptions, Gmail watches and private attachment metadata.
6. Create compatibility views or dual-write fields consumed by existing campaign/reply UI.
7. Validate row counts, uniqueness, tenant isolation, encryption, and rollback exports before each cutover.

Every migration must have forward verification SQL and a rollback strategy. Additive migrations roll back by disabling new code, not dropping captured evidence. Data transformations write backups/audit counts. Destructive cleanup occurs only after at least one stable release and verified restore.

## API and UI changes

New/changed API behaviors:

- connection intent creation and provider callback finalization;
- list/validate/select authorized identities;
- diagnostic test send and raw-header result submission/analysis;
- idempotent compose/reply/campaign send status;
- mailbox/domain health and exact pause reasons;
- RFC 8058 unsubscribe POST plus confirmation UI;
- provider notification endpoints and authenticated event intake;
- admin pause/reconnect/revalidate/reconcile/audit endpoints.

UI changes:

- separate Microsoft 365 business from consumer Outlook and explain limitations;
- Gmail OAuth first; legacy app-password flow behind advanced/legacy copy;
- identity picker contains only provider-verified identities and labels shared/alias permissions;
- replace provider ceiling claims with current product budget, consumed/reserved count, health/ramp state, and source link;
- tracking off by default; direct-link explanation and custom-domain requirement;
- health panel shows reason/evidence/action, not a deliverability score;
- campaign activation lists every blocking check and remediation.

## Production acceptance criteria

- Microsoft primary, Microsoft shared Send As, Gmail primary, Gmail verified alias, and generic SMTP each pass raw-header inspection at Gmail and Outlook diagnostic recipients.
- The Microsoft on-behalf test intentionally using Send on Behalf is detected and blocked; Send As shows no delegate identity.
- Every external call maps to one immutable job and attempt. Replayed queue events, API requests, webhook events and worker crashes do not issue another provider call. Ambiguous calls enter reconciliation/manual review.
- Global suppression wins over enrollment/import/concurrent worker actions; one-click and reply opt-outs take effect immediately.
- Hard bounces suppress; temporary bounces back off; policy/authentication failures pause the correct scope.
- Concurrent campaigns cannot exceed the shared mailbox/domain/tenant budget.
- Graph and Gmail sync recover from missed notifications and expired cursors without duplicate records.
- Secrets and content are absent from logs; tokens revoke on disconnect; storage and database isolation tests prevent cross-tenant access.
- Staging and production use separate infrastructure and OAuth/provider configurations.
- All tests in `07-test-and-diagnostic-playbook.md` pass and evidence is attached to the release record.

## Top five engineering priorities

1. **Prove and enforce sender identity** for Microsoft, Gmail and SMTP; block every unexpected `Sender`/`From` result.
2. **Create durable suppression and bounce handling** checked immediately before every send.
3. **Replace send-before-commit and in-process retries with a send ledger, outbox, leases, reconciliation and idempotency.**
4. **Implement provider-native OAuth and inbound sync**: Graph delegated + delta/subscriptions, Gmail API + history/watch, SMTP/IMAP only as fallback.
5. **Add conservative distributed limits and explainable readiness/health gates**, with tracking off and environments isolated.

## Final recommendation: direct answers

1. **Is the current implementation safe enough?** No. It is suitable for restricted staging diagnostics, not additional customers or unattended production sequences.
2. **What likely caused “on behalf of”?** The recipient saw a different actual sender and visible From. The strongest hypothesis is a consumer Outlook/generated transport identity connected through Microsoft `/common`, with the business address used as an alias/profile From. If the generic SMTP adapter sent the test, its allowed username/From mismatch is an equally direct cause. Raw original, adapter/job log, Graph `/me`/token account type, Sent item and Exchange trace are needed for certainty.
3. **What must be fixed first?** Authorized identity validation, global unsubscribe/hard-bounce suppression, durable/idempotent sending with ambiguous-outcome reconciliation, conservative distributed limits, token/credential lifecycle, and raw-header readiness gates.
4. **Microsoft Graph or SMTP OAuth?** Graph delegated OAuth for Microsoft 365. Use SMTP OAuth only for a documented edge case. Shared mailboxes require an explicit Graph Send As capability and test.
5. **Gmail API or SMTP OAuth?** Gmail API delegated OAuth. Use verified `sendAs`, and complete the verification/security work required for read synchronization. SMTP OAuth is fallback only.
6. **Generic providers?** Authenticated SMTP outbound plus IMAP inbound, strict TLS and exact From authorization. OAuth where supported.
7. **POP3?** Do not support initially. It can be a later inbound-only degraded fallback when IMAP is unavailable; it never sends mail.
8. **Dedicated/“clean” IPs?** No. Microsoft/Google/provider outbound IPs deliver recommended-path mail. A stable application egress is good security/operations but does not improve Graph/Gmail placement. A low-volume dedicated MTA IP can be worse.
9. **Build an SMTP/MTA?** No for connected mailboxes. If a future product needs opted-in bulk/transactional delivery, integrate an ESP as a separate mode before considering an MTA.
10. **Is no warmup acceptable?** Yes. Do not build fake warmup traffic. Build readiness checks and controlled real-sending ramps.
11. **Initial product volumes?** For a verified, healthy, established business mailbox, default to 20 automated sequence emails/day and ramp by at most 5 after each three healthy active business days to a normal cap of 50/day. New, inactive, consumer and unknown SMTP identities use the lower profiles in `05-mailbox-onboarding-and-safety-policy.md`. These are product safety limits, not provider limits.
12. **Top five priorities?** The five items immediately above are the engineering order of operations.
