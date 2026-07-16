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

İleri migration kuyruğu entegrasyon HEAD'inden, dosya adı sırasıyla uygulanır. Apply öncesi ledger tekrar okunur; uygulanmış migration yeniden çalıştırılmaz. Apply sonrası sürüm kaydı, fonksiyon imzası, RLS/ACL ve kritik kolon/index sözleşmeleri katalogdan doğrulanır.

## Deploy sınırı

- Railway project: `tg-research`
- Environment: Railway'de `production` adlı, fakat ürün olarak TG-Research staging olan ortam
- Servisler: `tg-core-staging`, `research-api`, `worker`
- Health: `https://tg-core-staging-production.up.railway.app/api/health`

Üç servis aynı kesin Git SHA'sından deploy edilir. Proje, environment ve service kimliği birlikte doğrulanmadan deploy başlatılmaz. Worker worktree'sinden veya kirli recovery vault'tan deploy yapılmaz.

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
