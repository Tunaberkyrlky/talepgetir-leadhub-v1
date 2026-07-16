# TG-Research Worktree Playbook

Tarih: 2026-07-16

## Amaç

TG-Research'ü TG-Core production'dan bağımsız ilerletmek, paralel agent çalışmalarını kaybetmeden ayrıştırmak ve yalnız doğrulanmış commitleri tek bir ürün hattında toplamak.

## Mevcut worktree rolleri

| Worktree | Branch | Rol | Kural |
|---|---|---|---|
| `TG-Research` | `feat/customer-support-tawk-consent` | Recovery vault | Çok sayıda karışık, commitlenmemiş çalışma içeriyor. Yeni iş, checkout, toplu commit veya deploy yapılmaz. |
| `TG-Research-upstream-p0` | `chore/tg-research-upstream-p0` | Known-good integration candidate | P0, dependency ve seçilmiş mail düzeltmeleriyle staging'de doğrulandı. Toparlama süresince yalnız coordinator yazar. |
| `TG-Research-dependency-remediation` | `chore/dependency-remediation` | Tamamlanmış kaynak branch | Yeni feature geliştirilmez; gerektiğinde commit kaynağı ve audit kanıtıdır. |
| `/private/tmp/.../wt/e*` | `wt/e*` | Recovery candidates | Commitlenmemiş içerik envanteri tamamlanmadan silinmez veya prune edilmez. |

Şu an için yeni ürün geliştirmesi başlatılmaz. Önce recovery ve trunk konsolidasyonu tamamlanır.

## Konsolidasyon sırası

1. `chore/tg-research-upstream-p0` known-good taban olarak dondurulur.
2. `origin/ssalihyetim/TG-Research` üzerinde olup P0 tabanında bulunmayan commitler tek tek diff edilir. Patch-equivalent commitler tekrar alınmaz; yalnız eksik davranış seçici olarak port edilir.
3. Kirli `TG-Research` worktree'sindeki değişiklikler görev kümelerine ayrılır. Örnek kümeler: cold-call credits/admin, LinkedIn campaign UX, Research maps/Gosom, daily digest ve wizard düzeltmeleri.
4. Her küme için P0 tabanından ayrı bir recovery branch/worktree açılır. Kaynak worktree'den yalnız o kümeye ait dosya veya hunk'lar taşınır; paylaşımlı dosyalar coordinator tarafından ayrıştırılır.
5. Her recovery branch atomik commit, değişen dosya listesi, migration listesi ve doğrulama sonucu üretir. Branch kendi başına deploy edilmez.
6. Commitler tek tek konsolidasyon branch'ine alınır. Her committen sonra en az server build, client build ve ilgili hedefli kontroller çalıştırılır.
7. Migration'lar yalnız TG-Research test Supabase üzerinde sıralı uygulanır ve yetki/smoke testleri yapılır.
8. Release candidate yalnız `tg-research / tg-core-staging` hedefine deploy edilir. TG-Core production kapsam dışıdır.
9. Canlı QA tamamlanınca konsolidasyon hattı PR veya kontrollü merge ile `ssalihyetim/TG-Research` trunk'ına taşınır. Force-push yapılmaz.
10. Son trunk SHA'sından temiz, kalıcı `TG-Research-trunk` worktree'si oluşturulur. Eski recovery worktree'leri ancak içeriklerinin commit veya patch olarak korunduğu doğrulandıktan sonra arşivlenir.

## Kalıcı paralel çalışma modeli

```text
ssalihyetim/TG-Research (protected trunk, staging-deployable)
├── feat/research-<task-a>     -> ayrı worktree, tek yazıcı
├── feat/research-<task-b>     -> ayrı worktree, tek yazıcı
├── fix/research-<bug>         -> ayrı worktree, tek yazıcı
├── sync/tg-core-main-<date>   -> seçici upstream port
└── chore/research-deps-<date> -> dependency remediation
```

### Coordinator sorumlulukları

- Task ve dosya sahipliğini atamak.
- Paylaşımlı sıcak dosyalarda eşzamanlı yazmayı engellemek.
- Agent commitlerini review edip tek tek entegre etmek.
- Build, migration sırası, staging deploy ve smoke testlerini yürütmek.
- Her deploy'u commit SHA ve Railway deployment ID ile kaydetmek.

### Worker agent teslim sözleşmesi

Her worker aşağıdaki bilgileri teslim eder:

```text
Branch:
Base SHA:
Commit SHA:
Files modified:
Migrations added:
Checks run:
Known risks / remaining work:
```

Worker yalnız kendi branch'ine commit atar. Trunk'a push, merge, migration apply veya deploy yapmaz.

## Deploy sınırı

- Railway project: `tg-research`
- Environment: `production` adıyla kayıtlı TG-Research staging ortamı
- Service: `tg-core-staging`
- Health: `https://tg-core-staging-production.up.railway.app/api/health`

`production` environment adı TG-Core production anlamına gelmez; proje ve servis kimliği birlikte doğrulanmadan deploy başlatılmaz.

## Acil durdurma koşulları

Aşağıdaki durumlardan biri varsa agent edit yapmadan coordinator'a döner:

- Worktree kirli ve değişikliklerin tamamı kendi görevine ait değilse.
- Beklenen branch veya base SHA farklıysa.
- Aynı sıcak dosyada başka bir görev çalışıyorsa.
- Migration numarası veya bağımlılık lockfile'ı başka branch ile çakışıyorsa.
- Deploy hedefi `tg-research / tg-core-staging` olarak doğrulanamıyorsa.
- İşlem TG-Core `main` veya TG-Core production'a dokunacaksa.
