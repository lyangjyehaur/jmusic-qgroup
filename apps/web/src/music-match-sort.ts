import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
type Sort = 'rare' | 'familiar';
const preferenceKey = 'qgroup:rebuild:music:match-sort:v1';
function preferred(): Sort {
  try { return (localStorage.getItem(preferenceKey) ?? localStorage.getItem('jpm.matchSort')) === 'familiar' ? 'familiar' : 'rare'; }
  catch { return 'rare'; }
}
/** An explicit URL wins; fresh entries reuse the same preference for recommendations and sharing. */
export function useMusicMatchSort() {
  const [params, setParams] = useSearchParams(), [preference, setPreference] = useState(preferred);
  const raw = params.get('sort'), sort: Sort = raw === 'rare' || raw === 'familiar' ? raw : preference;
  function change(next: Sort) {
    setPreference(next); try { localStorage.setItem(preferenceKey, next); } catch { /* URL and current controls still work without storage. */ }
    setParams(old => { const updated = new URLSearchParams(old); updated.set('sort', next); return updated; }, { replace: true });
  }
  return { sort, change };
}
