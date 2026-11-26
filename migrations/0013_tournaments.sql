-- Variant tournaments: several variants of one idea, built in different directions and judged head to head.
-- tournament = group id shared by the variants; variant = this variant's direction.
ALTER TABLE arms ADD COLUMN tournament TEXT;
ALTER TABLE arms ADD COLUMN variant TEXT;
CREATE INDEX IF NOT EXISTS arms_tournament ON arms (species, tournament);
