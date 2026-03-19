import { Text, Group, Badge } from '@mantine/core';
import TruncatedText from './TruncatedText';

interface TranslatableFieldProps {
    original: string | null | undefined;
    translated: string | null | undefined;
    showTranslation: boolean;
    maxLength?: number;
}

export default function TranslatableField({ original, translated, showTranslation, maxLength }: TranslatableFieldProps) {
    if (!original) return null;

    if (showTranslation && translated) {
        return (
            <div>
                <TruncatedText size="sm" maxLength={maxLength} inline>{original}</TruncatedText>
                <Group gap={4} mt={4}>
                    <Badge size="xs" variant="light" color="violet" style={{ flexShrink: 0 }}>TR</Badge>
                    <Text size="sm" c="violet" fs="italic">{translated}</Text>
                </Group>
            </div>
        );
    }

    return <TruncatedText size="sm" maxLength={maxLength} inline>{original}</TruncatedText>;
}
