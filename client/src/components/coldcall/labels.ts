/** Cold Call — komponent olmayan paylaşılan label yardımcıları. */

export function dispositionLabel(t: (k: string, f: string) => string, d: string | null): string {
    if (!d) return '—';
    const map: Record<string, string> = {
        connected: t('coldcall.dispConnected', 'Connected'),
        interested: t('coldcall.dispInterested', 'Interested'),
        not_interested: t('coldcall.dispNotInterested', 'Not interested'),
        callback: t('coldcall.dispCallback', 'Call back'),
        voicemail: t('coldcall.dispVoicemail', 'Voicemail'),
        no_answer: t('coldcall.dispNoAnswer', 'No answer'),
        busy: t('coldcall.dispBusy', 'Busy'),
        wrong_number: t('coldcall.dispWrongNumber', 'Wrong number'),
    };
    return map[d] ?? d;
}
