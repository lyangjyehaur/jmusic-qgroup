export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
export const errorStatus = (error: unknown): number | undefined =>
  typeof error === "object" &&
  error !== null &&
  "status" in error &&
  typeof error.status === "number"
    ? error.status
    : undefined;
