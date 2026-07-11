import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { notifications } from '@mantine/notifications';
import { useTranslation } from 'react-i18next';
import TaskForm from '../components/tasks/TaskForm';

interface SuggestContact {
    id: string;
    first_name: string;
    last_name?: string | null;
}

interface SuggestArgs {
    companyId: string;
    initialContactId?: string;
    contacts?: SuggestContact[];
}

interface NextActionContextValue {
    // Aktivite kaydedildikten / görev tamamlandıktan sonra "sonraki aksiyonu planla" önerisini gösterir.
    suggestNextAction: (args: SuggestArgs) => void;
}

const NextActionContext = createContext<NextActionContextValue | null>(null);

interface FormState {
    opened: boolean;
    companyId: string;
    contactId?: string;
    contacts: SuggestContact[];
}

export function NextActionProvider({ children }: { children: ReactNode }) {
    const { t } = useTranslation();
    // Bekleyen öneri ref'te tutulur; yeni öneri geldiğinde üzerine yazılır, CTA hep en sonu açar.
    const pendingRef = useRef<SuggestArgs | null>(null);
    // Görünen önerinin benzersiz id'si — yeni öneri gösterilmeden önce bununla kapatılır.
    const lastIdRef = useRef<string | null>(null);
    // Her öneriye benzersiz id verir; aynı sabit id ile art arda show() çağrıları çakışmasın.
    const idCounterRef = useRef(0);
    // formState.opened'ın ref kopyası — stabil openForm callback'i güncel açık-durumunu okuyabilsin.
    const openedRef = useRef(false);
    const [formState, setFormState] = useState<FormState>({
        opened: false,
        companyId: '',
        contactId: undefined,
        contacts: [],
    });

    // CTA tıklanınca: toast'ı kapat, öneriyi tüket (tek kullanımlık) ve formu önceden doldurulmuş aç.
    const openForm = useCallback(() => {
        const pending = pendingRef.current;
        if (!pending) return;
        if (lastIdRef.current) {
            notifications.hide(lastIdRef.current);
            lastIdRef.current = null;
        }
        // Form zaten açıksa yeni öneri CTA'sını yoksay — mevcut draft yanlış firmaya kaymasın.
        if (openedRef.current) return;
        pendingRef.current = null;
        openedRef.current = true;
        setFormState({
            opened: true,
            companyId: pending.companyId,
            contactId: pending.initialContactId,
            contacts: pending.contacts ?? [],
        });
    }, []);

    const suggestNextAction = useCallback((args: SuggestArgs) => {
        if (!args.companyId) return;
        pendingRef.current = args;
        // Aynı anda en fazla bir öneri görünsün: önceki toast'ı kapat, sonra benzersiz id ile yenisini göster.
        if (lastIdRef.current) notifications.hide(lastIdRef.current);
        const id = `next-action-${++idCounterRef.current}`;
        lastIdRef.current = id;
        // Zorlamayan öneri: odak çalmaz, form açılmaz — kullanıcı tıklarsa açılır.
        notifications.show({
            id,
            color: 'violet',
            autoClose: 8000,
            withCloseButton: true,
            message: (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                    <span>{t('tasks.suggestNextTitle', 'Sonraki aksiyonu planlayın')}</span>
                    <button
                        type="button"
                        onClick={openForm}
                        style={{
                            border: 0,
                            background: 'transparent',
                            color: 'inherit',
                            textDecoration: 'underline',
                            cursor: 'pointer',
                            fontWeight: 600,
                            fontSize: 13,
                            padding: 0,
                            whiteSpace: 'nowrap',
                        }}
                    >
                        {t('tasks.suggestNextCta', 'Görev oluştur')}
                    </button>
                </div>
            ),
        });
    }, [t, openForm]);

    const closeForm = useCallback(() => {
        openedRef.current = false;
        setFormState((prev) => ({ ...prev, opened: false }));
    }, []);

    return (
        <NextActionContext.Provider value={{ suggestNextAction }}>
            {children}
            <TaskForm
                key={formState.companyId + ':' + (formState.contactId || '')}
                opened={formState.opened}
                onClose={closeForm}
                companyId={formState.companyId}
                contacts={formState.contacts}
                initialContactId={formState.contactId}
            />
        </NextActionContext.Provider>
    );
}

// eslint-disable-next-line react-refresh/only-export-components -- context dosyaları provider+hook'u birlikte export eder (repo deseni, bkz. StagesContext)
export function useNextAction() {
    const ctx = useContext(NextActionContext);
    if (!ctx) throw new Error('useNextAction must be used within NextActionProvider');
    return ctx;
}
