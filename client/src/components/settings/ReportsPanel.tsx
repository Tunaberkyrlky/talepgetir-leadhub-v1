import { useState } from 'react';
import { Stack, Group, Select, Button, Text } from '@mantine/core';
import { IconDownload } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { showSuccess, showErrorFromApi } from '../../lib/notifications';
import { useAuth } from '../../contexts/AuthContext';

const MONTH_NAMES = [
    'Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
    'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık',
];

export default function ReportsPanel() {
    const { t } = useTranslation();
    const { activeTenantName } = useAuth();
    const now = new Date();
    const [year, setYear] = useState(String(now.getFullYear()));
    const [month, setMonth] = useState(String(now.getMonth() + 1));
    const [loading, setLoading] = useState(false);

    const currentYear = now.getFullYear();
    const yearOptions = Array.from({ length: currentYear - 2022 }, (_, i) => {
        const y = String(currentYear - i);
        return { value: y, label: y };
    });
    const monthOptions = MONTH_NAMES.map((name, i) => ({ value: String(i + 1), label: name }));

    async function handleDownload() {
        setLoading(true);
        try {
            const pad = (n: number) => String(n).padStart(2, '0');
            const clientName = (activeTenantName ?? 'Client')
                .replace(/[^a-zA-Z0-9ğüşıöçĞÜŞİÖÇ\s-]/g, '')
                .trim()
                .replace(/\s+/g, '-');
            const response = await api.get('/statistics/report/monthly', {
                params: { year, month, clientName },
                responseType: 'blob',
                timeout: 90_000,
            });
            const filename = `${clientName}-${year}-${pad(Number(month))}-TG-Rapor.xlsx`;
            const url = URL.createObjectURL(response.data as Blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            showSuccess(t('report.downloadSuccess'));
        } catch (err) {
            showErrorFromApi(err, t('report.downloadError'));
        } finally {
            setLoading(false);
        }
    }

    return (
        <Stack gap="md">
            <Text size="sm" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.5px' }}>
                {t('report.modalTitle')}
            </Text>
            <Text size="xs" c="dimmed">
                {t('report.panelDesc')}
            </Text>
            <Group grow>
                <Select
                    label={t('report.year')}
                    data={yearOptions}
                    value={year}
                    onChange={(v) => setYear(v ?? year)}
                    allowDeselect={false}
                />
                <Select
                    label={t('report.month')}
                    data={monthOptions}
                    value={month}
                    onChange={(v) => setMonth(v ?? month)}
                    allowDeselect={false}
                />
            </Group>
            <Button
                color="violet"
                leftSection={<IconDownload size={16} />}
                loading={loading}
                onClick={handleDownload}
            >
                {t('report.downloadButton')}
            </Button>
        </Stack>
    );
}
