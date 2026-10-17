// Keep this range list identical to migration 0003. Strip default-ignorable
// code points from the collision key only, preserving emoji in display names.
export function avatarNameKey(name) {
  return name.replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "")
    .replace(/^ +| +$/g, "").replace(/[A-Z]/g, c => c.toLowerCase());
}
