// Build the optional visual picker from the same native options as the dropdown.
export function createFinishGallery(panel, select) {
  if (!panel) return;
  const groups = [...select.querySelectorAll("optgroup")];
  const nav = panel.querySelector(".finish-groups");
  const samples = panel.querySelector(".finish-samples");
  let category = -1, lastSelection;
  const buttons = [];
  function show(groupIndex) {
    category = groupIndex;
    groups.forEach((_, i) => buttons[i].setAttribute("aria-pressed", String(i === category)));
    samples.replaceChildren();
    for (const option of groups[category].children) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.finish = option.value;
      const swatch = document.createElement("span");
      swatch.className = "finish-swatch";
      swatch.setAttribute("aria-hidden", "true");
      swatch.style.backgroundPosition = `${(option.index % 4) / 3 * 100}% ${Math.floor(option.index / 4) / 3 * 100}%`;
      button.append(swatch, option.textContent);
      button.addEventListener("click", () => {
        if (select.disabled) return;
        select.value = option.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      samples.append(button);
    }
    updateSamples();
  }
  function updateSamples() {
    for (const button of samples.children) {
      button.disabled = select.disabled;
      button.setAttribute("aria-pressed", String(button.dataset.finish === select.value));
    }
  }
  function refresh() {
    if (!panel.open) return;
    if (!buttons.length) {
      groups.forEach((group, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = group.label;
        button.addEventListener("click", () => show(index));
        nav.append(button);
        buttons.push(button);
      });
    }
    if (lastSelection !== select.value || category < 0) {
      lastSelection = select.value;
      const index = groups.indexOf(select.selectedOptions[0]?.parentElement);
      if (category !== Math.max(0, index)) { show(Math.max(0, index)); return; }
    }
    updateSamples();
  }
  panel.addEventListener("toggle", refresh);
  select.addEventListener("change", refresh);
  return { refresh };
}
