import assert from 'node:assert/strict';
import {reactControllers} from '../deploy/react_controllers.mjs';

// Migration boundaries must preserve async storage calls, native event listeners
// and business payload values while routing only DOM view operations to React.
const source=`
await BoardStore.remove(key);
el.innerHTML = items.map(x => '<button>'+esc(x.title)+'</button>').join('');
button.textContent = '保存';
const b = document.createElement('button');
row.append(name, b);
row.remove();
box.querySelector('.old')?.remove();
box.insertAdjacentHTML('beforeend', rowHtml(box.children.length));
box.lastElementChild.querySelector('input').focus();
document.addEventListener('DOMContentLoaded', boot);
select.addEventListener('change', onChange);
const data = {category:'约K', enabled:false};
`;
// The original modules are classic scripts; their async calls live in functions.
const transformed=reactControllers(`async function test(){${source}}`);
assert.match(transformed,/await BoardStore\.remove\(key\)/);
assert.match(transformed,/UI\.html\(el,/);
assert.match(transformed,/UI\.text\(button,'保存'\)/);
assert.match(transformed,/UI\.create\('button'\)/);
assert.match(transformed,/row\.append\(UI\.node\(name\),UI\.node\(b\)\)/);
assert.match(transformed,/UI\.remove\(row\)/);
assert.match(transformed,/element&&UI\.remove\(element\)/);
assert.match(transformed,/UI\.children\(box\)\.length/);
assert.match(transformed,/UI\.children\(box\)\.at\(-1\)/);
assert.match(transformed,/UI\.ready\(boot\)/);
assert.match(transformed,/select\.addEventListener\('change', onChange\)/);
assert.match(transformed,/category:'约K', enabled:false/);
console.log('React view boundaries preserve storage, payloads, listeners and dynamic row semantics');
