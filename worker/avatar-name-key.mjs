// Keep this range list identical to migration 0003. Strip default-ignorable
// code points from the collision key only, preserving emoji in display names.
export function avatarNameKey(name) {
  return name.replace(/[\u00ad\u034f\u061c\u115f-\u1160\u17b4-\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufff8\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0000}-\u{e0fff}]/gu, "")
    .replace(/^ +| +$/g, "").replace(/[A-Z]/g, c => c.toLowerCase());
}
