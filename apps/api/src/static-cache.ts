import {relative,sep} from 'node:path';

/** Compressed siblings have the same logical cache lifetime as their original
 * asset. Stable PWA filenames must always be checked against the current build. */
export function staticCacheControl(root:string,path:string){
  const name=relative(root,path).split(sep).join('/').replace(/\.(?:br|gz|deflate)$/,'');
  if(/(?:^|\/)(?:sw\.js|manifest\.webmanifest|manifest\.json)$/.test(name))return 'no-store';
  if(/^assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(name))return 'public, max-age=31536000, immutable';
  return 'public, max-age=0, must-revalidate';
}
