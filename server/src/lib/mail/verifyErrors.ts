/**
 * Map a caught SMTP (nodemailer) or IMAP (ImapFlow) verification error to a
 * SPECIFIC, user-actionable Turkish message, so a failed "Connect mailbox" tells
 * the user WHICH thing is wrong (password vs port/TLS vs certificate vs
 * unreachable) instead of one generic line.
 *
 * Security note: the SSRF guard (assertPublicHost) already blocks internal/loopback
 * targets before we ever connect, so distinguishing "auth failed" from "couldn't
 * connect" only ever concerns PUBLIC mail hosts — low-risk, and worth it for
 * self-service diagnosis. The raw error still goes to the server log only.
 */

export type MailVerifyKind = 'smtp' | 'imap';

export function describeMailVerifyError(err: unknown, kind: MailVerifyKind): string {
    const e = (err ?? {}) as Record<string, unknown>;
    const code = String(e.code ?? '');
    const respCode = Number(e.responseCode ?? 0);
    const msg = `${e.message ?? ''} ${e.response ?? ''} ${e.responseText ?? ''}`.toLowerCase();

    // 1. Authentication rejected — host was reachable, credentials wrong.
    const authFailed =
        e.authenticationFailed === true ||
        code === 'EAUTH' ||
        [530, 534, 535, 454].includes(respCode) ||
        /auth|credential|username and password|invalid login|5\.7\.\d/.test(msg);
    if (authFailed) {
        return 'Kullanıcı adı veya şifre hatalı. Bazı sağlayıcılar normal şifre yerine "uygulama şifresi" ister (ör. Gmail: 2 adımlı doğrulama + uygulama şifresi).';
    }

    // 2. TLS certificate could not be verified (self-signed / hostname mismatch).
    if (
        /self.?signed|certificate|cert has expired|altname|unable to verify|leaf signature/.test(msg) ||
        ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED'].includes(code)
    ) {
        return 'Sunucunun güvenlik sertifikası doğrulanamadı. "Sunucu sertifikasını doğrulama" seçeneğini açıp tekrar deneyin (paylaşımlı hosting sunucularında sık görülür).';
    }

    // 3. TLS/SSL handshake mismatch — almost always a wrong secure↔port combo.
    if (/wrong version number|ssl routines|ssl3_|ssl23_|packet length too long|record layer|not a tls/.test(msg)) {
        return 'SSL/TLS ayarı bu porta uymuyor. 465 portu için SSL/TLS açık, 587 (veya 25) için kapalı olmalı.';
    }

    // 4. Connection refused — nothing is listening on that host:port.
    if (code === 'ECONNREFUSED' || /econnrefused|connection refused/.test(msg)) {
        return 'Sunucu bu porttan bağlantıyı reddetti. Port numarasını kontrol edin (SMTP: 465/587, IMAP: 993).';
    }

    // 5. DNS — the server name does not resolve.
    if (['ENOTFOUND', 'EDNS', 'EAI_AGAIN'].includes(code) || /getaddrinfo|enotfound|not resolve/.test(msg)) {
        return 'Sunucu adresi bulunamadı. Sunucu adını kontrol edin (ör. mail.firma.com).';
    }

    // 6. Timeout / unreachable — host didn't answer in time (wrong port, firewall,
    //    or the mail host blocks our server's IP).
    if (
        code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'ECONNECTION' ||
        /timed?\s*out|timeout|greeting never received|connection closed/.test(msg)
    ) {
        return 'Sunucuya ulaşılamadı (zaman aşımı). Sunucu adı ve port doğru mu, sunucu dışarıya açık mı kontrol edin. Sunucu belirli IP’leri engelliyor olabilir.';
    }

    // 7. Fallback — keep the original generic wording per channel.
    return kind === 'imap'
        ? 'IMAP (gelen) bağlantısı doğrulanamadı. Sunucu, port, kullanıcı adı ve şifreyi kontrol edin. Gmail için 2 adımlı doğrulama + uygulama şifresi ve IMAP erişimi gereklidir.'
        : 'SMTP bağlantısı doğrulanamadı. Sunucu, port, kullanıcı adı ve şifreyi kontrol edin.';
}
