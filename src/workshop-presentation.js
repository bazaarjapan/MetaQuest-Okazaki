import { formatLocation } from "./location-hud.js";

export const DEFAULT_STL_COLOR = "#488caa";
export const validSTLColor = value => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
export const stlColor = value => validSTLColor(value) ? value.toLowerCase() : DEFAULT_STL_COLOR;

export function describeWorkLocation(position, viewer, station) {
  if (!Array.isArray(position) || !position.every(Number.isFinite)) return "場所を取得中";
  const location = formatLocation({ x: position[0], z: position[2] }, station);
  const distance = Math.hypot(position[0] - viewer.x, position[2] - viewer.z);
  const label = location === "JR岡崎駅付近" ? location : location ? `JR岡崎駅から ${location}` : `X ${Math.round(position[0])} / Z ${Math.round(position[2])}`;
  return `${label} · 現在地から水平距離 ${Math.round(distance).toLocaleString()} m`;
}
