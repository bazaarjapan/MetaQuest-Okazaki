/** Local PLATEAU metres: +X is east, +Z is south. No device geolocation. */
export function formatLocation(position, station) {
  if (![position?.x, position?.z, station?.[0], station?.[2]].every(Number.isFinite)) return null;
  const east = position.x - station[0], south = position.z - station[2];
  if (Math.hypot(east, south) < 5) return "JR岡崎駅付近";
  const axis = (value, positive, negative, zero) => {
    const metres = Math.round(Math.abs(value));
    const distance = metres < 1000 ? `${metres} m` : `${(metres / 1000).toFixed(2)} km`;
    return `${metres === 0 ? zero : value > 0 ? positive : negative} ${distance}`;
  };
  return `${axis(east, "東", "西", "東西")} ／ ${axis(south, "南", "北", "南北")}`;
}

/** Bounded updates; share the same location text with the existing VR panel. */
export function createLocationHud(element, detail) {
  let nextUpdate = -Infinity, text = "", visible = false;
  return {
    update({ time, active, xr, getPosition, station }) {
      if (!active) { element.hidden = true; visible = false; text = ""; nextUpdate = -Infinity; return; }
      if (time >= nextUpdate) {
        nextUpdate = time + 200;
        const next = formatLocation(getPosition(), station) ?? "";
        if (next !== text) { text = next; detail.textContent = text; }
      }
      visible = Boolean(text && !xr);
      element.hidden = !visible;
    },
    getState: () => ({ text, visible }),
  };
}
