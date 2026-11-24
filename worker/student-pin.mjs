import { base64url, decode64url, fail, randomToken, sha256 } from "./school-common.mjs";

const prefix = "pin-hmac-sha256-v1$";
const text = new TextEncoder();

async function verifierKey(pepper) {
  // The secret is held outside D1. A database copy alone must not allow
  // someone to test the 10,000 possible PINs against a student's verifier.
  if (typeof pepper !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(pepper)) fail(503, "school_not_configured");
  return crypto.subtle.importKey("raw", decode64url(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function pinMessage(salt, password) {
  return text.encode(`school-student-pin-v1:${salt}:${password}`);
}

export async function newStudentPin(pepper, previous = null) {
  const key = await verifierKey(pepper);
  let password;
  do {
    // Reject the short final interval so every digit sequence is equally likely.
    let sample;
    do { [sample] = crypto.getRandomValues(new Uint16Array(1)); } while (sample >= 60_000);
    password = String(sample % 10_000).padStart(4, "0");
  } while (previous && await verifyStudentPassword(previous, password, pepper));
  const salt = randomToken();
  const mac = await crypto.subtle.sign("HMAC", key, pinMessage(salt, password));
  return { password, salt, hash: prefix + base64url(new Uint8Array(mac)) };
}

export async function verifyStudentPassword(credential, password, pepper) {
  if (typeof password !== "string") return false;
  const stored = credential?.password_hash;
  if (stored && /^[0-9a-f]{64}$/.test(stored)) {
    // Earlier credentials were 24 random base64url characters. Keep them
    // usable until the operator or the teacher rotates that exact record.
    return /^[A-Za-z0-9_-]{24}$/.test(password) && await sha256(`${credential.salt}:${password}`) === stored;
  }
  if (!/^[0-9]{4}$/.test(password)) return false;
  if (stored && !stored.startsWith(prefix)) return false;
  // Unknown IDs take the same MAC path and receive the same login error.
  const tag = stored ? stored.slice(prefix.length) : "A".repeat(43);
  if (!/^[A-Za-z0-9_-]{43}$/.test(tag)) return false;
  const matches = await crypto.subtle.verify("HMAC", await verifierKey(pepper), decode64url(tag),
    pinMessage(credential?.salt ?? "unknown-student", password));
  return Boolean(credential && matches);
}
