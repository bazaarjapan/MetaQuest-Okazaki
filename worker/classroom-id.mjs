// A dedicated shared classroom. Never grants access to unrelated legacy worlds.
export const CLASSROOM_ID = "00000000-0000-4000-8000-000000000024";
export const managesWorld = (world, user) => user.role === "teacher" &&
  (world.id === CLASSROOM_ID || world.teacher_id === user.id);
