-- Media now lives on the engine repo's public `media` branch; the database keeps only the URL and what it shows.
-- role: key (a key page) | before | after (demo shots) | flow-before | flow-after (demo video) | mockup | today
ALTER TABLE media ADD COLUMN url TEXT;
ALTER TABLE media ADD COLUMN role TEXT;
ALTER TABLE media ADD COLUMN name TEXT;
ALTER TABLE media ADD COLUMN caption TEXT;
ALTER TABLE media ADD COLUMN note TEXT;
-- The demo spec of a mutant (what to show and which flow to record), and the errors from running it.
ALTER TABLE arms ADD COLUMN demo TEXT;
-- Re-photograph living arms with the new validated capture (old shots could show error pages), freeing their
-- old database-stored images.
DELETE FROM media_chunk WHERE media_id IN (SELECT m.id FROM media m JOIN arms a ON a.species = m.species AND a.arm_id = m.arm_id WHERE a.status IN ('live','champion','control','nursery','guard'));
DELETE FROM media WHERE id IN (SELECT m.id FROM media m JOIN arms a ON a.species = m.species AND a.arm_id = m.arm_id WHERE a.status IN ('live','champion','control','nursery','guard'));
DELETE FROM media WHERE kind = 'video' AND role IS NULL;
UPDATE arms SET shot_at = NULL WHERE status IN ('live','champion','control','nursery','guard');
