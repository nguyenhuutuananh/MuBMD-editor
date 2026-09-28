// responses.ts - API response shapes built from a Session. Shared by the HTTP server (desktop) and
// the in-browser backend (web), so both builds return exactly the same data.

import type { ItemsResponse, SaveResponse, StateResponse } from "../shared/api";
import { NoFileError, type SaveResult, type Session } from "./session";

export const stateResponse = (session: Session, version: string): StateResponse => ({ file: session.file, version });

export function itemsResponse(session: Session): ItemsResponse {
  const file = session.file;
  if (!file) throw new NoFileError();
  return {
    file,
    items: session.items(),
    edits: session.edits(),
    records: session.recordList(),
    dirty: session.dirtySlots(),
    status: session.status(),
    draft: session.draftInfo(),
    rebased: session.wasRebased(),
  };
}

export const saveResponse = (session: Session, result: SaveResult): SaveResponse => ({ ...result, status: session.status() });
