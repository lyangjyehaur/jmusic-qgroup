/** Tokens in legacy and native invitation/claim paths must not enter request logs. */
export function redactRequestURL(url:string|undefined){return url?.split('?')[0]?.replace(/\/(claims\/preview|delegation\/preview|invitations|claims|delegation|access)\/[^/]+/g,'/$1/[redacted]');}
