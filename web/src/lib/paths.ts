// paths.ts - How file paths are shown. Web paths contain the id of the granted folder/file
// ("/MU@3/Data/Items"); users see it without the id ("/MU/Data/Items").

import { isWeb } from "./api";

export const displayPath = (p: string) => (isWeb ? p.replace(/@\d+(?=\/|$)/g, "") : p);
