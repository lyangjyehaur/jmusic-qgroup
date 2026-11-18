import { domainErrorPairs } from './error-pairs.generated';
const displays = new WeakMap<Error, readonly [string,string]>();
/** Display metadata never changes the error instance, code, message or stack. */
export function setDomainErrorDisplay<T extends Error>(error:T,pair:readonly [string,string]):T { displays.set(error,pair);return error; }
export function domainErrorDisplay(error:Error) { return displays.get(error); }
/** Build audit permits only a DomainError with fixed code/message branches. */
export function withDomainError<T extends Error & {readonly code:string}>(error:T):T {
  const pair=domainErrorPairs[JSON.stringify([error.code,error.message])];
  return pair?setDomainErrorDisplay(error,pair):error;
}
