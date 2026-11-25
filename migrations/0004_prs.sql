-- Mutants as pull requests.
ALTER TABLE arms ADD COLUMN prs TEXT;          -- JSON [{number, url, branch, base, head, title}] bottom to top
ALTER TABLE arms ADD COLUMN work_item TEXT;    -- JSON {title, hypothesis, work_item, acceptance_criteria, implements_issue, size}
ALTER TABLE arms ADD COLUMN finalist_of TEXT;  -- arm id this is the rebased-onto-main version of
