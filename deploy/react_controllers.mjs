import {parse} from '@babel/parser';

// Explicit build-time migration of the existing view boundaries. There are no
// patched browser prototypes: only these reviewed controller operations change.
// API payloads, business rules, escaping, drafts and delegated listeners stay in
// their original modules and keep the existing regression coverage.
export function reactControllers(source) {
  const tree=parse(source,{sourceType:'script'});
  function render(node) {
    if(!node || typeof node!=='object' || typeof node.start!=='number')return '';
    const children=[];
    for(const [key,value] of Object.entries(node)) {
      if(['loc','start','end','extra','comments','leadingComments','trailingComments','innerComments'].includes(key))continue;
      for(const child of Array.isArray(value)?value:[value]) {
        if(child && typeof child==='object' && typeof child.start==='number')children.push(child);
      }
    }
    const r=render;
    const member=node.type==='AssignmentExpression'?node.left:['MemberExpression','OptionalMemberExpression'].includes(node.type)?node:node.callee;
    const property=member?.computed?member.property?.value:member?.property?.name;
    if(node.type==='AssignmentExpression' && node.operator==='=' && member?.type==='MemberExpression') {
      if(property==='innerHTML')return `UI.html(${r(member.object)},${r(node.right)})`;
      if(property==='textContent')return `UI.text(${r(member.object)},${r(node.right)})`;
    }
    if(node.type==='MemberExpression' && property==='children')return `UI.children(${r(node.object)})`;
    if(node.type==='MemberExpression' && property==='lastElementChild')return `UI.children(${r(node.object)}).at(-1)`;
    if(node.type==='CallExpression' || node.type==='OptionalCallExpression') {
      if(member?.object?.name==='document' && property==='createElement' && ['button','input','select','textarea'].includes(node.arguments[0]?.value))return `UI.create(${r(node.arguments[0])})`;
      if(member?.object?.name==='document' && property==='addEventListener' && node.arguments[0]?.value==='DOMContentLoaded')return `UI.ready(${r(node.arguments[1])})`;
      if(property==='insertAdjacentHTML')return `UI.insert(${r(member.object)},${node.arguments.map(r).join(',')})`;
      if(property==='closest' && node.arguments[0]?.value==='label')return `${r(member)}('.ui-label, label')`;
      if(property==='remove' && !node.arguments.length) {
        const object=r(member.object);
        return member.optional || node.optional ? `((element)=>element&&UI.remove(element))(${object})` : `UI.remove(${object})`;
      }
      if(['append','appendChild','prepend','insertBefore','replaceChild','replaceWith','before','after','replaceChildren'].includes(property)) {
        return `${r(member)}(${node.arguments.map(arg=>`UI.node(${r(arg)})`).join(',')})`;
      }
    }
    let value=source.slice(node.start,node.end);
    const unique=new Map(children.map(c=>[`${c.start}:${c.end}`,c]));
    for(const child of [...unique.values()].sort((a,b)=>b.start-a.start)) {
      const next=r(child);
      value=value.slice(0,child.start-node.start)+next+value.slice(child.end-node.start);
    }
    return value;
  }
  const result=render(tree.program);
  parse(result,{sourceType:'module'});
  return result;
}
