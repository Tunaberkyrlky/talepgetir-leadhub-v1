import { Component, type ReactNode } from 'react';
import {
    Container,
    Title,
    Text,
    Button,
    Stack,
    Group,
    Paper,
    ThemeIcon,
    Divider,
    Code,
    Collapse,
    Alert,
} from '@mantine/core';
import {
    IconAlertTriangle,
    IconRefresh,
    IconHome,
    IconChevronDown,
    IconChevronUp,
    IconWifi,
    IconLock,
    IconInfoCircle,
    IconCopy,
    IconCheck,
} from '@tabler/icons-react';
import ErrorFeedbackButton from './ErrorFeedbackButton';

interface Props {
    children: ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
    showDetails: boolean;
    copied: boolean;
}

interface ErrorHint {
    icon: ReactNode;
    color: string;
    title: string;
    description: string;
}

/** Hata mesajını analiz ederek kullanıcıya anlamlı ipucu döndürür */
function getErrorHint(error: Error | null): ErrorHint | null {
    if (!error) return null;

    const msg = error.message || '';

    // Oturum / Provider bağlamı hataları (HMR, yenileme, auth context sorunları)
    if (
        msg.includes('AuthProvider') ||
        msg.includes('useAuth') ||
        msg.includes('Provider') ||
        msg.includes('Context')
    ) {
        return {
            icon: <IconWifi size={18} />,
            color: 'blue',
            title: 'Oturum bağlantısı koptu',
            description:
                'Sayfa uzun süre açık kaldı ya da arka plan bağlantısı kesildi. ' +
                'Sayfayı yenilemeniz yeterli; oturumunuz kaybolmaz.',
        };
    }

    // Yetki / erişim hataları
    if (
        msg.includes('Unauthorized') ||
        msg.includes('Forbidden') ||
        msg.includes('403') ||
        msg.includes('401')
    ) {
        return {
            icon: <IconLock size={18} />,
            color: 'orange',
            title: 'Erişim izniniz yok',
            description:
                'Bu sayfaya erişim yetkiniz bulunmuyor ya da oturumunuz sona erdi. ' +
                'Lütfen tekrar giriş yapın.',
        };
    }

    // Ağ / sunucu bağlantı hataları
    if (
        msg.includes('Network') ||
        msg.includes('fetch') ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('timeout') ||
        msg.includes('Failed to fetch')
    ) {
        return {
            icon: <IconWifi size={18} />,
            color: 'yellow',
            title: 'Sunucuya ulaşılamıyor',
            description:
                'İnternet bağlantınızı kontrol edin. Sorun devam ediyorsa ' +
                'birkaç dakika bekleyip sayfayı yenilemeyi deneyin.',
        };
    }

    // Bilinmeyen modül / chunk yükleme hatası (ör. yeni deploy sonrası)
    if (
        msg.includes('Loading chunk') ||
        msg.includes('dynamically imported module') ||
        msg.includes('Failed to load')
    ) {
        return {
            icon: <IconRefresh size={18} />,
            color: 'blue',
            title: 'Uygulama güncellendi',
            description:
                'Uygulamanın yeni bir sürümü yayınlandı. ' +
                'Sayfayı yenilemeniz yeterli, her şey normale dönecek.',
        };
    }

    return null;
}

export default class ErrorBoundary extends Component<Props, State> {
    constructor(props: Props) {
        super(props);
        this.state = { hasError: false, error: null, showDetails: false, copied: false };
    }

    static getDerivedStateFromError(error: Error): Partial<State> {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, info: React.ErrorInfo) {
        console.error('[ErrorBoundary]', error, info.componentStack);
    }

    handleReload = () => {
        window.location.reload();
    };

    handleGoHome = () => {
        window.location.href = '/dashboard';
    };

    toggleDetails = () => {
        this.setState((prev) => ({ showDetails: !prev.showDetails }));
    };

    handleCopy = () => {
        const { error } = this.state;
        const text = `${error?.name}: ${error?.message}\n\n${error?.stack ?? ''}`;
        navigator.clipboard.writeText(text).then(() => {
            this.setState({ copied: true });
            setTimeout(() => this.setState({ copied: false }), 2000);
        });
    };

    render() {
        if (!this.state.hasError) {
            return this.props.children;
        }

        const { error, showDetails, copied } = this.state;
        const hint = getErrorHint(error);

        return (
            <Container size={480} py={80}>
                <Stack align="center" gap="lg">
                    <ThemeIcon
                        size={72}
                        radius="xl"
                        variant="light"
                        color="red"
                    >
                        <IconAlertTriangle size={40} />
                    </ThemeIcon>

                    <Stack align="center" gap={4}>
                        <Title order={2} ta="center">
                            Bir sorun oluştu
                        </Title>
                        <Text c="dimmed" ta="center" size="md">
                            Beklenmeyen bir hata meydana geldi. Aşağıdaki bilgilendirmeyi
                            okuyun ya da sayfayı yenileyin.
                        </Text>
                    </Stack>

                    {/* Hataya özgü kullanıcı dostu açıklama */}
                    {hint ? (
                        <Alert
                            icon={hint.icon}
                            color={hint.color}
                            title={hint.title}
                            radius="md"
                            w="100%"
                        >
                            {hint.description}
                        </Alert>
                    ) : (
                        <Alert
                            icon={<IconInfoCircle size={18} />}
                            color="gray"
                            title="Ne yapabilirsiniz?"
                            radius="md"
                            w="100%"
                        >
                            Sayfayı yenilemeyi deneyin. Sorun tekrarlanırsa aşağıdaki
                            &quot;Hata Bildir&quot; butonunu kullanarak bize bildirin.
                        </Alert>
                    )}

                    <Group>
                        <Button
                            leftSection={<IconRefresh size={18} />}
                            onClick={this.handleReload}
                            variant="filled"
                        >
                            Sayfayı Yenile
                        </Button>
                        <Button
                            leftSection={<IconHome size={18} />}
                            onClick={this.handleGoHome}
                            variant="light"
                        >
                            Ana Sayfa
                        </Button>
                        <ErrorFeedbackButton
                            context="Uygulama Hatası"
                            description={error ? `${error.name}: ${error.message}\n\nSayfa: ${window.location.pathname}\n\n${error.stack?.slice(0, 500) || ''}` : undefined}
                        />
                    </Group>

                    <Divider w="100%" />

                    <Button
                        variant="subtle"
                        color="gray"
                        size="xs"
                        onClick={this.toggleDetails}
                        rightSection={
                            showDetails
                                ? <IconChevronUp size={14} />
                                : <IconChevronDown size={14} />
                        }
                    >
                        Teknik Detaylar
                    </Button>

                    <Collapse in={showDetails} w="100%">
                        <Paper p="md" bg="gray.0" radius="md" w="100%">
                            <Stack gap="xs">
                                <Group justify="space-between" align="center">
                                    <Text size="xs" fw={600} c="red">
                                        {error?.name}: {error?.message}
                                    </Text>
                                    <Button
                                        size="xs"
                                        variant="subtle"
                                        color={copied ? 'green' : 'gray'}
                                        leftSection={copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
                                        onClick={this.handleCopy}
                                    >
                                        {copied ? 'Kopyalandı' : 'Kopyala'}
                                    </Button>
                                </Group>
                                {error?.stack && (
                                    <Code
                                        block
                                        style={{
                                            fontSize: 11,
                                            maxHeight: 200,
                                            overflow: 'auto',
                                            whiteSpace: 'pre-wrap',
                                            wordBreak: 'break-word',
                                        }}
                                    >
                                        {error.stack}
                                    </Code>
                                )}
                            </Stack>
                        </Paper>
                    </Collapse>
                </Stack>
            </Container>
        );
    }
}
