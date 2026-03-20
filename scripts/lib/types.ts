export type Result =
  | { type: "ok"; data: string }
  | { type: "env-error"; missing: string[] }
  | { type: "db-error"; error: string }
  | { type: "inference-unreachable"; url: string }
  | { type: "no-command" };

export const ok = (data: string): Result => ({ type: "ok", data });
export const envError = (missing: string[]): Result => ({ type: "env-error", missing });
export const dbError = (error: string): Result => ({ type: "db-error", error });
export const inferenceUnreachable = (url: string): Result => ({ type: "inference-unreachable", url });
export const noCommand: Result = { type: "no-command" };

export interface SearchOpts {
  project?: string | null;
  days?: number | null;
  limit?: number;
  session?: string | null;
}