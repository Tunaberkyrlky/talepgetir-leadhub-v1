# Deliverability research and provider requirements (2026)

**Research date:** 10 July 2026. Provider rules change; links below are the controlling sources and should be rechecked quarterly. “Official” means a provider, standards body, or regulator published it. “Recommendation” means TG Core’s deliberately more conservative product policy, not an official account limit.

## Executive conclusions

1. A connected-mailbox product should let Microsoft, Google, or the customer’s SMTP provider remain the recipient-facing outbound MTA. TG Core’s application IP does not replace provider reputation when Graph or Gmail API is used.
2. A low daily count does not exempt a sender from accurate identity, SPF or DKIM authentication, TLS, valid DNS, RFC formatting, complaint control, and an effective opt-out. Gmail’s and Yahoo’s bulk-only additions should still be implemented because sequences are commercial mail and volume can aggregate by domain.
3. DMARC evaluates alignment with the RFC 5322 `From` domain. SPF authenticates the SMTP envelope domain; DKIM authenticates the `d=` signing domain. Passing SPF or DKIM without alignment is not a DMARC pass.
4. Provider ceilings are abuse ceilings, not safe outreach targets. TG Core must enforce much lower product limits based on mailbox age/use, domain health, bounces, complaints, and provider signals.
5. In May 2026, DMARC was standardized in [RFC 9989](https://www.rfc-editor.org/info/rfc9989/), which obsoletes RFC 7489. Provider help pages may still cite the older RFC while their operational requirements remain applicable.

## Official Microsoft requirements and behavior

### Identity and Graph

- Microsoft Graph `sendMail` supports `POST /me/sendMail` and `/users/{id}/sendMail`, requires `Mail.Send` for a normal delegated send, saves to Sent Items by default, and returns only `202 Accepted`. Microsoft explicitly states that `202` is acceptance for processing, not completed delivery ([Microsoft Graph `sendMail`](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0), page updated 2025-07-23 when reviewed).
- Sending from another mailbox with a delegated user token requires Graph `Mail.Send.Shared` plus Exchange mailbox permission. With **Send on Behalf**, Graph/Exchange exposes the signed-in delegate as `sender` and the represented mailbox as `from`; recipients can see “on behalf of.” With **Send As**, `sender` and `from` are the same. The application sets `from` and Graph derives `sender` from the actual Exchange rights ([send mail from another user](https://learn.microsoft.com/en-us/graph/outlook-send-mail-from-other-user), updated 2024-11-07).
- Microsoft says Graph cannot currently enumerate all mailboxes for which the authenticated user has delegation rights on that page. TG Core must therefore validate a requested identity by an explicit permission/test-send workflow, not assume it from an alias string.
- For normal connected-mailbox use, delegated authorization is least privilege. Application `Mail.Send` permits organization-wide sending when administrator-consented and should not be the default for a multi-tenant sequencer ([Microsoft Graph permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference)). Where application access is unavoidable, scope it with Exchange Online Application RBAC; older Application Access Policies are a legacy mechanism ([Application Access Policies](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-access-policies)).

### OAuth, SMTP AUTH, and inbound sync

- The Microsoft identity platform supports authorization-code flow with PKCE; public clients must not hold secrets, and confidential web clients must protect their secret and redirect URI ([authorization-code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)). Multi-tenant apps must deliberately handle tenant/account type, consent, admin restrictions, Conditional Access, MFA, revocation, and disabled users.
- SMTP/IMAP OAuth uses resource-specific scopes such as `https://outlook.office.com/SMTP.Send`, `IMAP.AccessAsUser.All`, and `offline_access` ([OAuth for IMAP, POP and SMTP](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth)). Basic authentication has been removed from many Exchange Online protocols and Microsoft’s SMTP AUTH Basic retirement schedule is documented on the [Basic Authentication deprecation page](https://learn.microsoft.com/en-us/exchange/clients-and-mobile-in-exchange-online/deprecation-of-basic-authentication-exchange-online). The exact current enforcement state must be checked before each release.
- Microsoft recommends modern Graph APIs for Exchange Online development. Graph message change notifications plus delta queries are the native synchronization pattern ([change notifications](https://learn.microsoft.com/en-us/graph/change-notifications-overview), [message delta](https://learn.microsoft.com/en-us/graph/delta-query-messages), [lifecycle events](https://learn.microsoft.com/en-us/graph/change-notifications-lifecycle-events)). Notifications are hints; the delta cursor is the recovery source of truth.
- Subscriptions to the signed-in user’s messages can use delegated permissions. Microsoft documents that delegated shared-mail scopes do not support change-notification subscriptions on shared/delegated folders; application permission is needed for that pattern ([create subscription](https://learn.microsoft.com/en-us/graph/api/subscription-post-subscriptions?view=graph-rest-1.0)). This is an important limitation if TG Core later promises real-time shared-mailbox sync.

### Exchange Online limits

The [Exchange Online limits](https://learn.microsoft.com/en-us/office365/servicedescriptions/exchange-online-service-description/exchange-online-limits) page publishes mailbox and recipient-rate ceilings, which vary by service, tenant, license, account state, and Microsoft policy. It also says Exchange Online is not intended as a bulk-mail platform and directs legitimate commercial bulk senders toward specialized providers. These values must not be copied into TG Core as “safe daily outreach limits.” Current code/UI text that implies a universal Outlook limit of 10,000 is misleading.

### Outlook.com high-volume sender rules

Microsoft’s [Outlook high-volume sender announcement](https://techcommunity.microsoft.com/blog/microsoftdefenderforoffice365blog/strengthening-email-ecosystem-outlook%E2%80%99s-new-requirements-for-high%E2%80%90volume-senders/4399730) defines high volume as more than 5,000 messages per day to Outlook.com consumer domains and requires SPF, DKIM, DMARC, valid sender identity, list hygiene, unsubscribe, and consent-oriented practices. Enforcement with `550 5.7.515` began in May 2025. That threshold is a bulk classification, not permission to ignore authentication below it.

Microsoft High Volume Email is not a connected-mailbox solution: Microsoft documents it as an internal-mail feature, and external recipient support was removed in June 2025 ([High Volume Email for Microsoft 365](https://learn.microsoft.com/en-us/Exchange/mail-flow-best-practices/high-volume-mails-m365)).

## Official Google and Gmail requirements

### Sender requirements

Google’s [Email sender guidelines](https://support.google.com/mail/answer/81126?hl=en) require senders to personal Gmail accounts to:

- authenticate with SPF or DKIM;
- have valid forward and reverse DNS for sending IPs;
- use TLS;
- format messages according to Internet Message Format standards;
- keep user-reported spam below 0.3%; and
- avoid deceptive identity/content and unwanted mail.

For senders above Google’s bulk threshold (approximately 5,000 messages in a day to personal Gmail accounts), Google additionally requires both SPF and DKIM, DMARC with at least `p=none`, alignment of the organizational `From` domain with SPF or DKIM, and one-click unsubscribe for marketing/subscribed messages plus a visible body opt-out. Google aggregates messages from the same primary domain and treats a sender that has met the threshold as a bulk sender thereafter; consult the linked FAQ rather than attempting to split volume across subdomains ([sender guideline FAQ](https://support.google.com/mail/answer/14229414?hl=en)).

The 0.3% figure is a provider boundary, not a target. TG Core should warn far earlier and treat every complaint seriously at low denominators.

### “Via,” mailed-by, and signed-by

Gmail says it may display “via” when the domain that sent/authenticated the message differs from the visible `From`. Its remediation is to authenticate the sending service in SPF and/or sign with DKIM associated with the `From` domain ([Gmail “via” explanation](https://support.google.com/mail/answer/1311182?hl=en-GB)). In “Show original”:

- **mailed-by** generally reflects the SPF/envelope domain;
- **signed-by** reflects a passing DKIM signing domain;
- DMARC asks whether at least one of those authenticating domains aligns with the organizational domain in `From`.

`via` is a UI signal rather than the DMARC protocol itself. A distinct RFC `Sender` can also make a delegate visible even if authentication passes.

### Gmail OAuth and APIs

- `gmail.send` is a **sensitive** scope. Read/modify/metadata scopes are **restricted**; if restricted data is transmitted through or stored on servers, Google states that a security assessment may be required ([Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), updated 2026-06-03).
- External apps need an accurate OAuth consent screen, verified domains, least-privilege scopes, secure redirect handling, refresh-token protection and, where applicable, Google verification. Internal apps are limited to one Workspace organization. See [OAuth web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server) and [OAuth best practices](https://developers.google.com/identity/protocols/oauth2/resources/best-practices).
- Gmail API sends an RFC 2822/MIME message using `users.messages.send` ([API reference](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send)). An alternate `From` must be a configured and verified Gmail `sendAs` identity; aliases can be enumerated through Gmail settings ([aliases and signatures](https://developers.google.com/workspace/gmail/api/guides/alias_and_signature_settings)).
- Gmail watch publishes mailbox changes through Google Cloud Pub/Sub. Google requires watch renewal at least every seven days and recommends daily renewal; notifications can be delayed or dropped, so history synchronization and periodic recovery are mandatory. Notifications are limited to one event per second per watched user ([Gmail push notifications](https://developers.google.com/workspace/gmail/api/guides/push)).
- SMTP/IMAP can use XOAUTH2, but the full mail scope commonly needed for protocol access is restricted and broader than provider-specific API scopes ([Gmail XOAUTH2](https://developers.google.com/workspace/gmail/imap/xoauth2-protocol)).
- App passwords are explicitly not recommended, require two-step verification, are unavailable under some security policies, and are revoked after a Google password change ([Google app passwords](https://support.google.com/accounts/answer/185833?hl=en)). They are a legacy fallback, not the default architecture.
- Service accounts with Workspace domain-wide delegation require a customer super administrator to authorize scopes and create a high-impact tenant-wide trust. That is disproportionate for per-mailbox connected access and increases blast radius ([service accounts and domain-wide delegation](https://developers.google.com/identity/protocols/oauth2/service-account)).

Google’s [Workspace API User Data and Developer Policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy) also applies to Gmail API products. Product/legal review must confirm that the exact outreach model, recipient sourcing, consent/expectation, UI, and app verification representations comply; API access must never be treated as authorization to send unsolicited or abusive mail.

Google Workspace publishes account-dependent sending limits in [Gmail sending limits](https://support.google.com/a/answer/166852?hl=en). These are anti-abuse ceilings that can change and can be reduced or enforced differently. They are not TG Core product limits.

## Official Yahoo requirements

Yahoo’s [Sender Best Practices](https://senders.yahooinc.com/best-practices/) require all senders to authenticate with SPF or DKIM, maintain valid forward/reverse DNS, follow RFC message standards, and keep complaint rates below 0.3%. Bulk senders must use both SPF and DKIM, publish DMARC with alignment, provide RFC 8058 one-click and visible unsubscribe, honor opt-outs within two days, and avoid unwanted mail. Yahoo deliberately does not publish one universal bulk-volume threshold ([Yahoo Sender FAQ](https://senders.yahooinc.com/faqs/)).

Yahoo’s two-day opt-out expectation is stricter operationally than US CAN-SPAM’s ten-business-day legal ceiling. TG Core should suppress immediately, normally within seconds.

## Standards that control message identity and authentication

| Standard | Operational relevance |
|---|---|
| [RFC 5321](https://www.rfc-editor.org/info/rfc5321/) | SMTP `MAIL FROM`, delivery status, and final-MTA insertion of `Return-Path`; the originating application must not forge `Return-Path`. |
| [RFC 5322](https://www.rfc-editor.org/info/rfc5322/) | `From`, `Sender`, `Reply-To`, `Date`, globally unique `Message-ID`, threading headers, and header syntax. A distinct transmitting agent belongs in `Sender`. |
| [RFC 7208](https://www.rfc-editor.org/info/rfc7208/) | SPF authenticates the RFC 5321 envelope identity/HELO and has a ten-DNS-mechanism lookup limit. Multiple SPF records produce a permanent error. |
| [RFC 6376](https://www.rfc-editor.org/info/rfc6376/) | DKIM cryptographically signs selected headers/body and identifies a signing domain in `d=`. Providers—not TG Core—should normally apply DKIM at their MTA. |
| [RFC 9989](https://www.rfc-editor.org/info/rfc9989/) | Current DMARC protocol (May 2026): alignment and policy based on the RFC 5322 `From` domain; obsoletes RFC 7489. Aggregate and failure reporting are separated into RFC 9990 and RFC 9991. |
| [RFC 8058](https://www.rfc-editor.org/info/rfc8058/) | One-click unsubscribe uses `List-Unsubscribe-Post: List-Unsubscribe=One-Click` and an HTTPS `List-Unsubscribe` URL, with a DKIM-covered POST flow and no redirect. It is not a GET side effect. |
| [RFC 3464](https://www.rfc-editor.org/info/rfc3464/) | Machine-readable delivery status notifications and `message/delivery-status` fields for bounce classification. |
| [RFC 9051](https://www.rfc-editor.org/rfc/rfc9051.html) | IMAP4rev2 mailbox state, UID and UIDVALIDITY semantics. |
| [RFC 2177](https://www.rfc-editor.org/info/rfc2177/) | IMAP IDLE real-time notification extension; polling remains necessary as a recovery path. |

MTA-STS ([RFC 8461](https://www.rfc-editor.org/info/rfc8461/)) and TLS reporting ([RFC 8460](https://www.rfc-editor.org/info/rfc8460/)) protect inbound SMTP transport for the customer domain. They are valuable domain-health signals but do not repair sender alignment. BIMI is optional brand presentation, not an inbox-placement requirement ([BIMI implementation guide](https://bimigroup.org/implementation-guide/)).

## Official requirements versus conservative product policy

| Topic | Official provider requirement | TG Core conservative policy |
|---|---|---|
| Authentication | Gmail/Yahoo all-sender baseline: SPF or DKIM; bulk: SPF, DKIM and DMARC/alignment. Microsoft high-volume: SPF, DKIM, DMARC. | Require a passing, aligned DKIM result on a production test whenever the provider supports customer-domain DKIM; warn/block based on identity model, not merely DNS presence. Require DMARC at least `p=none` before campaigns. |
| Complaints | Gmail/Yahoo say below 0.3%. | Any complaint suppresses immediately. One complaint at low volume opens manual review; pause at 0.1% when at least 1,000 delivered messages provide a meaningful denominator. Never optimize to remain just below 0.3%. |
| Unsubscribe | Bulk Gmail/Yahoo marketing requires one-click plus visible opt-out; Yahoo asks honor within two days. CAN-SPAM applies to commercial mail regardless of bulk. | Include visible opt-out and RFC 8058 one-click on every automated marketing sequence; suppress atomically before acknowledging POST/reply. |
| Sending limits | Provider-specific ceilings vary by account, tenant, license and enforcement. | Start business mailboxes around 20 sequence emails/day, lower for unknown/new/inactive identities, and cap normal automatic ramp near 50/day. These are safety recommendations, not official limits. |
| DNS | Providers require valid DNS; sender-owned infrastructure requires forward/reverse DNS. | Check MX, SPF syntax/lookup count, DKIM evidence, DMARC, and domain resolution before activation. Do not require PTR from customers when Microsoft/Google own the outbound MTA. |
| TLS | Providers require or strongly expect TLS. | Require HTTPS/TLS for APIs and certificate-valid STARTTLS/TLS for SMTP/IMAP. Never expose a production “accept invalid certificate” switch. |
| Format | RFC 5322 formatting and non-deceptive headers. | Generate multipart text/HTML, unique IDs, sanitized headers, direct links, no fake `Re:`/`Fwd:`, and no first-touch attachments by default. |

## Low-volume deliverability factors

Bulk-only thresholds do not create a safe harbor. Low-volume mail can still be filtered because of:

- an unauthorized or confusing `From`/`Sender` combination;
- missing or unaligned customer-domain DKIM/DMARC;
- a new/inactive mailbox or domain, abrupt volume change, or provider throttling;
- invalid, scraped, purchased, role, catch-all, or old addresses;
- spam complaints and low recipient expectation;
- shared tracking-domain reputation, redirectors, URL shorteners, mismatched links, or newly registered linked domains;
- pixel tracking, complex HTML, large images, attachment-heavy first contact, hidden text, or malformed MIME;
- deceptive subjects, fake reply chains, over-personalization, or sensitive data;
- repetitive templates and identical bursts across many accounts;
- poor handling of bounces, opt-outs, out-of-office messages, and repeated unengaged recipients.

Engagement is a filtering signal in some provider systems, but there is no legitimate way to manufacture it. Real, relevant, expected mail sent gradually is safer than artificial warmup exchanges.

## Legal and product-compliance boundary

This section is engineering guidance, **not legal advice**. Rules vary by sender, recipient, product, country, entity type, and how addresses were sourced. TG Core and each customer need qualified counsel for their markets.

- The US FTC says CAN-SPAM covers commercial messages including B2B mail and is not limited to bulk. It requires accurate routing/header and subject information, advertisement disclosure, a valid postal address, a clear opt-out, honoring opt-out within ten business days, and monitoring vendors acting for the sender ([FTC CAN-SPAM guide](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business), updated 2023-08-14).
- EU ePrivacy Directive Article 13 sets consent/soft-opt-in rules for electronic direct marketing and leaves some treatment of other subscribers to national law ([Directive 2002/58/EC](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32002L0058)). B2B is not one uniform EU exemption; national implementation and the legal form of the recipient matter.
- GDPR legitimate interest is not automatic permission. An organization relying on it needs a documented legitimate-interest assessment covering purpose, necessity, balancing, reasonable expectations, data source/transparency, minimization, and the absolute right to object. The [EDPB legitimate-interest guidance](https://www.edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-12024-processing-personal-data-based-article-61f_en) and regulator guidance should be applied to the specific campaign.
- The UK ICO’s [B2B marketing guidance](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/business-to-business-marketing/) illustrates why entity type matters: corporate subscribers can differ from sole traders/partnerships, identity must not be concealed, an opt-out address is required, and personal-data law still applies to named business contacts. UK rules are not a substitute for EU-member-state review.

Required product records should include source URL/vendor and collection date, customer-stated purpose and audience, applicable region/entity category, lawful-basis/consent reference, first contact date, notice version, objections, and suppression provenance. TG Core must hard-enforce opt-out and identity accuracy even when the customer remains legally responsible for campaign content and recipient selection.

## Research labels for sequencer vendors

Public help pages document connection UX, not private delivery architecture:

- Instantly documents Google OAuth/app-password options, Microsoft OAuth, and other-provider SMTP/IMAP ([connection guide](https://help.instantly.ai/en/articles/6222224-how-do-i-connect-my-accounts-to-instantly), [Microsoft guide](https://help.instantly.ai/en/articles/6502917-how-to-connect-microsoft-365-accounts-to-instantly)).
- Smartlead documents Outlook OAuth and also instructs users to enable SMTP/IMAP in some Microsoft setup paths ([Outlook OAuth guide](https://helpcenter.smartlead.ai/en/articles/207-how-to-connect-outlook-email-account-via-oauth)).
- Apollo documents Gmail/Outlook OAuth and custom IMAP/SMTP mailbox linking ([Apollo mailbox guide](https://knowledge.apollo.io/hc/en-us/articles/4409127806093-Link-Your-Mailbox-to-Apollo-io)).

**Verified public fact:** these products connect provider mailboxes with OAuth and/or SMTP/IMAP.

**Architectural inference:** when a tool submits through Microsoft/Google APIs or authenticated provider SMTP, the provider’s outbound MTA and IP normally deliver to the recipient.

**Unverified:** the exact endpoint, relay, intermediate service, retry model, or IP route used for every vendor/account type cannot be inferred from an OAuth button. Raw headers and vendor technical documentation are needed.

## Source maintenance policy

- Recheck all provider guidance and OAuth scope classifications quarterly and before production launch.
- Record URL, retrieval date, and material page update date in a compliance-source registry.
- Treat provider-published numerical limits as dynamic configuration metadata, never constants in UI copy.
- Regression-test raw authentication headers after provider, tenant, DNS, or connection changes.
