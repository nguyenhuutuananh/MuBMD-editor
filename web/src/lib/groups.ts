// groups.ts - How a group is named in the UI: a resx group by its name (Game, Dialog...), an item
// group by its number and a translated name ("7. Helms").

import type { GroupInfo } from "../../../src/shared/api";
import { tr } from "@/i18n";

export const groupLabel = (g: GroupInfo | undefined): string =>
  !g ? "" : g.itemType === null ? g.name : `${g.itemType}. ${tr(`itemTypes.${g.itemType}`)}`;
