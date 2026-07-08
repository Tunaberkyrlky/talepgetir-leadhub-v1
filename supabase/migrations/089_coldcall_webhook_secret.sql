-- Cold Call webhook doğrulama gizli anahtarı.
-- Neden: Twilio webhook imzası SUBACCOUNT AUTH TOKEN ile üretilir. Master kimlik
-- bir API Key (SK...) ise, Twilio subaccount auth token'ını API'den OKUTMUYOR —
-- dolayısıyla imza doğrulaması imkânsız. Twilio'nun önerdiği alternatif: webhook
-- URL'sine tahmin edilemez bir gizli anahtar koyup onu doğrulamak (HTTPS üzerinde).
-- Master AUTH TOKEN modelinde imza doğrulaması yine birincil; secret ek katman.
ALTER TABLE coldcall_settings ADD COLUMN IF NOT EXISTS webhook_secret TEXT;
