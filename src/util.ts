export const errorDetail = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
