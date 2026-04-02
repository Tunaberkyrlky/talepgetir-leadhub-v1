import { Navigate, useParams, useNavigate } from 'react-router-dom';
import { Container, Title, Tabs } from '@mantine/core';
import { IconUsers, IconBuilding, IconLink, IconSpeakerphone, IconMessageReport } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import AdminUsersTab from '../components/admin/AdminUsersTab';
import AdminTenantsTab from '../components/admin/AdminTenantsTab';
import AdminMembershipsTab from '../components/admin/AdminMembershipsTab';
import AdminCampaignsTab from '../components/admin/AdminCampaignsTab';
import AdminFeedbackTab from '../components/admin/AdminFeedbackTab';

export default function AdminPage() {
    const { user } = useAuth();
    const { t } = useTranslation();
    const { tab } = useParams();
    const navigate = useNavigate();

    if (user?.role !== 'superadmin') {
        return <Navigate to="/dashboard" replace />;
    }

    const activeTab = tab || 'users';

    return (
        <Container size="xl" py="lg">
            <Title order={2} fw={700} mb="lg">
                {t('admin.title')}
            </Title>

            <Tabs
                value={activeTab}
                onChange={(value) => navigate(`/admin/${value}`)}
            >
                <Tabs.List>
                    <Tabs.Tab value="users" leftSection={<IconUsers size={16} />}>
                        {t('admin.users')}
                    </Tabs.Tab>
                    <Tabs.Tab value="tenants" leftSection={<IconBuilding size={16} />}>
                        {t('admin.tenants')}
                    </Tabs.Tab>
                    <Tabs.Tab value="memberships" leftSection={<IconLink size={16} />}>
                        {t('admin.memberships')}
                    </Tabs.Tab>
                    <Tabs.Tab value="campaigns" leftSection={<IconSpeakerphone size={16} />}>
                        {t('admin.campaigns')}
                    </Tabs.Tab>
                    <Tabs.Tab value="feedback" leftSection={<IconMessageReport size={16} />}>
                        {t('admin.feedback')}
                    </Tabs.Tab>
                </Tabs.List>

                <Tabs.Panel value="users">
                    <AdminUsersTab />
                </Tabs.Panel>
                <Tabs.Panel value="tenants">
                    <AdminTenantsTab />
                </Tabs.Panel>
                <Tabs.Panel value="memberships">
                    <AdminMembershipsTab />
                </Tabs.Panel>
                <Tabs.Panel value="campaigns">
                    <AdminCampaignsTab />
                </Tabs.Panel>
                <Tabs.Panel value="feedback">
                    <AdminFeedbackTab />
                </Tabs.Panel>
            </Tabs>
        </Container>
    );
}
