import { randomBytes } from 'node:crypto';
import { newStudentPin, verifyStudentPassword } from '../../worker/student-pin.mjs';

const validId = id => typeof id === 'string' && /^s-[a-z0-9_-]{10}$/.test(id);

export async function makeStudentRotation(rows, pepper, { rotateIds = false } = {}) {
  const users = new Set(), slots = new Set(), passwords = new Set();
  const loginIds = new Set(rows.map(row => row.login_id));
  const plan = [];
  for (const row of rows) {
    if (row.role !== 'student' || !row.user_id || users.has(row.user_id) ||
        !Number.isInteger(row.slot) || row.slot < 1 || row.slot > 30 || slots.has(row.slot) ||
        !validId(row.login_id) || !row.password_hash || !row.salt) {
      throw Error('Invalid student rotation target');
    }
    users.add(row.user_id);
    slots.add(row.slot);
    let newLoginId = row.login_id;
    if (rotateIds) {
      do { newLoginId = 's-' + randomBytes(5).toString('hex'); } while (loginIds.has(newLoginId));
      loginIds.add(newLoginId);
    }
    let pin;
    do { pin = await newStudentPin(pepper, row); } while (passwords.has(pin.password));
    passwords.add(pin.password);
    plan.push({
      user_id: row.user_id, slot: row.slot, name: row.name, login_id: row.login_id,
      oldSalt: row.salt, password_hash: row.password_hash,
      newLoginId, password: pin.password, salt: pin.salt, newHash: pin.hash
    });
  }
  return plan;
}

export async function verifyRotationPlan(plan, pepper, rotateIds) {
  if (!Array.isArray(plan) || plan.length < 1 || plan.length > 30) throw Error('Invalid saved plan');
  for (const entry of plan) {
    if (!validId(entry.newLoginId) || (rotateIds ? entry.newLoginId === entry.login_id : entry.newLoginId !== entry.login_id) ||
        !/^[0-9]{4}$/.test(entry.password) || !entry.oldSalt ||
        !await verifyStudentPassword({ password_hash: entry.newHash, salt: entry.salt }, entry.password, pepper)) {
      throw Error('Private plan is incompatible with the requested operation or Worker secret');
    }
  }
}

const quote = v => "'" + String(v).replaceAll("'", "''") + "'";

export function rotationSQL(plan, operation) {
  if (!/^[a-f0-9]{32}$/.test(operation) || !plan.length || plan.length > 30) throw Error('Invalid operation');
  const ids = plan.map(p => quote(p.user_id)).join(',');
  const matching = plan.map(p => `(c.user_id=${quote(p.user_id)} AND c.slot=${quote(p.slot)} AND c.login_id=${quote(p.login_id)} AND c.salt=${quote(p.oldSalt)} AND c.password_hash=${quote(p.password_hash)})`).join(' OR ');
  const values = field => 'CASE user_id ' + plan.map(p => `WHEN ${quote(p.user_id)} THEN ${quote(p[field])}`).join(' ') + ' END';
  const trigger = 'student_rotation_' + operation;
  const loginAssignment = plan.some(p => p.login_id !== p.newLoginId) ? 'login_id=' + values('newLoginId') + ',' : '';
  // D1 file import and the single guarded UPDATE keep the hash change and
  // revocation together. A new session after an already-applied plan survives.
  return `CREATE TRIGGER IF NOT EXISTS ${trigger} AFTER UPDATE OF password_hash ON school_student_credentials
WHEN NEW.user_id IN (${ids}) BEGIN
  DELETE FROM school_sessions WHERE user_id=NEW.user_id;
END;
UPDATE school_student_credentials SET ${loginAssignment}salt=${values('salt')},password_hash=${values('newHash')}
WHERE user_id IN (${ids}) AND (SELECT COUNT(*) FROM school_student_credentials)=${plan.length}
AND (SELECT COUNT(*) FROM school_student_credentials c JOIN school_users u ON u.id=c.user_id WHERE u.role='student' AND (${matching}))=${plan.length};
DROP TRIGGER ${trigger};`;
}

function distributionRows(plan) {
  const rotated = plan.some(p => p.newLoginId !== p.login_id);
  return [[ '番号', '表示名', rotated ? '新しい生徒ID' : '生徒ID', '新しいパスワード（数字4桁）' ],
    ...plan.map(p => [p.slot, String(p.name ?? '').replace(/[\x00-\x1f\x7f]/g, ' '), p.newLoginId, p.password])];
}

export function rotationCSV(plan) {
  const cell = v => '"' + String(v).replace(/^\s*[=+@-]/u, "'$&").replaceAll('"', '""') + '"';
  return '\ufeff' + distributionRows(plan).map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

export function rotationText(plan) {
  return '\ufeff' + distributionRows(plan).map(row => row.join('\t')).join('\r\n') + '\r\n';
}
