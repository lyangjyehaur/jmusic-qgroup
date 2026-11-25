import ts from 'typescript';
import { Converter } from 'opencc-js';
import { parseExpression } from '@babel/parser';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
const hans = Converter({ from: 't', to: 'cn' }), traditional = Converter({ from: 'cn', to: 'tw' });
const hant = (text: string) => traditional(text).replaceAll('賬', '帳');
const han = /[\u3400-\u9fff]/;
const attributes = new Set(['title', 'description', 'label', 'placeholder', 'aria-label', 'alt', 'hint', 'error', 'closeLabel']);
const alias = '__qgroupDisplay';
const errorAlias = '__qgroupError';
// 台北 is valid in both scripts; retain the existing form's geographic label.
const preserved = (text: string, convert: (text: string) => string) => text.split(/(台北|[\u3400-\u9fff]ICP备\d+号(?:-\d+)?)/).map(part => part === '台北' || /^[\u3400-\u9fff]ICP备\d+号(?:-\d+)?$/.test(part) ? part : convert(part)).join('');
export const compileDisplayPair = (text: string): readonly [string,string] => [preserved(text,hans),preserved(text,hant)];
function jsxText(text: string) {
  const fragment = parseExpression('<>' + text + '</>', { plugins: ['jsx'] });
  if (fragment.type !== 'JSXFragment' || fragment.children.some(child => child.type !== 'JSXText')) throw Error('Expected static JSX text');
  const lines = fragment.children.map(child => child.type === 'JSXText' ? child.value : '').join('').split(/\r\n|\n|\r/);
  let last = 0;
  for (const [index, line] of lines.entries()) if (/[^ \t]/.test(line)) last = index;
  return lines.map((line, index) => {
    let value = line.replaceAll('\t', ' ');
    if (index !== 0) value = value.replace(/^ +/, '');
    if (index !== lines.length - 1) value = value.replace(/ +$/, '');
    return value ? value + (index !== last ? ' ' : '') : '';
  }).join('');
}
function jsxAttribute(text: string) {
  const element = parseExpression(`<x title="${text}"/>`, { plugins: ['jsx'] });
  const attr = element.type === 'JSXElement' ? element.openingElement.attributes[0] : undefined;
  if (attr?.type !== 'JSXAttribute' || attr.value?.type !== 'StringLiteral') throw Error('Expected static JSX attribute');
  return attr.value.value;
}
/** Translate proven display literals only. Expressions, callbacks, wire values and data stay original. */
export function transformUILanguage(source: string, filename: string) {
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edits: { start: number; end: number; value: string }[] = [];
  const pair = (text: string) => `${alias}(${JSON.stringify(preserved(text, hans))},${JSON.stringify(preserved(text, hant))})`;
  const expression = (node: ts.Expression) => {
    if (ts.isStringLiteral(node) && han.test(node.text)) edits.push({ start: node.getStart(tree), end: node.end, value: pair(node.text) });
    else if (ts.isConditionalExpression(node)) { expression(node.whenTrue); expression(node.whenFalse); }
    else if (ts.isBinaryExpression(node) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(node.operatorToken.kind)) { expression(node.left); expression(node.right); }
    else if (ts.isParenthesizedExpression(node)) expression(node.expression);
    // Templates, calls, arrays and objects require an explicit uiText boundary.
  };
  function visit(node: ts.Node, skip = false) {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      skip ||= opening.attributes.properties.some(attr => ts.isJsxAttribute(attr) && attr.name.getText(tree) === 'translate' && attr.initializer && ts.isStringLiteral(attr.initializer) && attr.initializer.text === 'no');
      if (!skip && opening.tagName.getText(tree) === 'option' && !opening.attributes.properties.some(attr => ts.isJsxAttribute(attr) && attr.name.getText(tree) === 'value')) {
        // HTML otherwise submits the translated visible label. Preserve the original implicit value.
        const text = ts.isJsxElement(node) ? node.children.filter(ts.isJsxText).map(child => child.text).join('') : '';
        if (han.test(text)) throw Error(`${filename}: translatable option needs an explicit value`);
        skip = true;
      }
    }
    if (!skip && ts.isJsxText(node) && han.test(node.text)) {
      edits.push({ start: node.pos, end: node.end, value: `{${pair(jsxText(node.text))}}` });
    } else if (!skip && ts.isJsxAttribute(node) && attributes.has(node.name.getText(tree)) && node.initializer) {
      if (ts.isStringLiteral(node.initializer) && han.test(node.initializer.text)) {
        const text = jsxAttribute(node.initializer.text);
        edits.push({ start: node.initializer.getStart(tree), end: node.initializer.end, value: `{${pair(text)}}` });
      } else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) expression(node.initializer.expression);
    } else if (!skip && ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent) && node.expression) expression(node.expression);
    if (!skip && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'uiText') {
      const argument = node.arguments[0];
      if (node.arguments.length !== 1 || !argument || !ts.isStringLiteral(argument)) throw Error(`${filename}: uiText accepts one static literal; user data must remain original`);
      edits.push({ start: node.getStart(tree), end: node.end, value: pair(argument.text) });
    }
    if (!skip && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'displayError') {
      const [error, message] = node.arguments;
      if (node.arguments.length !== 2 || !error || !message || !ts.isStringLiteral(message)) throw Error(`${filename}: displayError needs an original exception and one static display literal`);
      edits.push({start:node.getStart(tree),end:node.end,value:`${errorAlias}(${error.getText(tree)},${JSON.stringify(preserved(message.text,hans))},${JSON.stringify(preserved(message.text,hant))})`});
    }
    // A fixed super message belongs to this Error subclass, not to arbitrary
    // classes, values or later throw sites. Annotate only after native super.
    if (!skip && ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword && ts.isExpressionStatement(node.parent)) {
      const constructor = node.parent.parent.parent;
      const owner = ts.isConstructorDeclaration(constructor) ? constructor.parent : undefined;
      if (owner && (ts.isClassDeclaration(owner) || ts.isClassExpression(owner)) && owner.heritageClauses?.some(clause => clause.token === ts.SyntaxKind.ExtendsKeyword && clause.types.some(type => type.expression.getText(tree) === 'Error'))) {
        const message = node.arguments[0];
        if (message && ts.isStringLiteral(message) && han.test(message.text)) edits.push({start:node.parent.end,end:node.parent.end,value:`;${errorAlias}(this,${JSON.stringify(preserved(message.text,hans))},${JSON.stringify(preserved(message.text,hant))});`});
      }
    }
    if (!skip && (ts.isCallExpression(node) || ts.isNewExpression(node)) && ts.isIdentifier(node.expression) && ['Error','DraftConflict','DraftExpired','ApiError'].includes(node.expression.text)) {
      const argument = node.arguments?.[node.expression.text === 'ApiError' ? 2 : 0];
      if (argument && ts.isStringLiteral(argument) && han.test(argument.text)) edits.push({start:node.getStart(tree),end:node.end,value:`${errorAlias}(${node.getText(tree)},${JSON.stringify(preserved(argument.text,hans))},${JSON.stringify(preserved(argument.text,hant))})`});
    }
    ts.forEachChild(node, child => visit(child, skip));
  }
  visit(tree);
  if (!edits.length) return source;
  if (source.includes(alias) || source.includes(errorAlias)) throw Error(`${filename}: reserved language compiler binding`);
  const ordered = edits.sort((a, b) => b.start - a.start);
  for (const [index, edit] of ordered.entries()) {
    if (index && edit.end > ordered[index - 1]!.start) throw Error(`${filename}: overlapping language boundaries; declare the inner error separately`);
    source = source.slice(0, edit.start) + edit.value + source.slice(edit.end);
  }
  return `import { displayText as ${alias}, withErrorText as ${errorAlias} } from './language';\n` + source;
}
export function uiLanguage(): Plugin {
  const sourceRoot = fileURLToPath(new URL('./src/', import.meta.url));
  return { name: 'unified-display-language', enforce: 'pre', transform(source, id) {
    if (!id.startsWith(sourceRoot) || !/\/src\/[^/]+\.tsx?$/.test(id) || id.endsWith('/language.ts')) return;
    return { code: transformUILanguage(source, id), map: null };
  } };
}
