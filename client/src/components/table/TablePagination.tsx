import { Box, Flex, Text, Pagination, TextInput } from '@mantine/core';
import { useTranslation } from 'react-i18next';

interface TablePaginationProps {
    page: number;
    totalPages: number;
    total: number;
    pageSize: number;
    onChange: (page: number) => void;
}

/**
 * The pagination footer shared by the CRM list tables: a "showing X–Y of N"
 * label, the page control, and a go-to-page input. Renders nothing when there is
 * a single page.
 */
export function TablePagination({ page, totalPages, total, pageSize, onChange }: TablePaginationProps) {
    const { t } = useTranslation();
    if (totalPages <= 1) return null;

    return (
        <Box p="md">
            <Flex justify="space-between" align="center" gap="sm" wrap="wrap">
                <Text size="sm" c="dimmed">
                    {t('pagination.showing')} {((page - 1) * pageSize) + 1}–
                    {Math.min(page * pageSize, total)} {t('pagination.of')} {total}
                </Text>
                <Flex align="center" gap="xs">
                    <Pagination
                        total={totalPages}
                        value={page}
                        onChange={onChange}
                        color="violet"
                        radius="md"
                        size="sm"
                    />
                    <TextInput
                        key={page}
                        size="xs"
                        placeholder={t('pagination.goTo')}
                        style={{ width: 110 }}
                        defaultValue=""
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                const val = parseInt((e.currentTarget as HTMLInputElement).value, 10);
                                if (!isNaN(val)) {
                                    onChange(Math.max(1, Math.min(val, totalPages)));
                                }
                                (e.currentTarget as HTMLInputElement).value = '';
                            }
                        }}
                    />
                </Flex>
            </Flex>
        </Box>
    );
}
