-- Preserve identities, credentials, assets, placements and memberships.
-- Old shared default names/duplicates: the earliest account keeps its name.
-- other accounts choose a new name at their next visit, without losing work.
-- Canonical collision keys ignore invisible formatting without changing the
-- displayed name or valid emoji sequences. Ranges match avatar-name-key.mjs.
WITH RECURSIVE chars(id,rest,key) AS (
  SELECT id,json_extract(avatar_json,'$.name'),'' FROM school_users
  UNION ALL
  SELECT id,substr(rest,2),key || CASE WHEN
    unicode(substr(rest,1,1)) IN (173,847,1564,12644,65279,65440)
    OR unicode(substr(rest,1,1)) BETWEEN 4447 AND 4448
    OR unicode(substr(rest,1,1)) BETWEEN 6068 AND 6069
    OR unicode(substr(rest,1,1)) BETWEEN 6155 AND 6159
    OR unicode(substr(rest,1,1)) BETWEEN 8203 AND 8207
    OR unicode(substr(rest,1,1)) BETWEEN 8234 AND 8238
    OR unicode(substr(rest,1,1)) BETWEEN 8288 AND 8303
    OR unicode(substr(rest,1,1)) BETWEEN 65024 AND 65039
    OR unicode(substr(rest,1,1)) BETWEEN 65520 AND 65528
    OR unicode(substr(rest,1,1)) BETWEEN 113824 AND 113827
    OR unicode(substr(rest,1,1)) BETWEEN 119155 AND 119162
    OR unicode(substr(rest,1,1)) BETWEEN 917504 AND 921599
    THEN '' ELSE substr(rest,1,1) END FROM chars WHERE length(rest)>0
)
UPDATE school_users SET avatar_json=json_set(avatar_json,'$.nameKey',
  (SELECT lower(trim(key)) FROM chars WHERE chars.id=school_users.id AND rest=''));
UPDATE school_users SET avatar_json=json_set(avatar_json,'$.namePending',json('true'),'$.nameConflict',json('true'))
WHERE id IN (
  SELECT id FROM (
    SELECT id,ROW_NUMBER() OVER (
      PARTITION BY json_extract(avatar_json,'$.nameKey')
      ORDER BY created_at,id
    ) AS ordinal FROM school_users
    WHERE COALESCE(json_extract(avatar_json,'$.namePending'),0)=0
  ) WHERE ordinal>1
);
-- The unique index, not a preflight SELECT, arbitrates concurrent requests.
-- ASCII case and leading/trailing spaces do not create separate names.
CREATE UNIQUE INDEX school_users_unique_avatar_name
ON school_users(COALESCE(json_extract(avatar_json,'$.nameKey'),lower(trim(json_extract(avatar_json,'$.name')))))
WHERE COALESCE(json_extract(avatar_json,'$.namePending'),0)=0;
