-- Pedigree: where a mutant's idea came from (discussion | owner | user | behavior | growth | sim | ideation | exploration).
-- Trusted sources need less evidence to be merged; see NURSERY_DEFAULTS.pedigree in evolve/lib/select.mjs.
ALTER TABLE arms ADD COLUMN pedigree TEXT;
