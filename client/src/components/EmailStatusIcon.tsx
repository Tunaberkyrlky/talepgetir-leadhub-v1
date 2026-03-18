import { Tooltip } from '@mantine/core';
import { IconCircleCheck, IconQuestionMark, IconCircleX } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';

type EmailStatus = 'valid' | 'uncertain' | 'invalid' | null;

interface EmailStatusIconProps {
    status: EmailStatus;
    size?: number;
    style?: React.CSSProperties;
}

export default function EmailStatusIcon({ status, size = 16, style }: EmailStatusIconProps) {
    const { t } = useTranslation();

    if (status === 'valid') {
        return (
            <Tooltip label={t('company.emailValid')} withArrow>
                <IconCircleCheck size={size} color="#40c057" style={style} />
            </Tooltip>
        );
    }
    if (status === 'uncertain') {
        return (
            <Tooltip label={t('company.emailUncertain')} withArrow>
                <IconQuestionMark size={size} color="#fab005" style={style} />
            </Tooltip>
        );
    }
    if (status === 'invalid') {
        return (
            <Tooltip label={t('company.emailInvalid')} withArrow>
                <IconCircleX size={size} color="#fa5252" style={style} />
            </Tooltip>
        );
    }

    return null;
}
