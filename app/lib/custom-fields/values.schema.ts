import { z } from "zod";

export const customValuesInput = z.record(z.string(), z.unknown()).optional();
export type CustomValuesInput = Record<string, unknown>;
