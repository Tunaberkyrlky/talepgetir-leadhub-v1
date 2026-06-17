import { SegmentedControl } from '@mantine/core';
import { IconBuilding, IconUsers } from '@tabler/icons-react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

/**
 * Header switch shared by the Companies (LeadsPage) and People (PeoplePage)
 * views — they live behind a single sidebar entry, defaulting to Companies,
 * with a one-click switch to People. Reflects the current route and navigates
 * to the other on change.
 */
export default function CompaniesPeopleToggle() {
    const navigate = useNavigate();
    const location = useLocation();
    const { t } = useTranslation();

    const value = location.pathname.startsWith('/people') ? 'people' : 'companies';

    return (
        <SegmentedControl
            value={value}
            onChange={(v) => navigate(v === 'people' ? '/people' : '/companies')}
            color="violet"
            radius="md"
            size="md"
            data={[
                {
                    value: 'companies',
                    label: (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
                            <IconBuilding size={16} /> {t('nav.companies')}
                        </span>
                    ),
                },
                {
                    value: 'people',
                    label: (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
                            <IconUsers size={16} /> {t('nav.people')}
                        </span>
                    ),
                },
            ]}
        />
    );
}
