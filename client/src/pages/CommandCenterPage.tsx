import { Navigate, useParams, useNavigate } from 'react-router-dom';
import { Container, Title, Tabs, Divider, Box } from '@mantine/core';
import {
    IconLayoutDashboard,
    IconHeartRateMonitor,
    IconUsers,
    IconBuilding,
    IconLink,
    IconMessageReport,
} from '@tabler/icons-react';
import type { Icon } from '@tabler/icons-react';
import type { ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { hasRolePermission } from '../lib/permissions';
import OpsOverviewTab from '../components/ops/OpsOverviewTab';
import OpsHealthTab from '../components/ops/OpsHealthTab';
import AdminUsersTab from '../components/admin/AdminUsersTab';
import AdminTenantsTab from '../components/admin/AdminTenantsTab';
import AdminMembershipsTab from '../components/admin/AdminMembershipsTab';
import AdminFeedbackTab from '../components/admin/AdminFeedbackTab';

interface TabDef {
    value: string;
    icon: Icon;
    labelKey: string;
    superadminOnly?: boolean;
    component: ComponentType;
}

// Operational tabs first (both internal roles), then the management group
// (superadmin only). URL stays /admin/:tab so existing bookmarks keep working.
const TABS: TabDef[] = [
    { value: 'overview', icon: IconLayoutDashboard, labelKey: 'ops.tabs.overview', component: OpsOverviewTab },
    { value: 'health', icon: IconHeartRateMonitor, labelKey: 'ops.tabs.health', component: OpsHealthTab },
    { value: 'users', icon: IconUsers, labelKey: 'admin.users', superadminOnly: true, component: AdminUsersTab },
    { value: 'tenants', icon: IconBuilding, labelKey: 'admin.tenants', superadminOnly: true, component: AdminTenantsTab },
    { value: 'memberships', icon: IconLink, labelKey: 'admin.memberships', superadminOnly: true, component: AdminMembershipsTab },
    { value: 'feedback', icon: IconMessageReport, labelKey: 'admin.feedback', superadminOnly: true, component: AdminFeedbackTab },
];

export default function CommandCenterPage() {
    const { user } = useAuth();
    const { t } = useTranslation();
    const { tab } = useParams();
    const navigate = useNavigate();

    const role = user?.role || '';
    if (!hasRolePermission(role, 'ops_panel')) {
        return <Navigate to="/dashboard" replace />;
    }

    const isSuperadmin = role === 'superadmin';
    const visibleTabs = TABS.filter((td) => !td.superadminOnly || isSuperadmin);

    const activeTab = tab || 'overview';
    const activeDef = visibleTabs.find((td) => td.value === activeTab);
    // Unknown tab, or a management tab requested by an ops_agent → back to overview
    if (!activeDef) {
        return <Navigate to="/admin/overview" replace />;
    }

    const firstManagementIndex = visibleTabs.findIndex((td) => td.superadminOnly);
    const ActiveComponent = activeDef.component;

    return (
        <Container size="xl" py="lg">
            <Title order={2} fw={700} mb="lg">
                {t('ops.title')}
            </Title>

            <Tabs
                value={activeTab}
                onChange={(value) => navigate(`/admin/${value}`)}
            >
                <Tabs.List>
                    {visibleTabs.map((td, i) => {
                        const TabIcon = td.icon;
                        return (
                            <Box key={td.value} style={{ display: 'contents' }}>
                                {i === firstManagementIndex && firstManagementIndex > 0 && (
                                    <Divider orientation="vertical" mx="xs" my={8} />
                                )}
                                <Tabs.Tab value={td.value} leftSection={<TabIcon size={16} />}>
                                    {t(td.labelKey)}
                                </Tabs.Tab>
                            </Box>
                        );
                    })}
                </Tabs.List>

                <Tabs.Panel value={activeTab}>
                    <ActiveComponent />
                </Tabs.Panel>
            </Tabs>
        </Container>
    );
}
