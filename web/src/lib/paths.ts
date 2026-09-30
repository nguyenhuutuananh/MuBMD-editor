// paths.ts - How folder paths are shown. Web paths contain the id of the granted folder
// ("/Localization@3"); users see it without the id ("/Localization").

import { isWeb } from "./api";

export const displayPath = (p: string) => (isWeb ? p.replace(/@\d+(?=\/|$)/g, "") : p);
