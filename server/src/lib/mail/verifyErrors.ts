/**
 * Convert SMTP (nodemailer) and IMAP (ImapFlow) verification failures into
 * user-actionable messages. Raw provider errors stay in server logs.
 *
 * The caller runs assertPublicHost before connecting, so this classification
 * cannot be used to probe internal or loopback hosts.
 */

export type MailVerifyKind = 'smtp' | 'imap';

export function describeMailVerifyError(err: unknown, kind: MailVerifyKind): string {
    const e = (err ?? {}) as Record<string, unknown>;
    const code = String(e.code ?? '');
    const responseCode = Number(e.responseCode ?? 0);
    const message = `${e.message ?? ''} ${e.response ?? ''} ${e.responseText ?? ''}`.toLowerCase();

    const authFailed =
        e.authenticationFailed === true ||
        code === 'EAUTH' ||
        [530, 534, 535, 454].includes(responseCode) ||
        /auth|credential|username and password|invalid login|5\.7\.\d/.test(message);
    if (authFailed) {
        return 'Kullanıcı adı veya şifre hatalı. Bazı sağlayıcılar normal şifre yerine "uygulama şifresi" ister (ör. Gmail: 2 adımlı doğrulama + uygulama şifresi).';
    }

    if (
        /self.?signed|certificate|cert has expired|altname|unable to verify|leaf signature/.test(message) ||
        ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED'].includes(code)
    ) {
        return 'Sunucunun güvenlik sertifikası doğrulanamadı. "Sunucu sertifikasını doğrulama" seçeneğini açıp tekrar deneyin (paylaşımlı hosting sunucularında sık görülür).';
    }

    if (/wrong version number|ssl routines|ssl3_|ssl23_|packet length too long|record layer|not a tls/.test(message)) {
        return 'SSL/TLS ayarı bu porta uymuyor. 465 portu için SSL/TLS açık, 587 (veya 25) için kapalı olmalı.';
    }

    if (code === 'ECONNREFUSED' || /econnrefused|connection refused/.test(message)) {
        return 'Sunucu bu porttan bağlantıyı reddetti. Port numarasını kontrol edin (SMTP: 465/587, IMAP: 993).';
    }

    if (['ENOTFOUND', 'EDNS', 'EAI_AGAIN'].includes(code) || /getaddrinfo|enotfound|not resolve/.test(message)) {
        return 'Sunucu adresi bulunamadı. Sunucu adını kontrol edin (ör. mail.firma.com).';
    }

    if (
        ['ETIMEDOUT', 'ESOCKET', 'ECONNECTION'].includes(code) ||
        /timed?\s*out|timeout|greeting never received|connection closed/.test(message)
    ) {
        return 'Sunucuya ulaşılamadı (zaman aşımı). Sunucu adı ve port doğru mu, sunucu dışarıya açık mı kontrol edin. Sunucu belirli IP’leri engelliyor olabilir.';
    }

    return kind === 'imap'
        ? 'IMAP (gelen) bağlantısı doğrulanamadı. Sunucu, port, kullanıcı adı ve şifreyi kontrol edin. Gmail için 2 adımlı doğrulama + uygulama şifresi ve IMAP erişimi gereklidir.'
        : 'SMTP bağlantısı doğrulanamadı. Sunucu, port, kullanıcı adı ve şifreyi kontrol edin.';
}
