import { domainErrorDisplay, type DomainError } from '@qgroup/domain';
export function apiFailure(error:DomainError) {
  const pair=domainErrorDisplay(error);
  return {code:error.code,message:error.message,...pair?{messageDisplay:{hans:pair[0],hant:pair[1]}}:{}};
}
