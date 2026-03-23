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
} from '@mantine/core';
import { IconAlertTriangle, IconRefresh, IconHome, IconChevronDown, IconChevronUp } from '@tabler/icons-react';

interface Props {
    children: ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
    showDetails: boolean;
}

export default class ErrorBoundary extends Component<Props, State> {
    constructor(props: Props) {
        super(props);
        this.state = { hasError: false, error: null, showDetails: false };
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

    render() {
        if (!this.state.hasError) {
            return this.props.children;
        }

        const { error, showDetails } = this.state;

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
                            Beklenmeyen bir hata meydana geldi. Sayfayı yeniden yüklemeyi
                            deneyin veya ana sayfaya dönün.
                        </Text>
                    </Stack>

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
                                <Text size="xs" fw={600} c="red">
                                    {error?.name}: {error?.message}
                                </Text>
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
