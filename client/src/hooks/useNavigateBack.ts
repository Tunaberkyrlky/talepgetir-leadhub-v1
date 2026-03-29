import { useNavigate } from 'react-router-dom';

/**
 * Returns a `goBack(fallback)` function that behaves like the browser back button,
 * but navigates to `fallback` when there is no history to go back to (e.g. the
 * user opened the page from an external link or bookmark).
 *
 * Usage:
 *   const goBack = useNavigateBack();
 *   <Button onClick={() => goBack('/companies')}>Back</Button>
 */
export function useNavigateBack() {
    const navigate = useNavigate();

    return (fallback: string) => {
        if (window.history.length > 1) {
            navigate(-1);
        } else {
            navigate(fallback, { replace: true });
        }
    };
}
