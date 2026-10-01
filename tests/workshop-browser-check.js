(async () => {
  const results = [];
  const check = (ok, name) => { results.push({ name, ok: Boolean(ok) }); if (!ok) throw new Error(name); };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const state = () => window.__okazaki.getState();
  const until = async (predicate) => {
    const end = performance.now() + 12000;
    while (!predicate() && performance.now() < end) await wait(100);
    check(predicate(), "async-operation-completed");
  };
  check(state().ready, "city-loaded");
  document.querySelector("#open-workshop").click();
  check(document.querySelector("#workshop-dialog").open, "workshop-accessible");
  const vertices = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]];
  const faces = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[3,7,6],[3,6,2],[0,4,7],[0,7,3],[1,2,6],[1,6,5]];
  const stl = `solid cube\n${faces.map((face) => `facet normal 0 0 0\nouter loop\n${face.map((i) => `vertex ${vertices[i].join(" ")}`).join("\n")}\nendloop\nendfacet`).join("\n")}\nendsolid cube`;
  const input = document.querySelector("#stl-files");
  const transfer = new DataTransfer();
  transfer.items.add(new File([stl], "授業の建物.stl", {type:"model/stl"}));
  transfer.items.add(new File([stl], "別の作品.stl", {type:"model/stl"}));
  input.files = transfer.files; input.dispatchEvent(new Event("change", {bubbles:true}));
  await until(() => state().workshop.count === 2 && !state().workshop.busy);
  check(state().workshop.triangles === 24, "multiple-STL-import");
  check(state().workshop.objects.every((o) => o.upAxis === "z" && Math.abs(o.scale[0] - 10) < 1e-6), "CAD-Z-up-and-fit10-explicit");
  // Search through the actual form and the app's real placement validation.
  // No Vite-only /src imports: the same gate runs on the deployed bundle.
  const set = (id, value) => { const field = document.querySelector(`#object-${id}`); field.value = value; field.dispatchEvent(new Event("change", {bubbles:true})); };
  let empty = null;
  for (let x = -250; x < 300 && !empty; x += 15) for (let z = -300; z < 320 && !empty; z += 15) {
    set("x", x); set("z", z);
    const result = state().workshop.objects.find((o) => o.id === state().workshop.selected);
    if (result.valid) empty = [...result.position];
  }
  check(empty, "real-terrain-empty-space-found");
  set("x", empty[0]); set("z", empty[2]);
  check(state().workshop.objects.find((o) => o.id === state().workshop.selected).valid, "valid-space-enables-commit");
  check(!document.querySelector("#object-apply").disabled, "commit-enabled-only-for-valid-placement");
  document.querySelector("#object-apply").click();
  check(state().workshop.committed === 1, "actual-placement-committed");
  set("rx", 25); set("ry", 40); set("rz", 15); set("scale", 5);
  const rotated = state().workshop.objects.find((o) => o.id === state().workshop.selected);
  check(rotated.rotation.every((r) => r !== 0) && rotated.scale.every((v) => v === 5), "all-three-rotation-axes-and-scale");
  check(Number.isFinite(rotated.position[1]), "rotation-reanchors-to-real-ground");
  const priorPosition = [...rotated.position];
  set("scale", 1e308);
  const unsafe = state().workshop.objects.find((o) => o.id === state().workshop.selected);
  check(!unsafe.valid && unsafe.position.every((v, i) => v === priorPosition[i]) &&
    unsafe.scale.every((v) => v === 5), "unsafe-transform-rejected-before-GPU-matrix");
  set("x", 999999);
  check(!state().workshop.objects.find((o) => o.id === state().workshop.selected).valid &&
    document.querySelector("#object-apply").disabled, "outside-core-fails-closed");
  const malformed = new DataTransfer(); malformed.items.add(new File(["not an STL"], "壊れた.stl"));
  input.files = malformed.files; input.dispatchEvent(new Event("change", {bubbles:true}));
  await until(() => !state().workshop.busy);
  check(state().workshop.count === 2 && state().workshop.message.length > 0, "malformed-file-no-extra-object");
  document.querySelector("#object-remove").click();
  check(state().workshop.count === 1, "delete-only-selected-creation");
  set("x", empty[0]); set("z", empty[2]); set("scale", 5);
  document.querySelector("#object-apply").click();
  check(state().workshop.committed === 1, "remaining-creation-retained-for-VR");
  check(state().workshop.storage === "current-page-only", "no-false-cloud-storage-claim");
  document.querySelector("#workshop-close").click();
  check(!document.querySelector("#workshop-dialog").open, "close-workshop");
  return JSON.stringify({passed:true,environment:"PC browser; not physical Quest",results});
})();
