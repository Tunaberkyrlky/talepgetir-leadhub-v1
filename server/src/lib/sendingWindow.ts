/**
 * Sending Window — Drip kampanya gönderim penceresi hesabı (Faz 1.1).
 *
 * Pencere yerel saatte tanımlanır (gün listesi + başlangıç/bitiş saati), kampanyanın
 * IANA saat diliminde. Bağımlılıksız: tz dönüşümü için `Intl.DateTimeFormat` kullanır.
 * Gece-aşan aralıklar (bitiş ≤ başlangıç, ör. 22:00–06:00) desteklenir.
 *
 * DST kenar durumları (yılda 1 saatlik belirsiz dilim) için en fazla 1 saat sapabilir;
 * gönderim penceresi için kabul edilebilir.
 */

export interface SendingWindow {
    days?: number[];   // 0=Pazar … 6=Cumartesi (yerel)
    start?: string;    // "HH:MM" (yerel)
    end?: string;      // "HH:MM"
}

const DAY_MS = 86_400_000;
const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; weekday: number }

// Bir UTC anının verilen saat dilimindeki yerel parçaları.
function localParts(ms: number, timeZone: string): LocalParts {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', weekday: 'short',
    });
    const parts = dtf.formatToParts(new Date(ms));
    const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
    let hour = parseInt(get('hour'), 10);
    if (hour === 24) hour = 0; // bazı ortamlar gece yarısını 24 verir
    return {
        year: parseInt(get('year'), 10),
        month: parseInt(get('month'), 10),
        day: parseInt(get('day'), 10),
        hour,
        minute: parseInt(get('minute'), 10),
        weekday: WD[get('weekday')] ?? 0,
    };
}

// Yerel duvar-saatini (y,mo,d,h,mi) o saat diliminde temsil eden UTC ms.
function zonedTimeToUtc(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): number {
    const guess = Date.UTC(y, mo - 1, d, h, mi);
    const p = localParts(guess, timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const offset = asUtc - guess; // o anki tz ofseti
    return guess - offset;
}

function parseHM(s: string | undefined, fallback: number): number {
    if (!s) return fallback;
    const m = /^(\d{1,2}):(\d{2})$/.exec(s);
    if (!m) return fallback;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/** Verilen saat diliminde, fromMs'in yerel günü gece yarısının UTC ms'i. */
export function startOfLocalDay(fromMs: number, timeZone: string): number {
    const p = localParts(fromMs, timeZone);
    return zonedTimeToUtc(p.year, p.month, p.day, 0, 0, timeZone);
}

/** Bir sonraki yerel gün gece yarısının UTC ms'i. */
export function startOfNextLocalDay(fromMs: number, timeZone: string): number {
    const today = startOfLocalDay(fromMs, timeZone);
    return startOfLocalDay(today + DAY_MS + 3_600_000, timeZone); // +25h: DST'ye karşı güvenli
}

/**
 * Verilen günde, `s` (gün-içi dakika) anından itibaren penceredeki en erken dakika;
 * bugün artık açılış kalmadıysa null. Üç durum:
 *   start === end  → tüm gün açık (saat kısıtı yok)
 *   start <  end   → normal aralık [start, end)
 *   start >  end   → gece-aşan aralık [start, 24:00) ∪ [0, end)
 */
function earliestWindowMinute(s: number, startMin: number, endMin: number): number | null {
    if (startMin === endMin) return s;              // tüm gün
    if (startMin < endMin) {                         // normal
        if (s < startMin) return startMin;           // açılışı bekle
        if (s < endMin) return s;                    // pencere içi
        return null;                                 // bugünkü pencere kapandı
    }
    // gece-aşan (wrap): akşam bölümü + ertesi sabah bölümü
    if (s < endMin) return s;                        // gece yarısı sonrası bölümün içinde
    if (s < startMin) return startMin;               // boşlukta → akşam başlangıcını bekle
    return s;                                         // akşam bölümünün içinde
}

/**
 * fromMs pencere içindeyse fromMs döner; değilse bir sonraki açılış anının UTC ms'i.
 * Gece-aşan aralıkları (ör. 22:00–06:00) destekler — gün filtresi gönderim anının
 * yerel gününe bakar (Cuma gecesi penceresi Cumartesi izinli değilse gece yarısında
 * kesilir). Pencere gerçek bir kısıt getirmiyorsa (7 gün + 00:00–24:00) fromMs döner.
 */
export function nextSendableTime(fromMs: number, timeZone: string, window: SendingWindow): number {
    const days = window.days && window.days.length ? window.days : [0, 1, 2, 3, 4, 5, 6];
    const startMin = parseHM(window.start, 0);
    const endMin = parseHM(window.end, 24 * 60);

    if (days.length === 7 && startMin <= 0 && endMin >= 24 * 60) return fromMs;

    let probe = fromMs;
    for (let i = 0; i < 9; i++) {
        const p = localParts(probe, timeZone);
        const s = i === 0 ? p.hour * 60 + p.minute : 0; // ilk gün şimdiden, sonrakiler gün başından ara
        if (days.includes(p.weekday)) {
            const m = earliestWindowMinute(s, startMin, endMin);
            if (m !== null) {
                if (i === 0 && m === s) return fromMs; // şu an pencere içi → fromMs'i tam koru
                return zonedTimeToUtc(p.year, p.month, p.day, Math.floor(m / 60), m % 60, timeZone);
            }
        }
        const midnight = zonedTimeToUtc(p.year, p.month, p.day, 0, 0, timeZone);
        probe = midnight + DAY_MS + 3_600_000; // bir sonraki yerel güne geç
    }
    return fromMs; // güvenlik: asla sonsuza dek bloklama
}
