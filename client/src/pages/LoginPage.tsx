import { useState } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import {
    Paper,
    TextInput,
    PasswordInput,
    Button,
    Title,
    Text,
    Container,
    Stack,
    Alert,
    Box,
    Group,
} from '@mantine/core';
import { IconAlertCircle, IconBuilding } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';

export default function LoginPage() {
    const { login, isAuthenticated, isLoading } = useAuth();
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    if (isLoading) return null;
    if (isAuthenticated) return <Navigate to="/" replace />;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setLoading(true);

        try {
            await login(email, password);
            navigate('/', { replace: true });
        } catch (err: any) {
            const status = err?.response?.status;
            if (status === 401) {
                setError(t('auth.loginErrorInvalid', 'E-posta veya şifre hatalı. Lütfen tekrar deneyin.'));
            } else if (status === 429) {
                setError(t('auth.loginErrorRateLimit', 'Çok fazla deneme yapıldı. Lütfen bir süre bekleyin.'));
            } else if (!navigator.onLine || err?.code === 'ERR_NETWORK') {
                setError(t('auth.loginErrorNetwork', 'İnternet bağlantınızı kontrol edin.'));
            } else {
                setError(t('auth.loginError'));
            }
        } finally {
            setLoading(false);
        }
    };

    return (
        <Box
            style={{
                minHeight: '100vh',
                background: 'linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
            }}
        >
            <Container size={420} w="100%">
                <Stack align="center" mb="xl">
                    <Group gap="sm">
                        <IconBuilding size={40} color="#6c63ff" />
                        <Title order={1} c="white" fw={800}>
                            {t('app.title')}
                        </Title>
                    </Group>
                    <Text c="dimmed" size="sm">
                        {t('app.subtitle')}
                    </Text>
                </Stack>

                <Paper
                    withBorder
                    shadow="xl"
                    p={30}
                    radius="lg"
                    style={{
                        background: 'rgba(255, 255, 255, 0.95)',
                        backdropFilter: 'blur(10px)',
                        border: '1px solid rgba(255,255,255,0.2)',
                    }}
                >
                    <Title order={3} ta="center" mb={4}>
                        {t('auth.loginTitle')}
                    </Title>
                    <Text c="dimmed" size="sm" ta="center" mb="lg">
                        {t('auth.loginSubtitle')}
                    </Text>

                    {error && (
                        <Alert
                            icon={<IconAlertCircle size={16} />}
                            color="red"
                            variant="light"
                            mb="md"
                            radius="md"
                        >
                            {error}
                        </Alert>
                    )}

                    <form onSubmit={handleSubmit}>
                        <Stack gap="md">
                            <TextInput
                                label={t('auth.email')}
                                placeholder="email@example.com"
                                required
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                type="email"
                                radius="md"
                                size="md"
                            />
                            <PasswordInput
                                label={t('auth.password')}
                                placeholder="••••••••"
                                required
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                radius="md"
                                size="md"
                            />
                            <Button
                                fullWidth
                                type="submit"
                                loading={loading}
                                size="md"
                                radius="md"
                                mt="sm"
                                gradient={{ from: '#6c63ff', to: '#3b82f6', deg: 135 }}
                                variant="gradient"
                            >
                                {loading ? t('auth.loggingIn') : t('auth.loginButton')}
                            </Button>
                        </Stack>
                    </form>
                </Paper>
            </Container>
        </Box>
    );
}
