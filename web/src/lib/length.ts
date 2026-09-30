import { MAX_NAME_CHARS } from "../../../src/core/nameCodec";
import { NEAR_LIMIT_CHARS } from "./search";

export const lengthLevel = (n: number): "" | "near" | "over" => (n > MAX_NAME_CHARS ? "over" : n >= NEAR_LIMIT_CHARS ? "near" : "");
