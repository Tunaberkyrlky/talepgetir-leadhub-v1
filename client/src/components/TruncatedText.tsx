import { useState } from 'react';
import { Text, Popover, UnstyledButton, type TextProps } from '@mantine/core';
import { useTranslation } from 'react-i18next';

interface TruncatedTextProps extends Omit<TextProps, 'children'> {
    children: string | null | undefined;
    fallback?: string;
    maxLength?: number;
    /** true = inline expand/collapse (detail pages), false = popover (tables) */
    inline?: boolean;
}

export default function TruncatedText({ children, fallback = '—', maxLength = 200, inline = false, ...textProps }: TruncatedTextProps) {
    const { t } = useTranslation();
    const [expanded, setExpanded] = useState(false);
    const text = children || '';

    if (!text) {
        return <Text {...textProps}>{fallback}</Text>;
    }

    if (text.length <= maxLength) {
        return <Text {...textProps}>{text}</Text>;
    }

    if (inline) {
        return (
            <Text {...textProps} style={{ ...((textProps.style as object) || {}), whiteSpace: 'pre-wrap' }}>
                {expanded ? text : text.slice(0, maxLength) + '…'}{' '}
                <UnstyledButton
                    component="span"
                    onClick={(e) => { e.stopPropagation(); setExpanded(v => !v); }}
                    style={{ color: 'var(--mantine-color-violet-5)', fontSize: 'inherit', fontWeight: 500 }}
                >
                    {expanded ? t('common.showLess') : t('common.showMore')}
                </UnstyledButton>
            </Text>
        );
    }

    return (
        <Popover
            opened={expanded}
            onChange={setExpanded}
            width={400}
            shadow="md"
            withArrow
            position="bottom-start"
        >
            <Popover.Target>
                <Text {...textProps}>
                    {text.slice(0, maxLength) + '…'}{' '}
                    <UnstyledButton
                        component="span"
                        onClick={(e) => { e.stopPropagation(); setExpanded(o => !o); }}
                        style={{ color: 'var(--mantine-color-violet-5)', fontSize: 'inherit', fontWeight: 500 }}
                    >
                        {t('common.showMore')}
                    </UnstyledButton>
                </Text>
            </Popover.Target>
            <Popover.Dropdown
                p="md"
                style={{ maxHeight: 300, overflowY: 'auto' }}
                onClick={(e) => e.stopPropagation()}
            >
                <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{text}</Text>
            </Popover.Dropdown>
        </Popover>
    );
}
