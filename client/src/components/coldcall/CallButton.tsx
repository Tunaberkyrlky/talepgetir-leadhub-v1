/**
 * CallButton — CRM yüzeylerinden (şirket detayı, kişi kartı) tek tık arama.
 * Dialer'ı yeni global state ile değil, URL query paramlarıyla açar:
 * /cold-call?to=…&company_id=…&company_name=…&contact_id=…
 * Böylece Cold Call modülünün CRM sayfalarına tek dokunuşu bu küçük buton olur.
 */
import { ActionIcon, Tooltip } from '@mantine/core';
import { IconPhoneCall } from '@tabler/icons-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

interface CallButtonProps {
    phone: string;
    companyId?: string;
    companyName?: string;
    contactId?: string;
    size?: 'xs' | 'sm' | 'md';
}

export default function CallButton({ phone, companyId, companyName, contactId, size = 'sm' }: CallButtonProps) {
    const navigate = useNavigate();
    const { t } = useTranslation();

    const cleaned = phone.replace(/[\s().-]/g, '');

    return (
        <Tooltip label={t('coldcall.call', 'Call')} withArrow>
            <ActionIcon
                variant="subtle"
                color="violet"
                size={size}
                aria-label={t('coldcall.call', 'Call')}
                onClick={(e: React.MouseEvent) => {
                    e.stopPropagation();
                    const params = new URLSearchParams({ to: cleaned });
                    if (companyId) params.set('company_id', companyId);
                    if (companyName) params.set('company_name', companyName);
                    if (contactId) params.set('contact_id', contactId);
                    navigate(`/cold-call?${params.toString()}`);
                }}
            >
                <IconPhoneCall size={size === 'xs' ? 13 : 15} />
            </ActionIcon>
        </Tooltip>
    );
}
