import React, {useLayoutEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import parse, {attributesToProps, domToReact} from 'html-react-parser';
import {ThemeProvider, Button, Input, Textarea, Checkbox, Select, Surface, Badge} from 'yahha-ui';

// The data/API controllers retain their native form refs during the migration.
// React owns each view boundary and renders real Yahha components. Explicit
// boundaries avoid a DOM-wide MutationObserver and never rewrite user content.
const roots = new Map();
const controls = new WeakMap();
const removals = new WeakMap();

// Nested rows can be removed independently of their enclosing view root.
// Let React remove its own node so reopening the form can unmount cleanly.
function OwnedNode({tag, props, children}) {
  const [removed,setRemoved]=useState(false);
  const ref=useRef(null);
  useLayoutEffect(()=>{
    const element=ref.current;
    if(!element)return;
    removals.set(element,()=>flushSync(()=>setRemoved(true)));
    return ()=>removals.delete(element);
  },[removed]);
  if(removed)return null;
  return React.createElement(tag,{...props,ref},children);
}
const nativeClass = Object.getOwnPropertyDescriptor(Element.prototype, 'className');
const ghost = /(?:^|\s)(?:link|text-button|icon-button|icon-btn|refresh-button|profile-button|notification-button|home-qq-button)(?:\s|$)/;
const optionsOf = select => [...select.options].map(o => ({value:o.value, label:o.textContent, disabled:o.disabled}));

function SelectField({children, label, className, value, defaultValue, ...props}) {
  const model = useRef(null), trigger = useRef(null);
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState('');
  useLayoutEffect(() => {
    const select = model.current;
    const sync = () => setSnapshot({options:optionsOf(select), value:select.value, disabled:select.disabled, hidden:select.hidden, required:select.required});
    select.__uiSync=sync;
    // The model is a real select: FormData, reset(), options, disabled fields,
    // existing validation and server payloads retain their native semantics.
    const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    Object.defineProperty(select, 'value', {configurable:true, get:()=>desc.get.call(select), set:v=>{desc.set.call(select,v);sync();}});
    const observer = new MutationObserver(sync);
    observer.observe(select,{attributes:true, childList:true, subtree:true});
    select.addEventListener('change',sync);
    const reset = () => queueMicrotask(sync);
    const form=select.form;
    form?.addEventListener('reset',reset);
    sync();
    return () => {observer.disconnect();select.removeEventListener('change',sync);form?.removeEventListener('reset',reset);delete select.value;delete select.__uiSync;};
  },[]);
  const {id, name, required, disabled, hidden, ...visibleProps} = props;
  const triggerProps=Object.fromEntries(Object.entries(visibleProps).filter(([key])=>!key.startsWith('data-')));
  return <span className="ui-select" hidden={snapshot?.hidden ?? hidden}>
    <select {...props} id={id} name={name} required={required} disabled={disabled} hidden={hidden}
      className={[className,'ui-select-model'].filter(Boolean).join(' ')} ref={model}
      aria-hidden="true" tabIndex={-1} defaultValue={defaultValue ?? value}
      onFocus={()=>trigger.current?.focus()} onInvalid={event=>{event.preventDefault();setError(model.current.validationMessage);trigger.current?.focus();}}>{children}</select>
    {snapshot && <Select {...triggerProps} id={id ? `${id}-trigger` : undefined} ref={trigger}
      label={label || null} aria-label={props['aria-label'] || (typeof label==='string'?label:undefined) || props.title || (!label?(name || '请选择'):undefined)}
      className="ui-select-field" classNames={{trigger:className}} options={snapshot.options}
      value={snapshot.value || null} disabled={snapshot.disabled} required={false} error={error || undefined}
      portalContainer={model.current?.closest('dialog') || undefined}
      onValueChange={next=>{const select=model.current;select.value=next ?? '';setError('');select.dispatchEvent(new Event('input',{bubbles:true}));select.dispatchEvent(new Event('change',{bubbles:true}));}} />}
  </span>;
}

function Control({tag, props, children, label}) {
  if (tag === 'button') {
    const c=props.className || '';
    return <Button {...props} type={props.type || 'submit'} variant={/\bprimary\b/.test(c)?'primary':ghost.test(c)?'ghost':'secondary'}
      appearance={/\bprimary\b/.test(c)?'soft':'default'} destructive={/\bdanger\b/.test(c)}>{children}</Button>;
  }
  if (tag === 'select') return <SelectField {...props} label={label}>{children}</SelectField>;
  if (tag === 'textarea') return <Textarea {...props} label={label || null} className="ui-field" classNames={{textarea:props.className}} defaultValue={props.defaultValue ?? text(children)} />;
  if (tag === 'input' && !['hidden','radio','range','color'].includes(props.type)) {
    if (props.type==='checkbox') return <Checkbox {...props} label={null} className="ui-checkbox" classNames={{input:props.className}} />;
    return <Input {...props} label={label || null} className="ui-field" classNames={{input:props.className}} />;
  }
  return tag==='input' ? React.createElement(tag,props) : React.createElement(tag,props,children);
}
function text(children) {
  return React.Children.toArray(children).map(c=>typeof c==='string'?c:typeof c==='number'?String(c):'').join('');
}
function labelOf(node) {
  const parent=node.parent;
  return parent?.name==='label' ? parent.children?.filter(n=>n.type==='text').map(n=>n.data).join(' ').trim() : undefined;
}
const parseOptions = {replace(node) {
  if(node.type==='script' || node.name==='script') return <></>;
  if(node.type!=='tag') return;
  const tag=node.name, props=attributesToProps(node.attribs || {});
  if(tag==='dialog') props.onKeyDownCapture=event=>{
    // Escape dismisses a select before dismissing its enclosing native dialog.
    if(event.key==='Escape' && event.currentTarget.querySelector('[role=combobox][aria-expanded=true]')) event.preventDefault();
  };
  if(tag==='label') {
    const field=node.children?.find(n=>['input','textarea','select'].includes(n.name));
    if(field && field.attribs?.type!=='radio' && field.attribs?.type!=='hidden') {
      const position=node.children.indexOf(field);
      const fieldProps=attributesToProps(field.attribs || {});
      if('value' in fieldProps){fieldProps.defaultValue=fieldProps.value;delete fieldProps.value;}
      if('checked' in fieldProps){fieldProps.defaultChecked=fieldProps.checked;delete fieldProps.checked;}
      if(field.name==='select' && fieldProps.defaultValue===undefined) {
        const selected=field.children?.find(n=>n.name==='option' && 'selected' in (n.attribs || {}));
        if(selected)fieldProps.defaultValue=selected.attribs.value ?? text(domToReact(selected.children || [],parseOptions));
      }
      if(fieldProps.type==='checkbox') {
        const rest=node.children.filter(n=>n!==field && !/\bswitch-track\b/.test(n.attribs?.class || ''));
        return <div {...props} className={`${props.className || ''} ui-check-field`}><Checkbox {...fieldProps}
          label={domToReact(rest,parseOptions)} className="ui-checkbox" classNames={{input:fieldProps.className}} /></div>;
      }
      const label=domToReact(node.children.slice(0,position),parseOptions);
      return <div {...props} className={`${props.className || ''} ui-label`}><Control tag={field.name} props={fieldProps} label={label}>
        {domToReact(field.children || [],parseOptions)}</Control>{domToReact(node.children.slice(position+1),parseOptions)}</div>;
    }
  }
  // Markup snapshots describe initial native state, never controlled values.
  if(['input','textarea','select'].includes(tag)) {
    if('value' in props){props.defaultValue=props.value;delete props.value;}
    if('checked' in props){props.defaultChecked=props.checked;delete props.checked;}
  }
  if(tag==='option' && props.selected){delete props.selected;}
  let children=domToReact(node.children || [],parseOptions);
  if(tag==='select' && props.defaultValue===undefined) {
    const selected=node.children?.find(n=>n.name==='option'&&'selected' in (n.attribs || {}));
    if(selected) props.defaultValue=selected.attribs.value ?? selected.children?.map(n=>n.data || '').join('');
  }
  if(['button','input','textarea','select'].includes(tag)) return <Control tag={tag} props={props} label={labelOf(node)}>{children}</Control>;
  if(/(?:^|\s)(?:category-label|count-badge|admin-user-role|cat-tag|mini-tag|sim-badge|lv-badge)(?:\s|$)/.test(props.className || '')) return <Badge {...props}>{children}</Badge>;
  if(/(?:^|\s)(?:event-card|home-account|admin-card|card)(?:\s|$)/.test(props.className || '')) {
    return <OwnedNode tag={tag} props={props}><Surface className="ui-paper">{children}</Surface></OwnedNode>;
  }
  return ['area','base','br','col','embed','hr','img','link','meta','param','source','track','wbr'].includes(tag)
    ? <OwnedNode tag={tag} props={props} /> : <OwnedNode tag={tag} props={props}>{children}</OwnedNode>;
}};
const markup = value => parse(String(value ?? ''),parseOptions);

function clear(target) {
  for(const [host,root] of [...roots]) if(target===host || target.contains(host)) {
    flushSync(()=>root.unmount());roots.delete(host);
  }
}
function mount(target,children,position='replace') {
  if(position==='replace'){clear(target);target.replaceChildren();}
  const host=document.createElement('ui-fragment');host.className='ui-fragment';
  if(position==='prepend')target.prepend(host);else target.append(host);
  const root=createRoot(host);roots.set(host,root);
  flushSync(()=>root.render(children));
}
function controlMarkup(target,children) {
  const info=controls.get(target);
  if(!info)return false;
  const props=attributesToProps(Object.fromEntries([...target.attributes].map(a=>[a.name,a.value])));
  delete props['data-variant'];delete props['data-appearance'];delete props['data-destructive'];delete props['data-size'];
  delete props.children;
  if(target.tagName!=='BUTTON')return false;
  flushSync(()=>info.root.render(<Control tag="button" props={props}>{children}</Control>));
  return true;
}
function html(target,value) {
  if(target.tagName==='SELECT') {target.innerHTML=String(value ?? '');target.__uiSync?.();return value;}
  if(!controlMarkup(target,markup(value))) mount(target,markup(value));
  return value;
}
function setText(target,value) {
  if(controlMarkup(target,String(value ?? '')))return value;
  clear(target);target.textContent=value;return value;
}
function insert(target,position,value) {
  const children=markup(value);
  if(position==='beforeend')mount(target,children,'append');
  else if(position==='afterbegin')mount(target,children,'prepend');
  else throw new Error(`Unsupported view insertion: ${position}`);
}
function create(tag) {
  if(!['button','input','textarea','select'].includes(tag))return document.createElement(tag);
  const host=document.createElement('ui-fragment');host.className='ui-fragment ui-control-island';
  const root=createRoot(host);roots.set(host,root);
  flushSync(()=>root.render(<Control tag={tag} props={{type:tag==='button'?'button':undefined}} />));
  const control=host.querySelector(tag);
  controls.set(control,{host,root});
  const base=control.className;
  Object.defineProperty(control,'className',{configurable:true,get:()=>nativeClass.get.call(control),set:value=>{
    nativeClass.set.call(control,`${base} ${value}`.trim());
    if(tag==='button') {
      control.dataset.variant=/\bprimary\b/.test(value)?'primary':ghost.test(value)?'ghost':'secondary';
      control.dataset.appearance=/\bprimary\b/.test(value)?'soft':'default';
      control.dataset.destructive=String(/\bdanger\b/.test(value));
    }
  }});
  return control;
}
function node(value){return controls.get(value)?.host || value;}
function remove(value){
  const host=node(value),removeOwned=removals.get(host);
  clear(host);
  if(removeOwned)removeOwned();else host.remove();
}
function boot() {
  const content=document.body.innerHTML;
  const root=createRoot(document.body);
  flushSync(()=>root.render(<ThemeProvider theme="pink" className="ui-root">{markup(content)}</ThemeProvider>));
  document.documentElement.dataset.ui='yahha';
  document.body.removeAttribute('data-ui-pending');
}
export const UI={boot,html,text:setText,insert,create,node,remove,
  ready:callback=>queueMicrotask(callback),
  children:element=>[...element.children].flatMap(child=>child.matches('ui-fragment:not(.ui-control-island)')?UI.children(child):[child]),
};
