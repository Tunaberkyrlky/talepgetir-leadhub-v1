# Privacy Policy — Tibexa (TG Core)

> **Bu bir taslaktır.** KVKK/GDPR yükümlülükleri için (özellikle gerçek müşteri verisi
> işlediğiniz için) bir hukukçuya **bir kez** gözden geçirtmeniz önerilir. Aşağıdaki
> `[KÖŞELİ PARANTEZ]` alanlarını doldurun. Yayına alırken bunu HTML'e çevirip
> `https://tibexa.com/privacy` altında herkese açık (login'siz) sunun.
>
> **Tasarım kararı:** Gmail, OAuth yerine **uygulama şifresi (SMTP gönderim + IMAP okuma)**
> ile bağlanır → **hiçbir Google OAuth scope'u kullanılmaz**, dolayısıyla Google doğrulaması
> ve Limited Use GEREKMEZ. Outlook ise Microsoft OAuth ile bağlanır. `gmail.send` /
> `gmail.readonly` gibi Google scope'ları EKLEMEYİN.

**Effective date:** [TARİH, ör. 18 June 2026]
**Last updated:** [TARİH]

---

## 1. Who we are

Tibexa ("Tibexa", "we", "us") operates the TG Core B2B CRM application available at
`https://core.tibexa.com`. For any privacy question contact us at **info@tibexa.com**
([VARSA POSTA ADRESİ / TİCARİ UNVAN]).

This policy explains what data we process, why, and your rights — including how we
handle the content of mailboxes you connect to send and receive email.

## 2. Data we process

- **Account data:** your name, email, and authentication identifiers, used to sign you
  in and manage your account.
- **Customer (CRM) data:** the companies, contacts and activity records that you or your
  organization import into TG Core. You are the controller of this data; we process it on
  your behalf as a processor.
- **Email content:** the content of emails you send through TG Core and of inbound replies
  imported into the system — subject, body, sender/recipient addresses and timestamps —
  used to keep a record of your correspondence and match it to the right company/contact.
- **Connected mailbox access:** when you connect a mailbox for reply tracking (e.g. via
  IMAP) we read inbound messages from it, and we receive reply notifications from our
  email-campaign provider, in order to import the continuation of conversations you started
  in TG Core. We access mailbox content only for this purpose.
- **Usage and analytics data:** product-analytics events about how you use the app (pages
  viewed, actions taken, approximate device/browser), collected via our analytics provider
  to operate and improve the service. This may use cookies or similar identifiers.
- **Operational logs:** technical logs (IP, timestamps, request metadata) for security,
  debugging and abuse prevention.

## 3. Connected email accounts

TG Core sends and reads email through a mailbox you connect, **on your behalf and initiated
by you**. You can connect:

- **Gmail (app password):** we use Gmail's standard SMTP server to send the emails you
  compose/approve and Gmail's IMAP server to import replies to conversations you started.
  Authentication uses an app password you generate. **We do not use any Google OAuth API
  scope** (no `gmail.send`, no read scope), so the Google API Services User Data Policy and
  its Limited Use requirements do not apply.
- **Outlook / Microsoft 365 (OAuth):** sending uses Microsoft's API via OAuth; we request
  only the permission needed to send mail on your behalf.
- **Your own server (SMTP/IMAP):** send via SMTP and, optionally, import replies via IMAP.

For any connected mailbox, reply importing is limited to messages from contacts you have
added or addresses you have already emailed (see Section 2). We never read, modify, or
delete unrelated messages, we do **not** sell mailbox data, and we do **not** use it for
advertising.

## 4. How we use data

- To provide and operate the TG Core application and its features.
- To send the emails you initiate, from your connected mailbox.
- To import and display the replies/continuation of conversations you started.
- To secure the service, prevent abuse, and meet legal obligations.

We do not use your data for advertising or sell it to anyone.

## 5. Sharing and sub-processors

We share data only with infrastructure providers that help us run the service, under
appropriate data-processing terms:

- **Supabase** — database, authentication and storage.
- **Railway** — application hosting.
- **Nango** — secure storage of OAuth connection tokens for your connected Microsoft/Outlook
  account.
- **PlusVibe** — outbound email-campaign delivery and inbound reply capture.
- **Resend** — delivery of transactional/system emails (e.g. notifications).
- **Microsoft** — when you connect an Outlook / Microsoft 365 account for sending.
- **PostHog** — product analytics (how the app is used).
- **DeepL** — optional translation of content you choose to translate.

We may also disclose data where required by law.

## 6. Data retention

We retain account and CRM data for as long as your account is active. You may disconnect
your connected mailbox or request deletion at any time (Sections 8–9). On account closure
we delete or anonymize your data within [SÜRE, ör. 30 gün], except where law requires
longer retention.

## 7. Security

We protect data with encryption in transit (HTTPS), row-level access isolation between
tenants, restricted access tokens, and access controls. No method of transmission or
storage is 100% secure, but we take reasonable measures to protect your data.

## 8. Your rights

Depending on your jurisdiction (including under **KVKK** and **GDPR**), you may have the
right to access, correct, delete, export, or restrict processing of your personal data,
and to withdraw consent. To exercise these rights contact **info@tibexa.com**.

## 9. Revoking access

You can revoke TG Core's access to your connected account at any time, either from within
TG Core (Settings → email connections → disconnect) or, for Gmail, by deleting the app
password at **https://myaccount.google.com/apppasswords**. Revoking access stops any
further sending and, where applicable, reply importing from that mailbox.

## 10. Children

TG Core is a business tool and is not directed to children under 16.

## 11. Changes to this policy

We may update this policy; we will revise the "Last updated" date and, for material
changes, notify you in-app or by email.

## 12. Contact

Tibexa — **info@tibexa.com** — [ADRES / ÜLKE]
