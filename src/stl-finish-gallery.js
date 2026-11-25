// Colors and surface choices were selected with Gemini 4 Neon for daylight
// in the Okazaki world. They use the same saved fields as the manual controls.
const designGroups = [
  ["街・建築", [
    { label: "ガラス張りの駅", color: "#c2d6e3", finish: "windows", surface: "walls" },
    { label: "赤レンガ", color: "#d97c62", finish: "brick", surface: "walls" },
    { label: "城下町の瓦", color: "#7d8fa3", finish: "roofTiles", surface: "roof" },
  ]],
  ["公園・アート", [
    { label: "木の遊具", color: "#dfb07a", finish: "wood", surface: "all" },
    { label: "緑のモザイク", color: "#62c788", finish: "mosaic", surface: "all" },
    { label: "桜色のガラス", color: "#f29cb8", finish: "stainedGlass", surface: "all" },
  ]],
  ["未来の街", [
    { label: "水色の回路", color: "#5ad2f0", finish: "circuit", surface: "all" },
    { label: "ハニカム屋根", color: "#f2c852", finish: "honeycomb", surface: "roof" },
    { label: "オーロラの塔", color: "#b89cf5", finish: "aurora", surface: "all" },
  ]],
];

function finishSwatch(option) {
  const swatch = document.createElement("span");
  swatch.className = "finish-swatch";
  swatch.setAttribute("aria-hidden", "true");
  swatch.style.backgroundPosition = `${(option.index % 4) / 3 * 100}% ${Math.floor(option.index / 4) / 3 * 100}%`;
  return swatch;
}

export function createSTLDesignPicker(container, finishSelect, surfaceSelect, choose) {
  const tabs = container.querySelector(".finish-groups");
  const samples = container.querySelector(".stl-design-samples");
  const labels = new Map(Array.from(surfaceSelect.options, option => [option.value, option.textContent]));
  let active = 0, editable = false, appearance, swatches = [];
  const groups = designGroups.map(([label], index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => show(index));
    tabs.append(button);
    return button;
  });

  function show(index) {
    active = index;
    groups.forEach((button, i) => button.setAttribute("aria-pressed", String(i === active)));
    samples.replaceChildren();
    swatches = designGroups[active][1].map(design => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.design = design.finish;
      const option = Array.from(finishSelect.options).find(value => value.value === design.finish);
      const swatch = finishSwatch(option);
      swatch.style.setProperty("--design-color", design.color);
      const title = document.createElement("span");
      title.textContent = design.label;
      const surface = document.createElement("small");
      surface.textContent = labels.get(design.surface);
      button.append(swatch, title, surface);
      button.addEventListener("click", () => { if (editable) choose(design); });
      samples.append(button);
      return {button, design};
    });
    reflectSelection();
  }

  function reflectSelection() {
    for (const {button, design} of swatches) {
      button.setAttribute("aria-pressed", String(design.color === appearance?.color &&
        design.finish === appearance?.finish && design.surface === appearance?.surface));
    }
  }

  show(active);
  return { refresh(canEdit, current) {
    editable = canEdit;
    appearance = current;
    container.hidden = !editable;
    if (editable) reflectSelection();
  }};
}

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
      button.append(finishSwatch(option), option.textContent);
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
