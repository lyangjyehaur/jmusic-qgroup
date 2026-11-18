import { setDomainErrorDisplay } from '@qgroup/domain';
import { apiErrorPairs } from './error-pairs.generated';
/** Only explicitly audited source constructors acquire display metadata. */
export function withApiError<T extends Error & {readonly code:string}>(error:T):T {
  const pair=apiErrorPairs[JSON.stringify([error.code,error.message])];
  return pair?setDomainErrorDisplay(error,pair):error;
}
