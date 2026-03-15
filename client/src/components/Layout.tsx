import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
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
    NavLink,
    Stack,
    Tooltip,
    Burger,
} from '@mantine/core';
import { useDisclosure, useMediaQuery } from '@mantine/hooks';
import {
    IconUser,
    IconLogout,
    IconLanguage,
    IconBuilding,
    IconSwitchHorizontal,
    IconSettings,
    IconChartBar,
    IconUsers,
    IconColumns,
    IconFileImport,
} from '@tabler/icons-react';
import SettingsModal from './SettingsModal';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { hasRolePermission } from '../lib/permissions';

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
    const [settingsOpened, { open: openSettings, close: closeSettings }] = useDisclosure(false);
    const [navbarOpened, { toggle: toggleNavbar, close: closeNavbar }] = useDisclosure(false);
    const location = useLocation();
    const navigate = useNavigate();
    const isMobile = useMediaQuery('(max-width: 768px)');
    const isIconOnly = useMediaQuery('(max-width: 992px)') && !isMobile;

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

    const navItems = [
        { path: '/dashboard', label: t('nav.dashboard'), icon: <IconChartBar size={20} /> },
        { path: '/companies', label: t('nav.companies'), icon: <IconBuilding size={20} /> },
        { path: '/people', label: t('nav.people'), icon: <IconUsers size={20} /> },
        { path: '/pipeline', label: t('nav.pipeline'), icon: <IconColumns size={20} /> },
        ...(hasRolePermission(user?.role || '', 'import')
            ? [{ path: '/import', label: t('nav.import'), icon: <IconFileImport size={20} /> }]
            : []),
    ];

    const handleNavClick = (path: string) => {
        navigate(path);
        if (isMobile) closeNavbar();
    };

    const navbarWidth = isMobile ? 0 : isIconOnly ? 60 : 200;

    return (
        <AppShell
            header={{ height: 60 }}
            navbar={{
                width: navbarWidth,
                breakpoint: 'sm',
                collapsed: { mobile: !navbarOpened },
            }}
            padding="md"
            styles={{
                header: {
                    background: 'linear-gradient(135deg, #1a1b2e 0%, #16213e 50%, #0f3460 100%)',
                    borderBottom: '1px solid rgba(255,255,255,0.08)',
                },
                navbar: {
                    background: 'var(--mantine-color-body)',
                    borderRight: '1px solid var(--mantine-color-gray-2)',
                },
                main: {
                    background: 'var(--mantine-color-body)',
                    minHeight: '100vh',
                },
            }}
        >
            <AppShell.Header p="xs" px="md">
                <Flex align="center" justify="space-between" h="100%">
                    {/* Burger for mobile + Logo */}
                    <Group gap="sm">
                        {isMobile && (
                            <Burger
                                opened={navbarOpened}
                                onClick={toggleNavbar}
                                color="white"
                                size="sm"
                            />
                        )}
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
                                        <Text size="sm" c="white" fw={500} visibleFrom="sm">
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
                                    leftSection={<IconSettings size={16} />}
                                    onClick={openSettings}
                                >
                                    {t('settings.title')}
                                </Menu.Item>
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

            <AppShell.Navbar p="xs">
                <Stack gap={4}>
                    {navItems.map((item) => {
                        const active = location.pathname === item.path ||
                            (item.path !== '/dashboard' && location.pathname.startsWith(item.path));
                        if (isIconOnly) {
                            return (
                                <Tooltip key={item.path} label={item.label} position="right" withArrow>
                                    <NavLink
                                        active={active}
                                        leftSection={item.icon}
                                        onClick={() => handleNavClick(item.path)}
                                        styles={{ root: { borderRadius: 8 } }}
                                    />
                                </Tooltip>
                            );
                        }
                        return (
                            <NavLink
                                key={item.path}
                                active={active}
                                label={item.label}
                                leftSection={item.icon}
                                onClick={() => handleNavClick(item.path)}
                                styles={{ root: { borderRadius: 8 } }}
                            />
                        );
                    })}
                </Stack>
            </AppShell.Navbar>

            <AppShell.Main>
                <Outlet />
            </AppShell.Main>

            <SettingsModal opened={settingsOpened} onClose={closeSettings} />
        </AppShell>
    );
}
