-- Cold Call disposition'ları activities akışına 'call' tipiyle düşer.
-- Mevcut constraint (bir önceki aktivite revizyonunda) 'call' tipini içermiyordu;
-- yalnız 'call' EKLENİR — mevcut tipler aynen korunur. Kullanıcı formundan
-- (ALLOWED_ACTIVITY_TYPES) submit edilemez; sadece Cold Call modülü yazar.
ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_type_check;
ALTER TABLE activities ADD CONSTRAINT activities_type_check CHECK (
  type = ANY (ARRAY[
    'not'::text,
    'meeting'::text,
    'follow_up'::text,
    'sonlandirma_raporu'::text,
    'status_change'::text,
    'campaign_email'::text,
    'call'::text
  ])
);
