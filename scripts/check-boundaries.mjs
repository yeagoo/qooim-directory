import ts from "typescript";
import { readFileSync, readdirSync, existsSync, realpathSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(process.argv[2] ?? "p0");
const files = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? files(resolve(dir, e.name))
      : /\.[cm]?[jt]sx?$/.test(e.name)
        ? [resolve(dir, e.name)]
        : [],
  );
export function check(rootPath = root) {
  const errors = [];
  const visited = new Set();
  const walk = (file) => {
    if (visited.has(file)) return;
    visited.add(file);
    const code = readFileSync(file, "utf8"),
      ast = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (
        ts.isIdentifier(node) &&
        ["process", "globalThis", "require", "eval", "Function"].includes(
          node.text,
        )
      )
        errors.push(
          `${relative(rootPath, file)}: forbidden global ${node.text}`,
        );
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      )
        errors.push(`${relative(rootPath, file)}: dynamic imports forbidden`);
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const name = node.moduleSpecifier.text;
        if (name.startsWith(".")) {
          const base = resolve(dirname(file), name);
          const candidates = /\.[cm]?[jt]sx?$/.test(base)
            ? [
                base.replace(/\.js$/, ".ts"),
                base.replace(/\.js$/, ".tsx"),
                base,
              ]
            : [base + ".ts", base + ".tsx", resolve(base, "index.ts")];
          let target = candidates.find((p) => existsSync(p)) ?? base;
          if (existsSync(target)) target = realpathSync(target);
          if (target === resolve(rootPath, "public/sdk.ts")) return;
          if(target===resolve('src/public/sdk.ts')){walk(target);return;}
          // Only the framework's fixed route entry may compose the application server.
          if (
            file === resolve("app/[[...path]]/route.ts") &&
            target === resolve("src/server/entry.ts")
          )
            return;
          const allowedRoot = file.startsWith(resolve('src/templates')+'/')?resolve('src/templates'):file.startsWith(resolve('src/public')+'/')?resolve('src/public'):file.startsWith(resolve("src/ui") + "/")
            ? resolve("src/ui")
            : rootPath;
          if (
            !target.startsWith(allowedRoot + "/") ||
            target.includes("/internal/")
          )
            errors.push(
              `${relative(rootPath, file)}: forbidden import ${name}`,
            );
          else {
            try {
              walk(target);
            } catch {
              errors.push(
                `${relative(rootPath, file)}: unresolved import ${name}`,
              );
            }
          }
        } else if (!["react", "react/jsx-runtime"].includes(name))
          errors.push(
            `${relative(rootPath, file)}: package not allowed ${name}`,
          );
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  };
  for (const folder of ["templates", "public"])
    for (const f of files(resolve(rootPath, folder)))
      if (f !== resolve(rootPath, "public/sdk.ts")) walk(f);
  if (rootPath === resolve("p0") && existsSync(resolve("src/ui")))
    for (const f of files(resolve("src/ui"))) walk(f);
  if(rootPath===resolve('p0'))for(const folder of ['src/templates','src/public'])if(existsSync(resolve(folder)))for(const f of files(resolve(folder)))walk(f);
  if (rootPath === resolve("p0") && existsSync(resolve("app")))
    for (const f of files(resolve("app"))) walk(f);
  return errors;
}
// Public entry points must not bypass the content data layer with business SQL.
export function checkDataBoundary(sourceRoot = resolve("src")) {
  const errors = [];
  const allowed = new Set(["domain/catalog.ts", "server/content.ts", "cli.ts"]);
  for (const file of files(sourceRoot)) {
    const name = relative(sourceRoot, file);
    if (allowed.has(name)) continue;
    const ast = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    function visit(node) {
      if (
        (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) &&
        /\b(?:FROM|JOIN|UPDATE|INTO)\s+(?:publication|resource|category)\b/i.test(
          node.getText(ast),
        )
      )
        errors.push(`${name}: business SQL must use the content data layer`);
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  return errors;
}
if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = [...check(), ...checkDataBoundary()];
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else console.log("Public/template dependency boundaries passed");
}
