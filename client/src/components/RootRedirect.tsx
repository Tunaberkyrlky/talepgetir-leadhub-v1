/**
 * RootRedirect — onboarding gate for "/" (WP6, A-1 product decision).
 * TG-Research is now TG-Core's first step: a brand-new tenant (zero research projects)
 * lands on the wizard instead of the CRM dashboard; every existing tenant keeps landing
 * on /dashboard exactly as before. This is a product-flow decision only — it does NOT
 * touch CRM/companies data or code, and it fails open to /dashboard on any error so a
 * network hiccup can never strand an existing user off their normal landing page.
 *
 * Mounted inside the authenticated <Layout /> route subtree, so AuthProvider/tenant
 * context are already resolved by the time this renders.
 */
import { Center, Loader } from '@mantine/core';
import { Navigate } from 'react-router-dom';
import { useLatestResearchProject } from '../lib/researchProjects';

export default function RootRedirect() {
    const query = useLatestResearchProject();

    if (query.isLoading) {
        return (
            <Center h="100vh">
                <Loader />
            </Center>
        );
    }

    // Fail open: any request error (network hiccup, transient 5xx, etc.) sends the
    // user to the dashboard exactly like before this feature existed.
    if (query.isError) {
        return <Navigate to="/dashboard" replace />;
    }

    const hasProject = (query.data?.data?.length ?? 0) > 0;
    return <Navigate to={hasProject ? '/dashboard' : '/research'} replace />;
}
