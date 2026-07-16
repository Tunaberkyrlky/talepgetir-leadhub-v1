# TG-Research Worktree Playbook

Tarih: 2026-07-16

## Ürün sınırı

TG-Core `main` mevcut müşterilerin production hattıdır ve kendi yolunda ilerler. TG-Research, TG-Core çekirdeğini kullanan fakat ayrı ürün yaşam döngüsüne sahip test/staging ürünüdür.

- Varsayılan kod akışı yalnız `TG-Core main -> TG-Research` yönündedir.
- `main` TG-Research'e topluca merge veya rebase edilmez. Uygun güvenlik ve çekirdek düzeltmeleri ayrı sync branch'lerinde seçici olarak port edilir.
- TG-Research değişiklikleri açık bir ürün kararı olmadan TG-Core `main`e geri taşınmaz.
- TG-Research işleri yalnız TG-Research test veritabanına ve staging servislerine uygulanır. TG-Core production kapsam dışıdır.

## Tek temiz entegrasyon hattı

| Worktree | Branch | Rol | Yazma yetkisi |
|---|---|---|---|
| `/Users/salihyetim/orca/workspaces/TG-Core-copy-16.06/tg-research-consolidation` | `ssalihyetim/tg-research-consolidation` | Temiz TG-Research entegrasyon hattı ve staging release kaynağı | Yalnız coordinator |
| `/Users/salihyetim/orca/workspaces/TG-Core-copy-16.06/TG-Research` | `feat/customer-support-tawk-consent` | Kirli recovery vault | Salt okunur; checkout, stash, clean, toplu commit ve deploy yasak |
| `/Users/salihyetim/orca/workspaces/TG-Core-copy-16.06/TG-Research-upstream-p0` | `chore/tg-research-upstream-p0` | Dondurulmuş known-good taban | Salt okunur |
| `/Users/salihyetim/orca/workspaces/TG-Core-copy-16.06/TG-Research-dependency-remediation` | `chore/dependency-remediation` | Tamamlanmış dependency/audit kaynağı | Salt okunur |
| `/Users/salihyetim/orca/workspaces/TG-Core-copy-16.06/recover-*` | Göreve özel recovery branch'leri | Kurtarma ve hardening kaynakları | Yalnız atanmış worker |
| `/private/tmp/.../scratchpad/wt/e2..e12` | `wt/e*` | Eski recovery kanıtı | Salt okunur; açık arşiv kararı olmadan silinmez |

`e2..e12` kaynak değişikliklerinin kalıcı ancestor commitlerle byte-level eşleştiği doğrulandı. `node_modules` symlinkleri bu doğrulamanın parçası değildir. Kirli vault içindeki secret taşıyan operasyon notları hiçbir branch'e taşınmaz.

## Agent çalışma modeli

Kullanıcı TG-Research işini coordinator'a verir; worker agentlara ayrıca paralel görev dağıtmaz. Coordinator dosya sahipliğini, worktree'leri, review'u, entegrasyonu, migration'ı ve staging deploy'u tek noktadan yönetir.

1. Coordinator temiz entegrasyon HEAD'ini ve boş status'u doğrular.
2. Her görev için bu kesin HEAD'den ayrı branch ve ayrı worktree açılır.
3. Bir worktree'nin tek yazıcı agentı vardır. Başka agentlar yalnız salt okunur review yapabilir.
4. Worker yalnız görev brief'inde verilen dosya/hunk'ları değiştirir; atomik commit üretir.
5. Worker merge, rebase, cherry-pick, trunk push, migration apply veya deploy yapmaz.
6. Coordinator commit diff'ini ve bağımsız review sonucunu inceler; gerekirse aynı worker'a hardening turu verir.
7. Yalnız onaylanan commitler temiz entegrasyon worktree'sine tek tek cherry-pick edilir.
8. Entegre HEAD üzerinde build, hedefli test, audit, secret ve migration kontrolleri tekrar çalıştırılır.
9. Veritabanı değişiklikleri önce yalnız TG-Research test Supabase'e uygulanır; ardından aynı kesin commit üç TG-Research staging servisine deploy edilir.

### Yeni worker worktree şablonu

```bash
cd /Users/salihyetim/orca/workspaces/TG-Core-copy-16.06/tg-research-consolidation
git status --short
git rev-parse --short HEAD
git worktree add ../tg-research-<task> -b feat/tg-research-<task> HEAD
```

Worker başlangıçta ve teslimden önce şunları raporlar:

```text
Worktree:
Branch:
Base SHA:
Commit SHA:
Files modified:
Migrations added:
Checks run:
Known risks / remaining work:
```

`client/src/locales/*.json`, `server/src/lib/validation.ts`, package/lock dosyaları, `supabase/migrations/` ve deploy config'leri sıcak alanlardır. Aynı anda yalnız bir görev bunların yazarı olabilir.

## Migration ledger sözleşmesi

Supabase migration kimliği dosya adının başındaki sürümdür. Yeni migration'larda yalnız UTC sıralı `YYYYMMDDHHMMSS_description.sql` adı kullanılır; yeni üç haneli migration oluşturulmaz.

2026-07-16 salt-okunur ledger doğrulamasında TG-Research test projesinde görülen Git eşleşmeleri:

| Ledger sürümü | Migration | Durum |
|---|---|---|
| `20260714173500` | `coldcall_credit_wallet` | Uygulanmış; dosya adı ledger ile hizalı tutulur |
| `20260716171643` | `linkedin_enroll_and_tokens` | Uygulanmış; hizalı |
| `20260716173921` | `research_company_maps_metadata` | Uygulanmış; hizalı |
| `20260716175652` | `research_reset_derived_data` | Uygulanmış; hizalı |
| `20260716181845` | `admin_audit_log_rls` | Uygulanmış; hizalı |
| `20260716183427` | `research_persist_hs_candidates` | Uygulanmış; hizalı |
| `20260716210000` | `revoke_research_search_rpc_execute` | Uygulanmış; dört tenant-scoped search RPC yalnız `service_role` tarafından çalıştırılabilir |
| `20260716211000` | `unify_company_product_fields` | Uygulanmış; `product_portfolio` kaldırıldı ve `product_services`/`merge_companies` sözleşmesi doğrulandı |
| `20260716213000` | `coldcall_atomicity_hardening` | Uygulanmış; RPC, queue, lease, snapshot ve kritik index sözleşmeleri doğrulandı |
| `20260716220000` | `research_verdict_provenance_and_fenced_search` | Uygulanmış; provenance, fenced persist RPC ve benzersiz search-log anahtarı doğrulandı |
| `20260716230000` | `daily_digest` | Uygulanmış; log tablosu, RLS, benzersizlik ve aktivite indexi doğrulandı |

2026-07-16 apply turunda son beş migration ayrı transaction'larda ve absent-version guard ile yalnız TG-Research test projesine uygulandı. Ledger'daki `statements` içeriklerinin normalize hash'leri temiz konsolidasyon dosyalarıyla eşleştirildi. Bu sürümler artık uygulanmış kabul edilir ve yeniden çalıştırılmaz. Yeni ileri migration'lar entegrasyon HEAD'inden dosya adı sırasıyla uygulanır; apply öncesi ledger tekrar okunur, apply sonrası sürüm kaydı, fonksiyon imzası, RLS/ACL ve kritik kolon/index sözleşmeleri katalogdan doğrulanır.

## Son birleşik doğrulama

2026-07-16 temiz konsolidasyon HEAD'i üzerinde aşağıdaki release kontrolleri geçti:

- Tam server ve client production build.
- Maps hardening testleri: 6/6.
- Cold Call güvenlik ve idempotency testleri: 21/21.
- Cold Call hedefli ESLint.
- `npm audit` ve `npm audit --omit=dev`: 0 açık.
- Manifest/lockfile dry-run ve tam dependency tree kontrolü.
- Migration adı/sırası, `git diff --check` ve eklenen diff için güçlü secret imzası taraması.

## Deploy sınırı

- Railway project: `tg-research`
- Environment: Railway'de `production` adlı, fakat ürün olarak TG-Research staging olan ortam
- Servisler: `tg-core-staging`, `research-api`, `worker`
- Health: `https://tg-core-staging-production.up.railway.app/api/health`

Üç servis aynı kesin Git SHA'sından deploy edilir. Proje, environment ve service kimliği birlikte doğrulanmadan deploy başlatılmaz. Worker worktree'sinden veya kirli recovery vault'tan deploy yapılmaz.

Cold Call teklif imzalama için `tg-core-staging` servisinde en az 32 karakterlik `COLDCALL_OFFER_SECRET` bulunmalıdır. Daily Digest migration'ı uygulanmış olsa da scheduler varsayılan olarak kapalı kalır; yalnız geçerli `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `ENABLE_DAILY_DIGEST_SCHEDULER=true` ve tenant düzeyinde `daily_digest_enabled` birlikte hazırlandığında açılır.

## Acil durdurma koşulları

Aşağıdakilerden biri varsa worker edit yapmadan coordinator'a döner:

- Worktree kirliyse veya değişikliklerin tamamı kendi görevine ait değilse.
- Beklenen branch/base SHA farklıysa.
- Aynı sıcak dosyada başka bir görev yazıyorsa.
- Migration ledger bilinmiyor, sürüm çakışıyor veya dosya adı timestamp sözleşmesine uymuyorsa.
- Deploy hedefi tam olarak TG-Research staging olarak doğrulanamıyorsa.
- İşlem TG-Core `main`, TG-Core production veya kirli recovery vault'ta mutasyon gerektiriyorsa.

## Arşivleme

Kirli recovery vault, `recover-*` worktree'leri ve eski scratchpad'ler konsolidasyon tamamlandı diye otomatik temizlenmez. Silme/prune ancak içeriklerinin kalıcı commit veya güvenli patch olarak korunduğu ayrıca doğrulandıktan ve kullanıcı açıkça arşivleme istediğinde yapılır.
