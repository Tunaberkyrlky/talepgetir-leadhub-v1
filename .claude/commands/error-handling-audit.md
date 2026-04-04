# Error Handling Audit

Review client-side async operations in the specified file(s) and ensure users are always properly notified — both on success and on failure.

## What to audit

For every `useMutation`, `useCallback` with async logic, or direct `api.*` call found in the file(s):

1. **Error path**: Is there an `onError` / `catch` that calls `showErrorFromApi(err, ...)` or `showError(...)`?
2. **Success path**: Is there an `onSuccess` / success branch that calls `showSuccess(...)` where it would be helpful?
3. **Loading state**: Is `isPending` / `isBusy` reflected in the UI (button `disabled` or spinner) so the user can't double-submit?
4. **Custom phase states** (e.g. `importState`, `rematchState`): Does each error branch reset the state back to `'idle'` so the button doesn't stay stuck?

## Fix rules

- Use `showErrorFromApi(err, fallbackMessage)` for API errors — it reads the server's error message when available.
- Use `showError(message)` only for client-side logic errors (e.g. validation before sending).
- Use `showSuccess(message)` after operations that mutate data and the user would otherwise not know it worked.
- Never swallow errors silently (`catch (e) {}` or `catch (e) { console.error(e) }` with no user notification).
- After an error in a custom phase state machine, always call `setState({ phase: 'idle' })` so the UI resets.
- i18n: all user-facing strings must come from `t('...')`. Add missing keys to both `client/src/locales/tr.json` and `client/src/locales/en.json`. Turkish is the primary language.

## Notification helpers (this project)

```ts
import { showSuccess, showError, showErrorFromApi } from '../../lib/notifications';

showSuccess(t('some.key'));                         // green toast
showError(t('some.key'));                           // red toast
showErrorFromApi(err, t('some.fallback.key'));      // red toast, prefers server message
```

## Steps

1. Read the file(s) provided in the argument (or, if none given, ask which files to audit).
2. List every async operation found.
3. For each one, evaluate the 4 checks above and note any gap.
4. Fix all gaps in-place: add missing `catch`/`onError`, `showErrorFromApi`, `showSuccess`, state resets, and i18n keys.
5. Report a short summary of what was changed.