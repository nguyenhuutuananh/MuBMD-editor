// paths.ts - How file paths are shown. Web paths contain the id of the granted folder/file
// ("/Local@3/Item.bmd"); users see it without the id ("/Local/Item.bmd").

import { isWeb } from "./api";

export const displayPath = (p: string) => (isWeb ? p.replace(/@\d+(?=\/|$)/g, "") : p);
