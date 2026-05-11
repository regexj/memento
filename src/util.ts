export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const getString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export const getNumber = (value: unknown): number | undefined =>
  typeof value === "number" ? value : undefined;

export const formatDate = (date: Date): string =>
  date.toISOString().split("T")[0]!;

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
