-- Twilio subaccount'ları için TwiML app referansı (Voice SDK outgoing application).
ALTER TABLE coldcall_settings ADD COLUMN IF NOT EXISTS twiml_app_sid TEXT;
