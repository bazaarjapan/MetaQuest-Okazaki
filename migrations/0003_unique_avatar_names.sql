-- Preserve identities, credentials, assets, placements and memberships.
-- Old shared default names/duplicates: the earliest account keeps its name.
-- other accounts choose a new name at their next visit, without losing work.
UPDATE school_users SET avatar_json=json_set(avatar_json,'$.namePending',json('true'),'$.nameConflict',json('true'))
WHERE id IN (
  SELECT id FROM (
    SELECT id,ROW_NUMBER() OVER (
      PARTITION BY lower(trim(json_extract(avatar_json,'$.name')))
      ORDER BY created_at,id
    ) AS ordinal FROM school_users
    WHERE COALESCE(json_extract(avatar_json,'$.namePending'),0)=0
  ) WHERE ordinal>1
);
-- The unique index, not a preflight SELECT, arbitrates concurrent requests.
-- ASCII case and leading/trailing spaces do not create separate names.
CREATE UNIQUE INDEX school_users_unique_avatar_name
ON school_users(lower(trim(json_extract(avatar_json,'$.name'))))
WHERE COALESCE(json_extract(avatar_json,'$.namePending'),0)=0;
