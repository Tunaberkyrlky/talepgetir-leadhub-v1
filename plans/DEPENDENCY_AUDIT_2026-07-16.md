# Dependency Audit — 16 Temmuz 2026

**Kapsam:** `feat/customer-support-tawk-consent` branch'i ve Railway `tg-research / tg-core-staging`

**Production sınırı:** Ayrı Railway `TG-Core` production projesine deploy veya ayar değişikliği yapılmadı.

## Yönetici özeti

- Kök workspace audit'i: **50 etkilenen paket** — 2 kritik, 23 yüksek, 23 orta, 2 düşük.
- Runtime audit (`--omit=dev`): **43 etkilenen paket** — 0 kritik, 21 yüksek, 22 orta.
- İki kritik bulgu yalnızca geliştirme komutu zincirinde: `concurrently -> shell-quote`.
- Runtime için ilk öncelikler: `axios`/Nango, `multer`, `nodemailer`/mail parsing ve `express`.
- Otomatik `npm audit fix` uygulanmadı. Dry-run, mevcut D3 peer-dependency çakışması nedeniyle `ERESOLVE` ile durdu.
- Paket manifestleri ve lockfile sürümleri drift etmiş durumda. Güvenli remediation kontrollü paket grupları ve staging doğrulamasıyla yapılmalı.

> npm sayıları benzersiz CVE sayısı değil, etkilenen paket düğümü sayısıdır. Aynı advisory birden fazla paketi etkileyebilir.

## Audit sonuçları

| Kaynak | Kritik | Yüksek | Orta | Düşük | Toplam |
|---|---:|---:|---:|---:|---:|
| Kök workspace — tüm bağımlılıklar | 2 | 23 | 23 | 2 | 50 |
| Kök workspace — runtime (`--omit=dev`) | 0 | 21 | 22 | 0 | 43 |
| İkincil `server/package-lock.json` — tümü | 0 | 12 | 10 | 1 | 23 |
| İkincil `server/package-lock.json` — runtime | 0 | 12 | 10 | 0 | 22 |

Railway staging kök dizinde `npm install && npm run build` çalıştırdığı için deploy açısından esas kayıt kök `package-lock.json` audit'idir. `server/package-lock.json` mevcut deploy'un çözümleme kaynağı değildir; ayrı lockfile tutulması drift riskidir.

## Önceliklendirilmiş bulgular

### P0 — ilk remediation PR'ı

1. **Axios ve Nango zinciri — yüksek**
   - Kilitli doğrudan Axios sürümü `1.15.0`; güvenli güncel hedef `1.18.1`.
   - `@nangohq/frontend@0.70.3` kendi altında `axios@1.15.2` taşıyor.
   - `@nangohq/node@0.69.49` için audit güvenli düzeltme olarak `0.71.0` öneriyor; pre-1.0 minor değişim olduğu için kırıcı kabul edilip entegrasyon test edilmelidir.
   - Riskler credential/header sızıntısı, proxy/NO_PROXY bypass, request/response manipulation ve DoS sınıflarını içeriyor.

2. **Multer — yüksek, doğrudan erişilebilir yüzey**
   - `2.1.1 -> 2.2.0` güncellemesi gerekli.
   - Paket; import, attachment template ve research trade upload rotalarında gerçekten kullanılıyor.
   - Rotalarda dosya boyutu, tip ve bazı rate-limit kontrolleri mevcut; ancak advisory'lerdeki nested field ve yarıda kesilen upload DoS risklerini tamamen kapatmıyor.

3. **Nodemailer / Imapflow / Mailparser — yüksek**
   - Doğrudan `nodemailer@8.0.11`; güvenli hedef `9.0.3` ve kırıcı sürüm testi gerektiriyor.
   - `imapflow@1.4.0 -> 1.4.7`, `mailparser@3.9.9 -> 3.9.14` patch/minor hattında yükseltilmeli.
   - Kod `raw` mail seçeneğini kullanmıyor ve SMTP host için SSRF guard uyguluyor; bu exploit olasılığını azaltıyor fakat etkilenen mail zincirini bırakmak için yeterli değil.

4. **Express / route parser — orta + transitive yüksek**
   - Önce `express@4.22.1 -> 4.22.2` patch güncellemesi denenmeli.
   - Zincirde `qs` ve `path-to-regexp@0.1.12` bulunuyor; remediation sonrası ikisinin de audit'ten çıktığı doğrulanmalı.

### P1 — frontend ve SDK transitive zincirleri

- `react-router-dom@7.13.1 -> 7.18.1`.
- `posthog-js@1.372.3 -> 1.402.3`; OpenTelemetry ve `protobufjs` zinciri yeniden audit edilmeli.
- `@google/genai`, Supabase, OpenAI SDK ve diğer parent paketler kontrollü güncellenerek `ws@8.19.0 -> >=8.21.1` hedeflenmeli.
- `protobufjs@7.5.5 -> >7.6.2` parent SDK'lar üzerinden çözülmeli; doğrudan override son çare olmalı.
- `form-data@4.0.5 -> >=4.0.6` Axios/Nango güncellemesi sonrasında doğrulanmalı.
- `resend@6.12.0 -> 6.17.2` ile `svix/uuid` zinciri yeniden audit edilmeli.

### P2 — D3 harita zinciri ve kalanlar

- Manifestte `d3-selection@3` ile `d3-transition@2` birlikte kullanılıyor; bu mevcut peer-dependency çakışmasının kaynağı.
- `d3-transition@3.0.1` ve `d3-zoom@3.0.0` güvenli hedefler, fakat `react-simple-maps@3.0.0` eski D3 zincirine bağlı. Harita ekranı regresyon testi olmadan force/override yapılmamalı.
- `exceljs@4.4.0` için npm'in önerdiği downgrade güvenli bir otomatik çözüm değil. Kullanım azaltma, alternatif paket veya upstream düzeltme ayrıca değerlendirilmeli.
- Dev-only `concurrently/shell-quote`, runtime riskinden bağımsız olarak güncellenmeli.

## Lockfile ve deploy hijyeni

- Manifestler `1.15.1`, kök lockfile kayıtları `1.12.7`, server lockfile kökü `0.1.0`. Lockfile'lar kontrollü olarak yeniden üretilmeli.
- Workspace deploy'unda tek otorite olarak kök lockfile kullanılmalı; `server/package-lock.json` ya kaldırılmalı ya da ayrı deploy gereksinimi varsa bilinçli biçimde senkron tutulmalı.
- Railway build'i `npm install` kullanıyor. Lockfile düzeltildikten sonra deterministik `npm ci` akışına geçilmeli.
- Build için gereken dev bağımlılıkları runtime imajında bırakılmamalı; build sonrası prune veya multi-stage image uygulanmalı.
- `npm audit fix --force` kullanılmamalı. Audit; Nango, Nodemailer ve D3 için kırıcı değişiklik öneriyor.

## Uygulama sırası

1. Temiz bir dependency remediation branch'i aç; mevcut feature branch'teki ilgisiz dirty dosyaları dahil etme.
2. Lockfile drift ve D3 peer çakışmasını çöz; temiz kurulum ve iki workspace build'ini doğrula.
3. P0 paketlerini küçük gruplar halinde güncelle: upload, HTTP/Nango, mail, Express.
4. Her grupta `npm audit --omit=dev`, TypeScript/build ve ilgili smoke testleri çalıştır.
5. P1 frontend/SDK zincirlerini güncelle ve yeniden audit et.
6. Temiz commit snapshot'ını yalnız `tg-research / tg-core-staging` servisine deploy et.
7. Upload, SMTP gönderim/alım, Nango bağlantısı, login/API ve harita ekranı smoke testlerini tamamla.
8. Audit hedefi sağlanmadan ayrı `TG-Core` production projesine deploy etme.

## Çalıştırılan komutlar

```bash
npm audit --json
npm audit --omit=dev --json
(cd server && npm audit --json)
(cd server && npm audit --omit=dev --json)
npm audit fix --dry-run --json
npm outdated --workspaces --json
npm ls <security-relevant-packages> --all --depth=5
```

Dry-run sırasında `package.json` ve lockfile checksum'ları karşılaştırıldı; hiçbir dependency dosyası değişmedi.

## İlgili advisory'ler

- Axios: https://github.com/advisories/GHSA-hfxv-24rg-xrqf
- Multer nested field DoS: https://github.com/advisories/GHSA-72gw-mp4g-v24j
- Multer aborted upload DoS: https://github.com/advisories/GHSA-3p4h-7m6x-2hcm
- Nodemailer file read / SSRF: https://github.com/advisories/GHSA-p6gq-j5cr-w38f
- Path-to-regexp ReDoS: https://github.com/advisories/GHSA-37ch-88jc-xwx2
- Protobuf.js code injection: https://github.com/advisories/GHSA-66ff-xgx4-vchm
- ws memory exhaustion: https://github.com/advisories/GHSA-96hv-2xvq-fx4p
