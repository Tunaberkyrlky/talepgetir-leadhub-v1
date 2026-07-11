/**
 * Disposable / throwaway email domains (intake hardening, MEGA §3.6).
 *
 * A curated static core list of the most common temporary-inbox providers
 * (mailinator, guerrillamail, 10minutemail, yopmail, …). Deliberately a small
 * hand-kept Set rather than an external package: a disposable address does NOT
 * reject a lead — it only routes it to the Review queue (false-positive cost is
 * high), so exhaustive coverage is unnecessary and a runtime dependency is not
 * worth the supply-chain surface. Extend as new throwaway domains surface.
 *
 * Source: distilled from the widely-mirrored community "disposable-email-domains"
 * blocklists (the high-traffic head of that long tail).
 */

const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set([
  // mailinator family
  'mailinator.com', 'mailinator.net', 'mailinator2.com', 'reallymymail.com',
  'sogetthis.com', 'suremail.info', 'thisisnotmyrealemail.com', 'binkmail.com',
  'bobmail.info', 'devnullmail.com', 'spamherelots.com', 'spam.la',
  // guerrillamail family
  'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamail.biz',
  'guerrillamail.de', 'guerrillamailblock.com', 'grr.la', 'sharklasers.com',
  'pokemail.net', 'spam4.me',
  // 10minutemail family
  '10minutemail.com', '10minutemail.net', '10minutemail.org', '10minutemail.co.uk',
  '10minutemail.de', '20minutemail.com', '20email.eu', '33mail.com',
  // yopmail family
  'yopmail.com', 'yopmail.net', 'yopmail.fr', 'cool.fr.nf', 'jetable.fr.nf',
  'nospam.ze.tc', 'nomail.xl.cx', 'mega.zik.dj', 'speed.1s.fr', 'courriel.fr.nf',
  'moncourrier.fr.nf', 'monemail.fr.nf', 'monmail.fr.nf',
  // temp-mail / tempmail family
  'tempmail.com', 'temp-mail.org', 'tempmail.net', 'tempmail.de', 'tempmailo.com',
  'tempail.com', 'tempinbox.com', 'tempmailaddress.com', 'temp-mail.io',
  'tmail.ws', 'tmpmail.org', 'tmpmail.net', 'tmpeml.com', 'tmpbox.net',
  'moakt.com', 'moakt.cc', 'disposablemail.com', 'dispostable.com',
  // getnada / other high-traffic throwaways
  'getnada.com', 'nada.email', 'inboxbear.com', 'trashmail.com', 'trashmail.net',
  'trashmail.de', 'trash-mail.com', 'trashmail.io', 'wegwerfmail.de', 'wegwerfmail.net',
  'kurzepost.de', 'objectmail.com', 'proxymail.eu', 'rcpt.at', 'lroid.com',
  'fakeinbox.com', 'fakemailgenerator.com', 'mailnesia.com', 'mailnull.com',
  'maildrop.cc', 'mailcatch.com', 'mailexpire.com', 'maileater.com',
  'spambog.com', 'spambog.de', 'spambog.ru', 'spambox.us', 'spamgourmet.com',
  'mytemp.email', 'mvrht.net', 'mailde.de', 'mailde.info', 'mailmoat.com',
  'throwawaymail.com', 'throwam.com', 'discard.email', 'discardmail.com',
  'discardmail.de', 'mailtemp.info', 'emailtemporario.com.br', 'emailondeck.com',
  'einrot.com', 'fleckens.hu', 'gustr.com', 'jourrapide.com', 'dayrep.com',
  'armyspy.com', 'cuvox.de', 'rhyta.com', 'superrito.com', 'teleworm.us',
  'mailsac.com', 'burnermail.io', 'anonaddy.me', 'anonaddy.com',
  'mailforspam.com', 'mailinator.info', 'harakirimail.com', 'incognitomail.org',
  'mailimate.com', 'mailin8r.com', 'mailismagic.com', 'mailme.lv', 'mailmetrash.com',
  'mintemail.com', 'mohmal.com', 'mohmal.im', 'mailnator.com', 'onewaymail.com',
  'owlpic.com', 'poopmail.info', 'pjjkp.com', 'putthisinyourspamdatabase.com',
  'quickinbox.com', 'sneakemail.com', 'sofort-mail.de', 'spamfree24.org',
  'spamfree24.com', 'spamfree24.de', 'squizzy.de', 'streetwisemail.com',
  'tempemail.net', 'tempinbox.co.uk', 'thankyou2010.com', 'trbvm.com',
  'wh4f.org', 'willselfdestruct.com', 'xoxy.net', 'yourdomain.com', 'zippymail.info',
  'byom.de', 'deadaddress.com', 'despam.it', 'devnullmail.com', 'dodgeit.com',
  'dodgit.com', 'e4ward.com', 'emailgo.de', 'emailias.com', 'emailsensei.com',
  'emailtemporanea.net', 'emailwarden.com', 'ephemail.net', 'explodemail.com',
  'fastacura.com', 'filzmail.com', 'get1mail.com', 'get2mail.fr', 'girlsundertheinfluence.com',
  'gishpuppy.com', 'great-host.in', 'greensloth.com', 'hidemail.de', 'hochsitze.com',
  'hotpop.com', 'hulapla.de', 'ieatspam.eu', 'ieatspam.info', 'ihateyoualot.info',
  'imails.info', 'inboxalias.com', 'jetable.com', 'jetable.net', 'jetable.org',
  'klzlk.com', 'kulturbetrieb.info', 'lifebyfood.com', 'link2mail.net', 'litedrop.com',
  'lortemail.dk', 'lr78.com', 'm4ilweb.info', 'mail-temporaire.fr', 'mail.by',
  'mailbidon.com', 'mailblocks.com', 'mailcat.biz', 'mailfa.tk', 'mailfreeonline.com',
  'mailguard.me', 'mailinatorzz.mooo.com', 'mailmoat.com', 'mailquack.com',
  'mailscrap.com', 'mailshell.com', 'mailsiphon.com', 'mailslapping.com',
  'mailzilla.com', 'mailzilla.org', 'mbx.cc', 'mierdamail.com', 'ms9.mailslite.com',
  'nervmich.net', 'nervtmich.net', 'netmails.net', 'no-spam.ws', 'nobulk.com',
  'noclickemail.com', 'nogmailspam.info', 'nomail2me.com', 'nospam4.us', 'nospamfor.us',
  'nowmymail.com', 'objectmail.com', 'obobbo.com', 'oneoffemail.com', 'onewaymail.com',
  'ordinaryamerican.net', 'otherinbox.com', 'ovpn.to', 'pcusers.otherinbox.com',
  'plexolan.de', 'poofy.org', 'privacy.net', 'privatdemail.net', 'punkass.com',
  'rcpt.at', 'reallymymail.com', 'recode.me', 'recursor.net', 'regbypass.com',
  'safe-mail.net', 'safetymail.info', 'safetypost.de', 'sandelf.de', 'saynotospams.com',
  'selfdestructingmail.com', 'sharklasers.com', 'shieldedmail.com', 'shitmail.me',
  'shortmail.net', 'sibmail.com', 'skeefmail.com', 'slaskpost.se', 'slopsbox.com',
  'smellfear.com', 'snakemail.com', 'sneakemail.com', 'sofimail.com', 'sofort-mail.de',
  'spam4.me', 'spamavert.com', 'spambob.com', 'spambob.net', 'spambob.org',
  'spamcannon.com', 'spamcannon.net', 'spamcon.org', 'spamcorptastic.com',
  'spamday.com', 'spamex.com', 'spamhole.com', 'spamify.com', 'spaminator.de',
  'spammotel.com', 'spamobox.com', 'spamspot.com', 'spamthis.co.uk', 'spamtrail.com',
  'tempemail.co.za', 'tempomail.fr', 'temporaryemail.net', 'temporaryinbox.com',
  'thisisnotmyrealemail.com', 'tilien.com', 'tmailinator.com', 'tradermail.info',
  'trash2009.com', 'trashdevil.com', 'trashemail.de', 'trashymail.com', 'turual.com',
  'twinmail.de', 'tyldd.com', 'uggsrock.com', 'upliftnow.com', 'uplipht.com',
  'venompen.com', 'veryrealemail.com', 'viditag.com', 'viralplays.com', 'vpn.st',
  'vsimcard.com', 'vubby.com', 'wasteland.rfc822.org', 'webm4il.info', 'wetrainbayarea.com',
  'whyspam.me', 'wilemail.com', 'writeme.us', 'wuzup.net', 'wuzupmail.net',
  'yep.it', 'yogamaven.com', 'zoemail.org', 'zomg.info',
]);

/**
 * True when `email`'s domain is a known disposable/throwaway provider. Case- and
 * whitespace-insensitive. A null/empty or address-less string is NOT disposable.
 */
export function isDisposableEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!domain) return false;
  // Boundary-checked suffix match so subdomains of a throwaway provider
  // (e.g. "inbox.mailinator.com") are caught, without matching an unrelated
  // domain that merely ends in the same letters (e.g. "notmailinator.com").
  for (const d of DISPOSABLE_DOMAINS) {
    if (domain === d || domain.endsWith('.' + d)) return true;
  }
  return false;
}
