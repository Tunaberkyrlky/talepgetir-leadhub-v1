# Connected-mailbox provider comparison

## Recommended order

1. Microsoft 365: Microsoft Graph delegated OAuth per mailbox.
2. Gmail / Google Workspace: Gmail API delegated OAuth per mailbox.
3. Other providers: authenticated SMTP outbound plus IMAP inbound, with OAuth where supported.
4. POP3: omit initially; degraded inbound legacy fallback only.
5. Own MTA: do not use for connected-mailbox sending.
6. ESP: use only for a distinct opted-in bulk/transactional product requirement, not to impersonate a connected Microsoft/Google mailbox.

## Comparison matrix

| Option | Recipient-facing sender infrastructure / IP | Identity and authentication alignment | Security | Reply and bounce synchronization | Complexity / operational burden | Suitability |
|---|---|---|---|---|---|---|
| Microsoft Graph delegated | Exchange Online MTA/IP; TG Core is HTTPS API client | Excellent for authenticated primary mailbox. Explicit other-mailbox `from` requires Graph permission plus Exchange Send As/Send on Behalf. Exchange controls envelope, Return-Path and DKIM | Modern OAuth, MFA/Conditional Access compatible, least-privilege per user; refresh-token/grant lifecycle required | Graph notifications + delta for Inbox/Sent. Shared-mailbox notification limitations require special design. Bounces arrive as mailbox messages/trace events and need classification | High initial implementation; low transport maintenance | **Recommended for Microsoft 365** |
| Microsoft SMTP AUTH with OAuth | Exchange Online MTA/IP; TG Core is SMTP submission client | Good only when authenticated identity is authorized for exact From. Provider may reject/rewrite/delegate mismatches | OAuth is acceptable, but protocol scope and tenant SMTP AUTH settings add complexity; broader legacy protocol surface | Requires IMAP/Graph for inbound and Sent reconciliation; SMTP response alone does not provide mailbox history | Medium send implementation, high lifecycle/troubleshooting | Fallback where Graph cannot meet a documented need; not default |
| Microsoft SMTP username/password | Exchange Online MTA/IP | Same identity constraints, with greater rewrite/on-behalf risk if code overrides From | Basic authentication retirement/disablement, credential theft and tenant policy make it unsuitable | Separate IMAP/Graph required | Superficially simple, operationally brittle | **Do not build as a Microsoft 365 strategy** |
| Microsoft relay/connector | Exchange Online/protected relay depending connector; configured source IP/certificate | Can be correct for organization-owned apps/devices when tenant accepted domains/connectors are explicitly configured | Admin-managed IP/cert trust; not per-user OAuth; broad relay abuse risk | No user mailbox read by itself; Sent behavior and attribution differ | High customer-admin setup; fixed egress and connector operations | Not suitable for self-service per-mailbox sequencing |
| Microsoft High Volume Email | Microsoft HVE infrastructure for documented internal recipients | Microsoft tenant identity, but not a user-connected external sequence path | Admin/tenant feature | Not a general reply sync design | Provider-specific preview/feature lifecycle | **Not relevant**; external recipient support was removed in 2025 |
| Gmail API delegated | Gmail/Workspace MTA/IP; TG Core is HTTPS client | Excellent for primary or verified `sendAs`; Gmail controls envelope and DKIM | Modern OAuth; `gmail.send` sensitive; read scopes restricted and can require verification/security assessment | Gmail watch + Pub/Sub + history; Gmail message/thread IDs; DSNs still require parsing | High initial verification/sync work; low transport maintenance | **Recommended for Gmail/Workspace** |
| Gmail SMTP with OAuth | Gmail MTA/IP; TG Core is SMTP client | Good for provider-authorized From; otherwise Gmail may rewrite/show alternate sender/via | XOAUTH2 avoids passwords but protocol access often needs broad restricted scope | Requires IMAP or Gmail API for inbound/history; SMTP has weaker correlation | Medium implementation; more protocol and scope burden than Gmail API | Fallback, not default |
| Gmail SMTP with app password | Gmail MTA/IP | Usually native for primary account; aliases still require Gmail configuration | Google does not recommend app passwords; requires 2SV, may be admin-disabled, revoked on password change | IMAP app password required separately/logically; polling/IDLE | Low initial code, high support/security debt | Legacy only, capped and clearly labeled |
| Google service account + domain-wide delegation | Gmail/Workspace MTA/IP | Native when impersonating an authorized user | Customer super-admin authorizes tenant-wide scopes; high blast radius and key/WIF complexity | Gmail API watch/history possible under delegated identity | High customer-admin and security burden | Not appropriate for ordinary per-mailbox connections |
| Generic SMTP + IMAP | Customer/provider MTA/IP; TG Core submits SMTP and reads IMAP | Provider-dependent. Must validate exact From/alias and received authentication. Provider controls signing/return path | OAuth preferred; passwords encrypted only when unavoidable; strict TLS/SSRF/cert validation | IMAP IDLE/poll, Sent discovery, UIDVALIDITY, DSN parsing; quality varies | High interoperability and support burden | **Recommended fallback** |
| POP3 + SMTP | Provider MTA/IP for send; POP3 downloads inbound | SMTP identity rules unchanged | Usually legacy auth; limited server state | No folders/Sent/thread flags; UIDL quality varies; polling only | Poor reliability despite simple protocol | Legacy inbound only if IMAP truly unavailable |
| TG Core own MTA | TG Core-owned/shared/dedicated MTA IP | Requires customer SPF authorization, TG DKIM signing and aligned return path; Microsoft/Google domain From can fail DMARC or violate provider policy | TG owns DKIM keys, relay abuse prevention and full mail security | TG owns DSNs/feedback but still lacks connected mailbox replies unless separately synced | **Very high:** DNS/rDNS, reputation, queues, TLS, feedback loops, abuse desk, blocklists, 24/7 ops | **Do not use for connected mailboxes** |
| Third-party ESP | ESP MTA/shared or dedicated IP | Correct only after customer domain authentication and return-path/DKIM setup; not the same as sending through a user mailbox | API keys/OAuth, vendor controls and data processing | ESP webhooks are strong for delivery/bounces; human replies need reply routing or mailbox sync | Medium integration plus vendor and domain onboarding | Use for opted-in bulk/transactional path, not current use case |

## Microsoft choices in detail

### Graph delegated access

**Permissions.** `Mail.Send` is the least delegated permission for the signed-in mailbox. Reading bodies/replies generally needs `Mail.Read`; subscription permission follows the watched resource. Sending another user/shared mailbox requires `Mail.Send.Shared` plus Exchange Send As or Send on Behalf. Application `Mail.Send` is organization-wide and not the default.

**Identity.** `/me/sendMail` without an explicit `from` should send as the authenticated mailbox. A shared identity is a different capability: TG Core explicitly sets `from`, checks permission, and rejects a Send-on-Behalf result if Send As is required. Microsoft’s official distinction is documented in [send from another user](https://learn.microsoft.com/en-us/graph/outlook-send-mail-from-other-user).

**Security and consent.** Per-mailbox delegated OAuth works with MFA and Conditional Access. Customer policies may require admin consent or block user consent. A multi-tenant Entra app must validate issuer/tenant/account, support consent revocation, and avoid assuming `/common` means Microsoft 365.

**Scaling.** Microsoft retains outbound MTA operations; TG Core handles throttling, subscriptions/delta, token health and per-mailbox policy. Graph’s `202` needs Sent reconciliation.

### SMTP AUTH OAuth

OAuth improves credential security but does not fix an unauthorized From. SMTP AUTH can be disabled per organization/mailbox and is a legacy protocol surface. Inbound still needs Graph or IMAP. It is useful only when a real provider-specific requirement makes Graph unsuitable; it should not be selected to chase different IP reputation, because Exchange Online still performs outbound delivery.

### Application permission

Application permission is suitable for a customer-controlled internal integration where an administrator intentionally grants and scopes unattended access. In a multi-customer sequencer it creates excessive default privilege and consent friction. If offered to a large enterprise, use a separate enterprise integration with Exchange Application RBAC, tenant-specific app/consent, strong audit and explicit mailbox scope.

### Relay/connector and own SMTP

Connectors are for organization-administered devices/apps and require fixed IP/certificate/accepted-domain configuration. They do not establish per-user OAuth or native reply sync. An own SMTP server using a Microsoft-domain `From` is worse: without customer DNS/connector authorization it breaks identity/authentication; with authorization it still transfers reputation and operational responsibility to TG Core.

## Gmail choices in detail

### Gmail API delegated access

`gmail.send` is a sensitive send-only scope. Reading/synchronizing needs a restricted Gmail scope and can trigger Google verification/security-assessment obligations when server-side data is handled. TG Core must complete that program before promising inbox sync. Verified Gmail `sendAs` identities are the only alternate From choices. Pub/Sub notifications trigger history synchronization; watch renewal and recovery polling are mandatory.

Gmail API and Gmail SMTP both ultimately use Gmail outbound IP infrastructure. API is preferred because it gives provider message/thread IDs, settings/alias APIs, clearer errors and provider-native history.

### SMTP OAuth and app passwords

SMTP OAuth still uses Gmail transport but usually requires broader protocol access and leaves inbound synchronization to IMAP. App passwords add a reusable secret and are unavailable under many security postures. Neither mode should be described as having a deliverability advantage over Gmail API merely because it is “SMTP.”

### Domain-wide delegation

Domain-wide delegation can impersonate users only after each customer Workspace super administrator authorizes scopes. It is an enterprise tenant integration, not a substitute for a clean per-user OAuth design. Keyless workload identity can reduce static-key risk but not tenant-wide authorization blast radius. Do not require it for small mailbox connections.

Gmail user-to-user mailbox delegation is a Gmail UI/mailbox permission; it does not automatically let TG Core reuse one user’s OAuth token as another user. TG Core still needs a token/grant whose subject is authorized for the accessed mailbox, or a deliberately administered domain-wide delegation design. Alternate From remains governed by Gmail `sendAs` verification.

### Generic/own SMTP with a Workspace From

If mail does not pass through Gmail, Google will not automatically sign or deliver it. The customer must explicitly authorize the other sender in SPF, configure aligned DKIM and perhaps a custom return path. Even then, it is no longer Gmail mailbox transport and may not appear in Sent/thread history. Routing it through TG Core’s MTA solely to use “clean IPs” is not recommended.

## Protocol roles

- **SMTP** submits outbound mail. OAuth/password is the authentication method, not the sending protocol’s replacement.
- **IMAP** synchronizes inbound and Sent folders, flags, UIDs and mailbox state.
- **POP3** downloads inbound messages; it does not send. A product description saying an account is “connected through POP/IMAP for sending” is incorrect.
- **Provider APIs** can replace SMTP and IMAP with provider-native send/sync operations.

## IP questions answered

### Would a clean application-server IP improve Graph/Gmail API deliverability?

No, not directly. The app IP makes the HTTPS API request; Exchange Online or Gmail connects to the recipient from provider outbound IPs. Stable reputable application egress is still good for API security, Conditional Access, allowlisting, incident response, and avoiding provider abuse suspicion.

### Would routing Microsoft or Gmail mail through TG Core’s own clean IP help?

No by default, and it often makes things worse. It changes the delivery MTA, can break SPF/DKIM/DMARC, loses native Sent/thread behavior, and starts a new low-volume IP reputation with no history. “Clean” means only no known bad history; it is not positive reputation.

### Where do IPs matter?

- **Application/API client IP:** provider security/abuse/allowlist context.
- **SMTP submission client IP:** visible to submission provider and sometimes trace headers; not normally the recipient-facing SPF IP.
- **Recipient-facing MTA/relay IP:** rDNS, IP reputation, blocklists and SPF connection checks; Microsoft/Google/provider owns it in the recommended architecture.
- **Dedicated IP:** one sender controls reputation but must sustain consistent legitimate volume and operations.
- **Shared IP:** provider pools aggregate reputation and can suit low volume when the provider manages abuse.

At TG Core’s volume, provider shared outbound pools are generally safer than a cold dedicated IP. Generic provider quality still matters and should be diagnosed from headers and policy, not marketing claims.

### Proxies and fixed egress

Use stable data-center egress and TLS. Do not use rotating/residential proxies, IP hopping, or identity/domain rotation. Residential routing raises security/abuse concerns and does not replace recipient-facing provider IP reputation. A fixed egress can satisfy customer allowlists but must never be marketed as an inbox-placement tool.

## When an own MTA or ESP would make sense

An MTA becomes rational only if TG Core intentionally becomes an email delivery service with authenticated customer domains, material steady opted-in volume, staff and systems for deliverability/abuse, and a product that no longer promises sends from a provider mailbox. Responsibilities include rDNS/HELO, IP allocation/reputation, SPF/DKIM/DMARC/ARC, return-path domains, TLS/MTA-STS, queues and retry semantics, feedback loops, DSNs, complaint/unsubscribe enforcement, blocklist remediation, key rotation, capacity, security and 24/7 incident response.

An established ESP is preferable to building that stack when a future customer needs opted-in bulk or transactional mail. It should be a separate provider/product mode with domain authentication and appropriate consent; it must not forge an existing Microsoft/Gmail address.

## Sequencer-vendor evidence boundary

Public documentation confirms connection patterns but not every internal transport route:

- Instantly publicly documents Microsoft OAuth, Google connection methods and generic SMTP/IMAP.
- Smartlead publicly documents Microsoft OAuth while some setup instructions also require SMTP/IMAP enablement.
- Apollo publicly documents Google/Microsoft OAuth and custom IMAP/SMTP mailbox connections.

From those pages it is valid to conclude that OAuth may authorize either provider APIs or OAuth-capable mail protocols, and that generic accounts use their provider’s SMTP/IMAP. It is **not** valid to assert that a named vendor always uses Graph, always uses SMTP, owns a particular delivery IP, or uses a specific relay without its technical documentation or raw headers. The architectural conclusion remains: if submission is to Microsoft/Google/provider infrastructure, that provider normally supplies the recipient-facing MTA/IP; if a vendor relays through its own/ESP MTA, headers and DNS will reveal a different route.

## Final selection

| Customer case | Selection | Reason |
|---|---|---|
| Microsoft 365 user mailbox | Graph delegated OAuth | Best security, native identity/Sent, provider transport and sync APIs |
| Microsoft shared mailbox | Graph delegated plus explicit verified Send As | Correct shared identity without delegate display; additional permission/test required |
| Personal Outlook | Manual/limited support only after identity diagnostic | `/common` can connect it, but it is not a business M365 tenant and aliases can create the observed incident |
| Gmail/Workspace | Gmail API delegated OAuth | Native transport, verified sendAs, message/thread/history APIs |
| Generic provider | SMTP + IMAP with strict TLS and identity test | Necessary interoperability fallback |
| POP-only inbound | Postpone; degraded legacy mode if justified | Insufficient mailbox semantics |
| Need opted-in bulk/transactional | Separate ESP mode | Different product and authentication model |
| Connected mailbox outreach | Never own MTA | Adds risk without benefit at low volume |
