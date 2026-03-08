import { Navigate, Outlet } from 'react-router-dom';
import classes from './Layout.module.css';
import {
    AppShell,
    Group,
    Title,
    Text,
    Menu,
    ActionIcon,
    Badge,
    UnstyledButton,
    Flex,
    Select,
} from '@mantine/core';
import {
    IconUser,
    IconLogout,
    IconLanguage,
    IconBuilding,
    IconSwitchHorizontal,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';

export default function Layout() {
    const {
        user,
        logout,
        isAuthenticated,
        isLoading,
        activeTenantId,
        activeTenantName,
        accessibleTenants,
        switchTenant,
        canSwitchTenants,
    } = useAuth();
    const { t, i18n } = useTranslation();

    if (isLoading) return null;
    if (!isAuthenticated) return <Navigate to="/login" replace />;

    const toggleLanguage = () => {
        const newLang = i18n.language === 'tr' ? 'en' : 'tr';
        i18n.changeLanguage(newLang);
        localStorage.setItem('lang', newLang);
    };

    const isOpsOrAdmin = user?.role === 'superadmin' || user?.role === 'ops_agent';

    const tenantSelectData = accessibleTenants.map((t) => ({
        value: t.id,
        label: t.name,
    }));

    return (
        <AppShell
            header={{ height: 60 }}
            padding="md"
            styles={{
                header: {
                    background: 'linear-gradient(135deg, #1a1b2e 0%, #16213e 50%, #0f3460 100%)',
                    borderBottom: '1px solid rgba(255,255,255,0.08)',
                },
                main: {
                    background: '#f8f9fa',
                    minHeight: '100vh',
                },
            }}
        >
            <AppShell.Header p="xs" px="md">
                <Flex align="center" justify="space-between" h="100%">
                    {/* Logo + Title */}
                    <Group gap="sm">
                        <IconBuilding size={28} color="#6c63ff" />
                        <Title order={3} c="white" fw={700}>
                            {t('app.title')}
                        </Title>
                    </Group>

                    {/* Right side */}
                    <Group gap="md">
                        {/* Tenant switcher — only for superadmin & ops_agent with multiple tenants */}
                        {isOpsOrAdmin && canSwitchTenants ? (
                            <Select
                                data={tenantSelectData}
                                value={activeTenantId}
                                onChange={(value) => value && switchTenant(value)}
                                leftSection={<IconSwitchHorizontal size={16} color="#6c63ff" />}
                                size="sm"
                                w={220}
                                placeholder={t('tenant.selectTenant')}
                                styles={{
                                    input: {
                                        background: 'rgba(255,255,255,0.1)',
                                        border: '1px solid rgba(255,255,255,0.15)',
                                        color: 'white',
                                        fontWeight: 500,
                                    },
                                    dropdown: {
                                        background: '#1a1b2e',
                                        border: '1px solid rgba(255,255,255,0.15)',
                                    },
                                    option: {
                                        color: 'white',
                                    },
                                }}
                                classNames={{ option: classes.tenantOption }}
                            />
                        ) : (
                            /* Static tenant badge for client roles or single-tenant users */
                            activeTenantName && (
                                <Badge
                                    variant="light"
                                    color="violet"
                                    size="lg"
                                    radius="sm"
                                    styles={{
                                        root: {
                                            textTransform: 'none',
                                            fontWeight: 500,
                                        },
                                    }}
                                >
                                    {activeTenantName}
                                </Badge>
                            )
                        )}

                        {/* Language toggle */}
                        <ActionIcon
                            variant="subtle"
                            color="gray.3"
                            onClick={toggleLanguage}
                            title={i18n.language === 'tr' ? 'Switch to English' : 'Türkçeye Geç'}
                        >
                            <IconLanguage size={20} />
                        </ActionIcon>

                        {/* User menu */}
                        <Menu shadow="md" width={200} position="bottom-end">
                            <Menu.Target>
                                <UnstyledButton>
                                    <Group gap="xs">
                                        <IconUser size={20} color="white" />
                                        <Text size="sm" c="white" fw={500}>
                                            {user?.email}
                                        </Text>
                                    </Group>
                                </UnstyledButton>
                            </Menu.Target>

                            <Menu.Dropdown>
                                <Menu.Label>
                                    {user?.role && (
                                        <Badge size="sm" variant="light" color="blue">
                                            {user.role}
                                        </Badge>
                                    )}
                                </Menu.Label>
                                <Menu.Divider />
                                <Menu.Item
                                    leftSection={<IconLogout size={16} />}
                                    color="red"
                                    onClick={logout}
                                >
                                    {t('auth.logout')}
                                </Menu.Item>
                            </Menu.Dropdown>
                        </Menu>
                    </Group>
                </Flex>
            </AppShell.Header>

            <AppShell.Main>
                <Outlet />
            </AppShell.Main>
        </AppShell>
    );
}
