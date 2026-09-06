-- Migration: add description_en and params_en columns to listings table
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'listings' AND column_name = 'description_en') THEN
    ALTER TABLE listings ADD COLUMN description_en TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'listings' AND column_name = 'params_en') THEN
    ALTER TABLE listings ADD COLUMN params_en JSONB;
  END IF;
END $$;
