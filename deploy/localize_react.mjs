import { parse } from "@babel/parser";
import OpenCC from "opencc-js";
const traditional = OpenCC.Converter({ from: "cn", to: "tw" }),
  simple = OpenCC.Converter({ from: "t", to: "cn" });
const canonical = new Set([
  "全部",
  "约K",
  "聚餐",
  "运动",
  "出游",
  "游戏",
  "其他",
]);
// Translate authored system copy at build time. API values and user content never pass through OpenCC.
export function localizeReact(source, locale) {
  const convert =
      locale === "hant"
        ? (value) => traditional(value).replace(/賬/g, "帳")
        : simple,
    edits = [];
  const ast = parse(source, {
    sourceType: "module",
    plugins: ["jsx", "typescript"],
  });
  function visit(node, parent, key) {
    if (!node || typeof node !== "object") return;
    // Type-only literals describe contracts rather than display copy.
    if (
      [
        "TSTypeAnnotation",
        "TSTypeAliasDeclaration",
        "TSInterfaceDeclaration",
        "TSTypeParameterDeclaration",
        "TSTypeParameterInstantiation",
      ].includes(node.type)
    )
      return;
    // Names and authored text marked translate="no" must survive both builds.
    if (
      node.type === "JSXElement" &&
      node.openingElement.attributes.some(
        (attr) =>
          attr.type === "JSXAttribute" &&
          attr.name.name === "translate" &&
          attr.value?.value === "no",
      )
    )
      return;
    if (node.type === "JSXText")
      edits.push([node.start, node.end, convert(node.value)]);
    if (node.type === "StringLiteral" && /[\u3400-\u9fff]/.test(node.value)) {
      const objectKey =
        ["ObjectProperty", "ObjectMethod"].includes(parent?.type) &&
        key === "key" &&
        !parent.computed;
      if (
        !canonical.has(node.value) &&
        !objectKey &&
        !(parent?.type === "BinaryExpression" && parent.operator !== "+") &&
        parent?.type !== "SwitchCase"
      ) {
        const translated = convert(node.value);
        edits.push([
          node.start,
          node.end,
          parent?.type === "JSXAttribute"
            ? JSON.stringify(translated).replace(/\\"/g, "&quot;")
            : JSON.stringify(translated),
        ]);
      }
    }
    if (node.type === "TemplateElement")
      edits.push([node.start, node.end, convert(node.value.raw)]);
    for (const [childKey, child] of Object.entries(node)) {
      if (
        [
          "loc",
          "start",
          "end",
          "extra",
          "comments",
          "leadingComments",
          "trailingComments",
        ].includes(childKey)
      )
        continue;
      if (Array.isArray(child))
        child.forEach((item) => visit(item, node, childKey));
      else if (typeof child === "object") visit(child, node, childKey);
    }
  }
  visit(ast, null, "");
  for (const [start, end, value] of edits.sort((a, b) => b[0] - a[0]))
    source = source.slice(0, start) + value + source.slice(end);
  parse(source, { sourceType: "module", plugins: ["jsx", "typescript"] });
  return source;
}
