import { Tabs } from '@mantine/core';
import { IconUsers, IconSend, IconInbox, IconBan } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import LinkedInAccountsPanel from './LinkedInAccountsPanel';
import LinkedInCampaignsPanel from './LinkedInCampaignsPanel';
import LinkedInInboxPanel from './LinkedInInboxPanel';
import LinkedInSuppressionPanel from './LinkedInSuppressionPanel';

/** Faz 5 — the LinkedIn module home: accounts / campaigns / inbox / suppression sub-tabs. */
export default function LinkedInPanel() {
    const { t } = useTranslation();
    return (
        <Tabs defaultValue="accounts" keepMounted={false}>
            <Tabs.List mb="md">
                <Tabs.Tab value="accounts" leftSection={<IconUsers size={14} />}>
                    {t('research.linkedin.subtabs.accounts', 'Accounts')}
                </Tabs.Tab>
                <Tabs.Tab value="campaigns" leftSection={<IconSend size={14} />}>
                    {t('research.linkedin.subtabs.campaigns', 'Campaigns')}
                </Tabs.Tab>
                <Tabs.Tab value="inbox" leftSection={<IconInbox size={14} />}>
                    {t('research.linkedin.subtabs.inbox', 'Replies')}
                </Tabs.Tab>
                <Tabs.Tab value="suppression" leftSection={<IconBan size={14} />}>
                    {t('research.linkedin.subtabs.suppression', 'Do-not-contact')}
                </Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel value="accounts"><LinkedInAccountsPanel /></Tabs.Panel>
            <Tabs.Panel value="campaigns"><LinkedInCampaignsPanel /></Tabs.Panel>
            <Tabs.Panel value="inbox"><LinkedInInboxPanel /></Tabs.Panel>
            <Tabs.Panel value="suppression"><LinkedInSuppressionPanel /></Tabs.Panel>
        </Tabs>
    );
}
