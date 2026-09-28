import { MAX_NAME_BYTES } from "../../../src/core/nameCodec";

export const NEAR_LIMIT_BYTES = 40;

export const byteLevel = (n: number): "" | "near" | "over" =>
  n > MAX_NAME_BYTES ? "over" : n >= NEAR_LIMIT_BYTES ? "near" : "";
