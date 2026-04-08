import { useState } from 'react';
import { Button } from '@mantine/core';
import { IconMessageReport } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import FeedbackModal from './FeedbackModal';

interface ErrorFeedbackButtonProps {
    /** Context label shown in prefilled title, e.g. "Pipeline", "Email Replies" */
    context: string;
    /** Optional extra description to prefill */
    description?: string;
    size?: 'xs' | 'sm' | 'md';
    variant?: 'light' | 'subtle' | 'outline';
}

export default function ErrorFeedbackButton({ context, description, size = 'sm', variant = 'light' }: ErrorFeedbackButtonProps) {
    const { t } = useTranslation();
    const [opened, setOpened] = useState(false);

    return (
        <>
            <Button
                variant={variant}
                color="red"
                size={size}
                leftSection={<IconMessageReport size={size === 'xs' ? 14 : 16} />}
                onClick={() => setOpened(true)}
            >
                {t('feedback.reportError', 'Hata Bildir')}
            </Button>
            <FeedbackModal
                opened={opened}
                onClose={() => setOpened(false)}
                prefill={{
                    type: 'bug_report',
                    title: `[${context}] `,
                    description: description || `Sayfa: ${window.location.pathname}\nTarih: ${new Date().toLocaleString('tr-TR')}`,
                }}
            />
        </>
    );
}
