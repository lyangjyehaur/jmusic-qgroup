import type { z } from 'zod';
import type { ApiFailure } from '@qgroup/contracts';
import { withErrorText } from './language';

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
export function apiFailureError(status: number, failure: z.infer<typeof ApiFailure>) {
  const error = new ApiError(status, failure.code, failure.message), pair = failure.messageDisplay;
  return pair ? withErrorText(error, pair.hans, pair.hant) : error;
}
