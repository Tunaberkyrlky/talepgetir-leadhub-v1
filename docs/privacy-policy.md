# Privacy Policy — Tibexa (TG Core)

> **Bu bir taslaktır.** Google OAuth doğrulaması için yeterli; ancak KVKK/GDPR
> yükümlülükleri için (özellikle gerçek müşteri verisi işlediğiniz için) bir
> hukukçuya **bir kez** gözden geçirtmeniz önerilir. Aşağıdaki `[KÖŞELİ PARANTEZ]`
> alanlarını doldurun. Yayına alırken bunu HTML'e çevirip `https://tibexa.com/privacy`
> altında herkese açık (login'siz) sunun.

**Effective date:** [TARİH, ör. 18 June 2026]
**Last updated:** [TARİH]

---

## 1. Who we are

Tibexa ("Tibexa", "we", "us") operates the TG Core B2B CRM application available at
`https://core.tibexa.com`. For any privacy question contact us at **info@tibexa.com**
([VARSA POSTA ADRESİ / TİCARİ UNVAN]).

This policy explains what data we process, why, and your rights — including how we
handle data obtained through Google APIs when you connect your Google account.

## 2. Data we process

- **Account data:** your name, email, and authentication identifiers, used to sign you
  in and manage your account.
- **Customer (CRM) data:** the companies, contacts and activity records that you or your
  organization import into TG Core. You are the controller of this data; we process it on
  your behalf as a processor.
- **Google account data (only if you connect Gmail):** see Section 3.
- **Operational logs:** technical logs (IP, timestamps, request metadata) for security,
  debugging and abuse prevention.

## 3. Google user data and Limited Use

TG Core lets you connect your own Google/Gmail account so the application can send
outbound emails (sales follow-ups and replies) **from your own mailbox, on your behalf
and initiated by you**. To do this we request the following Google OAuth scopes:

- `https://www.googleapis.com/auth/gmail.send` — to send emails you compose/approve, via
  the Gmail API (`users.messages.send`). **We never read, search, modify, label or delete
  any message in your mailbox.**
- `https://www.googleapis.com/auth/userinfo.email` — to identify which address you
  connected, so we can display it and use it as the sender (From) address.
- `openid` — standard OpenID Connect identifier to link the connected account to your
  Tibexa account.

We do **not** sell this data, do **not** use it for advertising, and do **not** transfer
it to third parties except as required to provide the feature (see Section 5).

> **Tibexa's use and transfer to any other app of information received from Google APIs
> will adhere to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
> including the Limited Use requirements.**

## 4. How we use data

- To provide and operate the TG Core application and its features.
- To send the emails you initiate, from your connected mailbox.
- To secure the service, prevent abuse, and meet legal obligations.

We do not use your data for advertising or sell it to anyone.

## 5. Sharing and sub-processors

We share data only with infrastructure providers that help us run the service, under
appropriate data-processing terms:

- **Supabase** — database, authentication and storage.
- **Railway** — application hosting.
- **Nango** — secure storage of OAuth connection tokens for your connected Google account.
- **DeepL** — optional translation of content you choose to translate.
- [DİĞER VARSA, ör. e-posta/analitik sağlayıcısı]

We may also disclose data where required by law.

## 6. Data retention

We retain account and CRM data for as long as your account is active. You may disconnect
your Google account or request deletion at any time (Sections 8–9). On account closure we
delete or anonymize your data within [SÜRE, ör. 30 gün], except where law requires longer
retention.

## 7. Security

We protect data with encryption in transit (HTTPS), row-level access isolation between
tenants, restricted access tokens, and access controls. No method of transmission or
storage is 100% secure, but we take reasonable measures to protect your data.

## 8. Your rights

Depending on your jurisdiction (including under **KVKK** and **GDPR**), you may have the
right to access, correct, delete, export, or restrict processing of your personal data,
and to withdraw consent. To exercise these rights contact **info@tibexa.com**.

## 9. Revoking Google access

You can revoke TG Core's access to your Google account at any time, either from within
TG Core (Settings → email connections → disconnect) or directly via your Google Account at
**https://myaccount.google.com/connections** (or `permissions`). Revoking access stops any
further sending from that mailbox.

## 10. Children

TG Core is a business tool and is not directed to children under 16.

## 11. Changes to this policy

We may update this policy; we will revise the "Last updated" date and, for material
changes, notify you in-app or by email.

## 12. Contact

Tibexa — **info@tibexa.com** — [ADRES / ÜLKE]
