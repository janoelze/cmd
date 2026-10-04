// Built-in themes, registered through the same API user and plugin themes will
// use. Registration order is the order in the Settings popups.

import { registerTheme } from "./registry.ts";
import { dark } from "./dark.ts";
import { light } from "./light.ts";
import { ayuDark, ayuLight, ayuMirage } from "./ayu.ts";
import { catppuccinLatte, catppuccinMocha } from "./catppuccin.ts";
import { dracula } from "./dracula.ts";
import { everforestDark, everforestLight } from "./everforest.ts";
import { githubDark, githubLight } from "./github.ts";
import { gruvboxDark, gruvboxLight } from "./gruvbox.ts";
import { kanagawaDragon, kanagawaLotus, kanagawaWave } from "./kanagawa.ts";
import { nord } from "./nord.ts";
import { oneDark } from "./one-dark.ts";
import { pastelDark } from "./pastel-dark.ts";
import { pastelLight } from "./pastel-light.ts";
import { rosePineDawn, rosePineMain, rosePineMoon } from "./rose-pine.ts";
import { solarizedDark, solarizedLight } from "./solarized.ts";
import { tokyoNight, tokyoNightDay, tokyoNightStorm } from "./tokyo-night.ts";

for (const t of [
  dark, light,
  pastelDark, pastelLight,
  ayuDark, ayuMirage, ayuLight,
  catppuccinMocha, catppuccinLatte,
  dracula,
  everforestDark, everforestLight,
  githubDark, githubLight,
  gruvboxDark, gruvboxLight,
  kanagawaWave, kanagawaDragon, kanagawaLotus,
  nord,
  oneDark,
  rosePineMain, rosePineMoon, rosePineDawn,
  solarizedDark, solarizedLight,
  tokyoNight, tokyoNightStorm, tokyoNightDay,
]) registerTheme(t);
