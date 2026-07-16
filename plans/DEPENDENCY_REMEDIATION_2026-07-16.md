# Dependency Remediation — 16 Temmuz 2026

**Branch:** `chore/dependency-remediation`

**Kapsam:** P0 runtime paketleri, dev-only kritik zincir ve lockfile/deploy hijyeni.

**Production sınırı:** Ayrı `TG-Core` production projesine deploy veya ayar değişikliği yapılmadı.

## Uygulanan güncellemeler

| Zincir | Önce | Sonra |
|---|---|---|
| Client Axios | `^1.13.6` | `^1.18.1` |
| Nango frontend | `^0.70.3` | `^0.71.0` |
| Nango node | `^0.69.49` | `^0.71.0` |
| Multer | `^2.1.1` | `^2.2.0` |
| Nodemailer | `^8.0.11` | `^9.0.3` |
| Imapflow | `^1.4.0` | `^1.4.7` |
| Mailparser | `^3.9.9` | `^3.9.14` |
| Express | `^4.21.2` | `^4.22.2` |
| Concurrently | `^9.1.0` | `^10.0.3` |

Kök lockfile ayrıca güvenli transitive sürümlere çözüldü:

- `form-data@4.0.6`
- `path-to-regexp@0.1.13`
- `qs@6.15.3`
- `shell-quote@1.8.4`

## Lockfile ve build hijyeni

- Kök, server ve client lockfile workspace kayıtları `1.15.1` ile manifestlere hizalandı.
- Deploy çözümlemesinde kullanılmayan ve drift etmiş `server/package-lock.json` kaldırıldı; kök `package-lock.json` tek otorite oldu.
- Kök Railway build komutu `npm install` yerine deterministik `npm ci` kullanacak şekilde değiştirildi.
- Temiz `npm ci --ignore-scripts` kurulumu başarıyla tamamlandı.

## Audit sonucu

| Kaynak | Kritik | Yüksek | Orta | Düşük | Toplam |
|---|---:|---:|---:|---:|---:|
| Tüm bağımlılıklar — önce | 2 | 23 | 23 | 2 | 50 |
| Tüm bağımlılıklar — sonra | 0 | 13 | 19 | 2 | 34 |
| Runtime — önce | 0 | 21 | 22 | 0 | 43 |
| Runtime — sonra | 0 | 11 | 18 | 0 | 29 |

P0 listesindeki `axios`, Nango, `multer`, mail zinciri, `express`, `path-to-regexp`, `qs`, `form-data`, `concurrently` ve `shell-quote` paketlerinin hiçbiri son audit çıktısında vulnerability kaydı olarak kalmadı.

## Doğrulama

- `npm ci --ignore-scripts`: başarılı
- `npm run build`: başarılı; server TypeScript ve client TypeScript/Vite build tamamlandı
- `npm audit --omit=dev`: 0 kritik, 11 yüksek, 18 orta
- `npm audit`: 0 kritik, 13 yüksek, 19 orta, 2 düşük
- `npm run lint --workspace=client`: dependency değişikliklerinden bağımsız mevcut baseline nedeniyle başarısız — 74 hata, 7 uyarı

## Bilinçli olarak ertelenenler

- `react-simple-maps@3.0.0` eski D3 v2 zincirini ve React 18'e kadar tanımlı peer aralığını taşıyor. Paket için React 19'u resmi olarak destekleyen kararlı upstream sürüm bulunmuyor; beta veya üçüncü taraf fork'a güvenlik remediation'ı içinde geçilmedi.
- Bu peer uyuşmazlığı nedeniyle `npm audit fix --dry-run` hâlâ `ERESOLVE` ile duruyor. `--force`, global override veya `legacy-peer-deps` uygulanmadı.
- Kalan bulgular P1/P2 kapsamındaki PostHog/OpenTelemetry/protobuf, React Router, SDK/`ws`, Resend ve D3/ExcelJS zincirlerinde.
- Production deploy yapılmamalı; canlı doğrulama yalnız `tg-research / tg-core-staging` üzerinde yapılmalı.
