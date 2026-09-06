-- Migration: add description column to listings table (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'listings' AND column_name = 'description') THEN
    ALTER TABLE listings ADD COLUMN description TEXT NOT NULL DEFAULT '';
  END IF;
END $$;
