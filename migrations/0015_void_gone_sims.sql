-- Sessions that landed on an arm retired mid-run (router answered 410 "arm is gone") measured nothing about the
-- arm but were counted as failures. Remove them (the sims runner now discards such sessions).
DELETE FROM sim_runs WHERE report LIKE '%arm is gone%' OR report LIKE '%HTTP 410%' OR report LIKE '%410 error%' OR report LIKE '%410 page%' OR report LIKE '%page with a 410%';
DELETE FROM sim_pairs WHERE why LIKE '%arm is gone%' OR why LIKE '%HTTP 410%' OR why LIKE '%410 error%' OR why LIKE '%410 page%' OR report LIKE '%arm is gone%' OR report LIKE '%HTTP 410%';
