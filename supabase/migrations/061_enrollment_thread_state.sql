-- ============================================================================
-- 061: Enrollment thread durumu (deliverability — takip mailleri aynı konuşmada)
-- Bir enrollment'ın takip adımları (step > 1) ilk mailin thread'inde gitsin diye
-- her enrollment'ta thread durumu tutulur. İlk mail thread kökü olur; sonrakiler
-- In-Reply-To (son mesaj-id) + References (önceki id zinciri) + Gmail native
-- threadId ile aynı konuşmaya bağlanır.
--
-- Geriye-uyumluluk: bu değişiklikten ÖNCE oluşan enrollment'larda kolonlar NULL
-- kalır → ilk gönderim thread kökü sayılır ve thread'siz gider (mevcut davranış).
-- ============================================================================

ALTER TABLE campaign_enrollments
    -- Thread kökünün (ilk mail) RFC Message-ID'si. Yalnız hata ayıklama/izlenebilirlik
    -- için; header üretimi References zincirinden yapılır.
    ADD COLUMN IF NOT EXISTS thread_first_message_id   TEXT,
    -- En son gönderilen mailin Message-ID'si → bir sonraki takip mailinin In-Reply-To'su.
    ADD COLUMN IF NOT EXISTS thread_last_message_id    TEXT,
    -- Şimdiye kadarki tüm Message-ID'lerin boşlukla ayrılmış zinciri → References header'ı.
    ADD COLUMN IF NOT EXISTS thread_references         TEXT,
    -- Gmail native threadId (ilk gönderim yanıtından). Alıcı-tarafı thread'i header'larla
    -- olur; bu yalnız gönderen Gmail kutusunda konuşmayı native gruplar. Gmail dışı NULL.
    ADD COLUMN IF NOT EXISTS thread_provider_thread_id TEXT,
    -- Thread kökünün konusu (Re: öneki olmadan) → takip mailleri "Re: <konu>" taşır.
    ADD COLUMN IF NOT EXISTS thread_subject            TEXT,
    -- Thread'i kuran gönderen kutusu. threadId kutuya özgü olduğundan, rotasyon bir
    -- sonraki adımda kutu değiştirirse (silinmiş/pasif kutu) native threadId geçilmez;
    -- header'lar yine bağlar. Kutu eşleşmesini bununla kontrol ederiz.
    ADD COLUMN IF NOT EXISTS thread_account_email      TEXT;
