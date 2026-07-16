# Dependency Remediation — 16 Temmuz 2026

**Branch:** `chore/dependency-remediation`

**Kapsam:** P0/P1/P2 runtime ve geliştirme zincirleri, peer uyuşmazlıkları ve lockfile/deploy hijyeni.

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
- Lockfile, mevcut `node_modules` dizinleri tamamen devre dışı bırakılarak boş kurulum durumunda yeniden üretildi. Böylece macOS ve Linux için Rollup/esbuild optional native paketleri aynı lockfile içinde tutuluyor.
- Temiz `npm ci --ignore-scripts` kurulumu başarıyla tamamlandı.

## Audit sonucu

| Kaynak | Kritik | Yüksek | Orta | Düşük | Toplam |
|---|---:|---:|---:|---:|---:|
| Tüm bağımlılıklar — önce | 2 | 23 | 23 | 2 | 50 |
| Tüm bağımlılıklar — P0 sonrası | 0 | 13 | 19 | 2 | 34 |
| Tüm bağımlılıklar — final | 0 | 0 | 0 | 0 | 0 |
| Runtime — önce | 0 | 21 | 22 | 0 | 43 |
| Runtime — P0 sonrası | 0 | 11 | 18 | 0 | 29 |
| Runtime — final | 0 | 0 | 0 | 0 | 0 |

P0 listesindeki `axios`, Nango, `multer`, mail zinciri, `express`, `path-to-regexp`, `qs`, `form-data`, `concurrently` ve `shell-quote` paketlerinin hiçbiri son audit çıktısında vulnerability kaydı olarak kalmadı.

## Doğrulama

- `npm ci --ignore-scripts`: başarılı
- `npm ls --all`: başarılı; invalid/missing peer yok
- `npm run build`: başarılı; server TypeScript ve client TypeScript/Vite build tamamlandı
- `npm audit --omit=dev`: 0 bulgu
- `npm audit`: 0 bulgu
- `npm audit fix --dry-run`: başarılı; eklenecek/değişecek/kaldırılacak paket yok ve manifest/lockfile checksum'ları değişmedi
- Harita projection smoke: 177/177 ülke yolu üretildi; projection/invert round-trip başarılı
- `client/src/components/GlobeMap.tsx` lint: başarılı
- Excel fork smoke: XLSX buffer/dosya yazma, stil, conditional formatting ve geri okuma başarılı
- `npm run lint --workspace=client`: remediation dışı mevcut baseline nedeniyle başarısız — 52 hata, 7 uyarı

## Kök nedenler ve kalıcı çözümler

- **React 19 / D3:** `react-simple-maps@3.0.0` React peer aralığını 18'de ve D3 zincirini v2'de bırakıyordu. Paket ile kullanılmayan doğrudan `d3-selection`, `d3-transition` ve `d3-zoom` kaldırıldı. Harita; `d3-geo@3`, mevcut TopoJSON ve repo-içi React SVG/pan/zoom uygulamasına geçirildi. Böylece peer çakışması ve D3 advisory zinciri birlikte kaldırıldı.
- **PostHog/OpenTelemetry:** `posthog-js@1.372.3` eski OpenTelemetry zincirini taşıyordu. `1.402.3` sürümüyle bu zincir dependency ağacından çıktı; `posthog-node` da `5.44.0` sürümüne yükseltildi.
- **protobuf/ws:** Google GenAI, Supabase ve OpenAI parent sürümleri güncellenerek `protobufjs@7.6.5`, `@protobufjs/utf8@1.1.2` ve `ws@8.21.1` çözüldü.
- **Resend/uuid:** `resend@6.17.2`, eski Svix/UUID zincirini kaldırdı.
- **ExcelJS:** Upstream `exceljs@4.4.0`, dört yıldır `uuid@8` ve eski arşiv zincirine bağlıydı. Major override veya npm'in önerdiği eski sürüme downgrade yerine, API-uyumlu ve aktif DevExpress fork'u `devextreme-exceljs-fork@4.4.11` kullanıldı; import ve rapor üretim smoke testleri geçti.
- **Dev toolchain:** `tsx@4.21.0` esbuild `~0.27` pin'i son düşük bulgunun kaynağıydı. `tsx@4.23.1` ile Vite ve TSX güvenli `esbuild@0.28.1` üzerinde birleşti. Vite'ın optional YAML peer'ı kök `yaml@2.9.0` ile karşılandı; Emotion/Cosmiconfig kendi güvenli `yaml@1.10.3` sürümünü nested kullanıyor.
- **Platforma bağlı lockfile:** İlk final staging denemesi macOS'ta mevcut `node_modules` ağacı üzerinden üretilen lockfile'ın `@rollup/rollup-linux-x64-gnu` kaydını içermemesi nedeniyle Railway Linux build'inde durdu. Paket ağacı tamamen kaldırılıp `npm install --package-lock-only --ignore-scripts` boş durumdan çalıştırıldı. Yeni lockfile hem `@rollup/rollup-darwin-arm64` hem `@rollup/rollup-linux-x64-gnu` ve karşılık gelen esbuild platform paketlerini içeriyor; ardından temiz `npm ci`, yerel build ve Railway Linux build'i geçti.
- `--force`, `legacy-peer-deps` veya dependency override kullanılmadı.
- Production deploy yapılmamalı; canlı doğrulama yalnız `tg-research / tg-core-staging` üzerinde yapılmalı.

## İlk staging rollout

- Deploy edilen commit: `a08cb19`
- Railway projesi: `tg-research` (`fdd120c4-5e6b-4503-aae6-8b0ec84304d9`)
- Servis: `tg-core-staging` (`8b95e0cb-c1e9-46ce-b969-fa0663ddb7c6`)
- Deployment: `c8cb7b2e-bf32-4bd1-b225-bc85d2b7095c` — `SUCCESS`
- Health check: `GET /api/health` — HTTP 200, `status=ok`, `database=connected`
- Ayrı `TG-Core` production projesine deploy veya ayar değişikliği yapılmadı.

Başlangıç loglarında dependency regresyonu görülmedi. Staging ortamında önceden mevcut iki config uyarısı devam ediyor: `TRACKING_SECRET` tanımlı değil ve PlusVibe webhook secret'ı eksik. Bu remediation kapsamında ortam değişkenlerine dokunulmadı.

## Final staging rollout

- Remediation commit: `6967454`
- Cross-platform lockfile commit: `8a5cb3c`
- İlk final deneme: `000992f5-285b-490d-853a-0bd5837e0867` — `FAILED`; eksik Linux Rollup optional package kaydı, çalışan staging sürümünü etkilemedi
- Nihai deployment: `e404c0ba-803c-459a-b510-6d1a4c57e6c6` — `SUCCESS`
- Railway Linux build: `npm ci --include=dev` ve `npm ci --omit=dev` başarılı; her iki audit 0 bulgu; server ve client production build başarılı
- Health check: `GET /api/health` — HTTP 200, `status=ok`, `database=connected`
- HTTP smoke: uygulama ana sayfası ve yeni `GlobeMap` bundle'ı HTTP 200
- Görsel/etkileşim smoke denendi ancak kullanılabilir uygulama içi tarayıcı oturumu bulunmadığı için çalıştırılamadı; bu durum deployment veya health doğrulamasını etkilemiyor
- Ayrı `TG-Core` production projesine deploy veya ayar değişikliği yapılmadı
