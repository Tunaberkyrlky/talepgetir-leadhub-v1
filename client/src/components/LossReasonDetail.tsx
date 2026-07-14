import { Badge, Text, type TextProps } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { parseLossReasonMarker } from '../lib/qualification';

interface Props {
    detail: string | null | undefined;
    /** Text props forwarded to the free-text remainder, so each call site keeps its own styling. */
    textProps?: TextProps;
}

// Renders an activity / closing-report detail, surfacing the standardized loss-reason
// code (folded by the server as a "[loss_reason_code:x]" marker) as a localized badge and
// NEVER showing the raw marker to the user. Detail without a marker renders as plain text,
// so this is safe to use wherever an activity detail is shown (emails, notes, etc.).
export default function LossReasonDetail({ detail, textProps }: Props) {
    const { t } = useTranslation();
    const { code, rest } = parseLossReasonMarker(detail);
    if (!code && !rest) return null;
    return (
        <>
            {code && (
                <Badge size="xs" variant="light" color="orange" radius="sm" mt={4}>
                    {t(`qualification.lossReasonOptions.${code}`)}
                </Badge>
            )}
            {rest && <Text {...textProps}>{rest}</Text>}
        </>
    );
}
