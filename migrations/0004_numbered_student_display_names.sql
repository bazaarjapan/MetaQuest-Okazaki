-- Reset the display names of issued student seats at rollout. Temporarily
-- release their keys so that previously exchanged names can be reassigned.
-- The migration runs atomically. Teachers and legacy accounts keep their names.
UPDATE school_users SET avatar_json=json_set(avatar_json,'$.namePending',json('true'))
WHERE id IN (SELECT user_id FROM school_student_credentials);

WITH numbered AS (
  SELECT user_id,printf('生徒%02d',slot) AS display_name FROM school_student_credentials
), assigned AS (
  SELECT numbered.user_id,numbered.display_name,EXISTS (
    SELECT 1 FROM school_users AS other WHERE COALESCE(json_extract(other.avatar_json,'$.namePending'),0)=0
      AND COALESCE(json_extract(other.avatar_json,'$.nameKey'),lower(trim(json_extract(other.avatar_json,'$.name'))))=numbered.display_name
  ) AS conflict FROM numbered
)
UPDATE school_users AS student SET avatar_json=(
  SELECT CASE WHEN conflict THEN json_set(student.avatar_json,'$.name',display_name,'$.nameKey',display_name,
    '$.namePending',json('true'),'$.nameConflict',json('true'))
  ELSE json_set(json_remove(student.avatar_json,'$.namePending','$.nameConflict'),
    '$.name',display_name,'$.nameKey',display_name) END
  FROM assigned WHERE assigned.user_id=student.id
)
WHERE id IN (SELECT user_id FROM numbered);
