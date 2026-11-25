// Box dimensions are in meters relative to the animated head or body pivot.
// Every detail can be drawn in the avatar's existing cube batch.
export function avatarDetailBlocks(design, { hair, accent }) {
  const details = [];
  const add = (head, color, size, position, close = false, angle = 0) =>
    details.push({ head, color, size, position, close, angle });
  const hairBox = (size, position, angle) => add(true, hair, size, position, false, angle);
  const eye = (color, size, x, y, z = -.222, angle = 0) =>
    add(true, color, [...size, .012], [x, y, z], true, angle);
  const cloth = (color, size, x, y, z = -.154, angle = 0) =>
    add(false, color, [...size, .016], [x, y, z], false, angle);
  const ink = 0x302835, mineral = 0x203243, light = 0xf4e4c5, brass = 0xe8b755;

  if (design.hairStyle !== "classic") {
    hairBox([.447, .105, .445], [0, .176, .005]);
  }
  switch (design.hairStyle) {
    case "crop":
      hairBox([.32, .058, .36], [0, .237, .024]);
      hairBox([.421, .085, .053], [0, .096, .198]);
      break;
    case "swept":
      hairBox([.36, .102, .408], [-.044, .222, .01], .08);
      hairBox([.235, .088, .079], [-.096, .133, -.207], .22);
      hairBox([.069, .139, .35], [.183, .096, .031]);
      break;
    case "bob":
    case "pony":
      hairBox([.435, design.hairStyle === "bob" ? .339 : .19, .074], [0, .019, .193]);
      for (const sign of [-1, 1]) hairBox([.09, design.hairStyle === "bob" ? .31 : .16, .381],
        [sign * .185, design.hairStyle === "bob" ? .028 : .076, .008]);
      if (design.hairStyle === "pony") {
        add(true, accent, [.13, .14, .12], [0, .077, .247]);
        hairBox([.18, .28, .085], [0, -.085, .30], -.14);
      }
      hairBox([.34, .064, .055], [0, .15, -.207]);
      break;
    case "buns":
      for (const sign of [-1, 1]) {
        hairBox([.17, .16, .18], [.201 * sign, .204, .065], sign * .18);
        hairBox([.101, .056, .14], [.21 * sign, .138, .06]);
      }
      hairBox([.31, .075, .058], [-.034, .142, -.208], .12);
      break;
    case "spikes":
      for (let i = 0; i < 4; i++) hairBox([.095, .205 - i * .019, .222],
        [-.14 + i * .081, .232, .017], -.36);
      break;
    case "curls":
      for (let i = 0; i < 5; i++) hairBox([.109, .112, .10], [-.171 + i * .085, .202 + (i % 2) * .026, -.199], i % 2 ? .2 : -.15);
      for (const sign of [-1, 1]) hairBox([.098, .11, .36], [sign * .196, .129, .013]);
      break;
  }

  if (design.face !== "classic") {
    const height = design.face === "bright" ? .079 : design.face === "gentle" ? .034 : .061;
    const smile = ["smile", "bright", "freckles"].includes(design.face);
    for (const sign of [-1, 1]) {
      eye(ink, [.049, height], sign * .091, .018);
      if (design.face === "bright") eye(0xfff4dd, [.019, .017], sign * .091 - .006, .036, -.229);
      if (design.face === "confident") eye(ink, [.068, .016], sign * .089, .079, -.222, sign * .23);
      if (design.face === "freckles") {
        eye(0xaa6c52, [.016, .014], sign * .125, -.045);
        eye(0xaa6c52, [.013, .013], sign * .157, -.056);
      }
      if (smile) eye(ink, [.022, .016], sign * .035, -.083, -.222, sign * .45);
    }
    eye(ink, [smile ? .064 : .047, .014], 0, -.094);
  }

  switch (design.outfit) {
    case "hoodie":
      cloth(mineral, [.25, .12], 0, .326);
      for (const sign of [-1, 1]) cloth(light, [.019, .149], sign * .075, .211);
      cloth(0x424d68, [.31, .12], 0, -.076);
      cloth(0x424d68, [.36, .169], 0, .271, .155);
      break;
    case "jacket":
      cloth(mineral, [.36, .097], 0, .332);
      cloth(light, [.023, .505], 0, .069);
      for (const sign of [-1, 1]) cloth(0x354741, [.135, .059], sign * .139, -.062);
      cloth(brass, [.086, .045], .148, .172);
      break;
    case "overalls":
      cloth(0x293f5b, [.4, .292], 0, .004);
      for (const sign of [-1, 1]) {
        cloth(0x293f5b, [.083, .298], sign * .146, .224);
        cloth(brass, [.041, .04], sign * .146, .135, -.165);
      }
      cloth(0x476482, [.153, .105], 0, .016, -.166);
      break;
    case "apron":
      cloth(0xe6cea7, [.367, .405], 0, .074);
      for (const sign of [-1, 1]) cloth(0xe6cea7, [.041, .232], sign * .12, .269);
      cloth(0xae7151, [.188, .091], .053, -.046, -.165);
      break;
    case "uniform":
      for (const sign of [-1, 1]) cloth(light, [.107, .105], sign * .055, .3, -.154, sign * .31);
      cloth(0x963d46, [.041, .246], 0, .239, -.166);
      for (let i = 0; i < 3; i++) cloth(brass, [.034, .033], 0, .064 - i * .085);
      cloth(brass, [.093, .041], .155, .207);
      break;
    case "sport":
      for (const sign of [-1, 1]) {
        cloth(light, [.041, .536], sign * .225, .085);
        cloth(light, [.041, .536], sign * .225, .085, .154);
      }
      cloth(mineral, [.247, .085], 0, .31);
      break;
    case "pilot":
      cloth(0xd3ddd9, [.53, .106], 0, .284);
      cloth(mineral, [.04, .42], 0, .038);
      cloth(brass, [.117, .063], .134, .162);
      cloth(mineral, [.44, .086], 0, -.147);
      break;
  }

  const gear = (color, size, position) => add(true, color, size, position);
  switch (design.accessory) {
    case "glasses":
      for (const sign of [-1, 1]) {
        for (const y of [-.031, .071]) eye(mineral, [.134, .018], sign * .103, y, -.24);
        for (const x of [.044, .162]) eye(mineral, [.019, .102], sign * x, .02, -.24);
      }
      eye(mineral, [.077, .017], 0, .027, -.24);
      break;
    case "cap":
      gear(mineral, [.468, .133, .467], [0, .237, .019]);
      gear(mineral, [.41, .044, .17], [0, .165, -.262]);
      gear(brass, [.083, .039, .014], [0, .221, -.22]);
      break;
    case "beanie":
      gear(accent, [.473, .136, .47], [0, .215, 0]);
      gear(accent, [.347, .057, .374], [0, .298, .029]);
      gear(mineral, [.474, .043, .472], [0, .156, 0]);
      break;
    case "helmet":
      gear(0xe59536, [.49, .116, .466], [0, .241, .013]);
      gear(brass, [.508, .039, .551], [0, .182, -.027]);
      gear(0xf1aa45, [.088, .055, .424], [0, .316, .011]);
      break;
    case "headphones":
      gear(mineral, [.502, .028, .118], [0, .311, .033]);
      for (const sign of [-1, 1]) {
        gear(mineral, [.029, .194, .113], [sign * .236, .222, .039]);
        gear(mineral, [.087, .177, .158], [sign * .241, .062, .02]);
        gear(light, [.018, .113, .106], [sign * .286, .062, .02]);
      }
      break;
  }
  return details;
}
