import fs from "fs";
import path from "path";
import { builtinModules, createRequire } from "module";
import ts from "typescript";
import { REPO_ROOT } from "./policy";
import { assertNoSymlinkPath } from "./provenance";

type Kind = "candidate" | "policy";
const runtimeExtensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const builtins = new Set(["assert", "assert/strict", "buffer", "crypto", "events", "path", "path/posix", "path/win32", "querystring", "stream", "stream/promises", "string_decoder", "timers", "timers/promises", "url", "util", "util/types"]);
function inside(root: string, file: string): boolean {
  const relative=path.relative(root,file);
  return relative === "" || (!relative.startsWith(".."+path.sep) && relative !== ".." && !path.isAbsolute(relative));
}
function fail(detail: string): never { throw new Error(`unsupported dependency: ${detail}`); }

/** Installed runner packages are a trusted, lockfile-provisioned runtime, not an integrity attestation. */
function lockedPackage(file: string): void {
  const modules=path.join(REPO_ROOT,"node_modules");
  if (!inside(modules,file)) fail("module outside approved runner dependencies");
  assertNoSymlinkPath(file);
  let dir=path.dirname(file);
  while (inside(modules,dir) && !fs.existsSync(path.join(dir,"package.json"))) dir=path.dirname(dir);
  const key=path.relative(REPO_ROOT,dir).split(path.sep).join("/");
  const lock=JSON.parse(fs.readFileSync(path.join(REPO_ROOT,"package-lock.json"),"utf8")).packages?.[key];
  if (!lock || lock.link || !lock.integrity || !lock.version) fail("package absent from approved runner lockfile");
  const installed=JSON.parse(fs.readFileSync(path.join(dir,"package.json"),"utf8"));
  if (installed.version !== lock.version) fail("installed package differs from runner lockfile");
}
function checkBare(name: string, importer: string, kind: Kind): void {
  const plain=name.replace(/^node:/,"");
  if (builtinModules.includes(plain) || name.startsWith("node:")) {
    if (!builtins.has(plain) && !(kind === "policy" && ["fs","fs/promises"].includes(plain))) fail("runtime loading/IO builtin is not supported: "+name);
    return;
  }
  if (!/^(@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(name) || name.split("/").includes("..")) fail("private/aliased module import");
  let actual: string, expected: string;
  const resolver=createRequire(importer);
  const packageName=name.startsWith("@") ? name.split("/").slice(0,2).join("/") : name.split("/")[0];
  // Node realpaths its result, which otherwise hides a candidate's junction to a trusted package.
  for (const lookup of resolver.resolve.paths(name) ?? []) {
    const packageDir=path.join(lookup,packageName);
    if (!fs.existsSync(packageDir)) continue;
    assertNoSymlinkPath(packageDir);
    if (!inside(path.join(REPO_ROOT,"node_modules"),packageDir)) fail("package lookup outside approved runner dependencies");
    break;
  }
  try {
    actual=resolver.resolve(name);
    expected=createRequire(path.join(REPO_ROOT,"package.json")).resolve(name);
  } catch { fail("module not resolvable in approved runner: "+name); }
  if (actual! !== expected!) fail("import resolves outside approved runner package: "+name);
  lockedPackage(actual!);
  // The candidate runtime is intentionally small. General loaders, compilers and IO libraries
  // cannot safely be treated as opaque application dependencies by this static graph check.
  if (kind === "candidate" && name !== "express") fail("candidate package runtime supports express only");
}

/** Reject unbound configuration that can redirect Node/Vite/TypeScript resolution. */
function resolutionConfig(importer: string): void {
  let dir=path.dirname(importer);
  for (;;) {
    for (const name of ["package.json","tsconfig.json","jsconfig.json"]) {
      const file=path.join(dir,name);
      if (!fs.existsSync(file)) continue;
      assertNoSymlinkPath(file);
      const parsed=ts.parseConfigFileTextToJson(file,fs.readFileSync(file,"utf8"));
      if (parsed.error) fail("invalid resolution config");
      const value=parsed.config;
      if (name === "package.json") {
        if (["imports","exports","browser","module","main","type"].some(k=>value[k] !== undefined)) fail("unbound package resolution config");
      } else {
        const allowed=new Set(["target","module","esModuleInterop","strict","skipLibCheck","types","noEmit","resolveJsonModule","moduleResolution"]);
        if (value.extends || Object.keys(value.compilerOptions ?? {}).some(k=>!allowed.has(k))) fail("unbound TypeScript resolution config");
        const fixed:Record<string,unknown>={target:"es2020",module:"commonjs",esModuleInterop:true,resolveJsonModule:true,moduleResolution:"node"};
        if (Object.entries(fixed).some(([k,v])=>value.compilerOptions?.[k] !== undefined && value.compilerOptions[k] !== v)) fail("unsupported TypeScript transform config");
      }
    }
    if (dir === REPO_ROOT || path.dirname(dir) === dir) break;
    dir=path.dirname(dir);
  }
}

/** Closed ordinary JS/TS module graph. This rejects unsupported loading; it is NOT an OS sandbox.
 * Files map to their exact base64 bytes. Type-only syntax is erased before runtime and is ignored.
 * Policies may use the sole pod-deliverable virtual import; guardedExecutionConfig binds its target.
 */
export function validateDependencyGraph(root: string, files: Record<string,string>, kind: Kind): void {
  root=path.resolve(root);
  const included=new Set(Object.keys(files).map(file=>path.resolve(root,file)));
  for (const [file,base64] of Object.entries(files)) {
    // JSON files can control native CommonJS directory resolution even with no JS in that directory.
    const importer=path.resolve(root,file);
    resolutionConfig(importer);
    if (!/\.[cm]?[jt]sx?$/.test(file)) {
      if (!/\.(json|md|txt)$/.test(file)) fail("only JS/TS and JSON/text evidence are supported");
      continue;
    }
    const source=ts.createSourceFile(file,Buffer.from(base64,"base64").toString("utf8"),ts.ScriptTarget.Latest,true);
    if ((source as any).parseDiagnostics.length) fail("invalid JS/TS source");
    function check(specifier: ts.Expression | undefined) {
      if (!specifier || !ts.isStringLiteralLike(specifier)) fail("import must name a fixed literal module");
      const name=specifier.text;
      if (name === "pod-deliverable" && kind === "policy") return;
      if (name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.includes("?") || name.includes("#")) fail("outside/aliased module import");
      if (!name.startsWith(".")) return checkBare(name,importer,kind);
      const target=path.resolve(path.dirname(importer),name);
      if (!inside(root,target)) fail("import outside hashed bundle");
      const candidates=[target,...runtimeExtensions.flatMap(ext=>[target+ext,path.join(target,"index"+ext)])];
      if (target.endsWith(".js")) candidates.push(target.slice(0,-3)+".ts");
      // Every existing alternative must be hashed, not merely one convenient matching file.
      const existing=candidates.filter(p=>fs.existsSync(p) && fs.statSync(p).isFile());
      if (!existing.length || existing.some(p=>!included.has(p))) fail("import outside or missing from hashed source");
      existing.forEach(assertNoSymlinkPath);
    }
    function visit(node: ts.Node): void {
      if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
      if (ts.isImportDeclaration(node)) {
        const clause=node.importClause;
        if (clause?.isTypeOnly || (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length>0 && clause.namedBindings.elements.every(e=>e.isTypeOnly))) return;
        check(node.moduleSpecifier);return;
      }
      if (ts.isExportDeclaration(node)) {
        if (node.isTypeOnly || (node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length>0 && node.exportClause.elements.every(e=>e.isTypeOnly))) return;
        if (node.moduleSpecifier) check(node.moduleSpecifier);return;
      }
      if (ts.isImportEqualsDeclaration(node)) {
        if (!node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) check(node.moduleReference.expression);
        return;
      }
      if (ts.isMetaProperty(node)) fail("runtime import metadata loading is unsupported");
      if (ts.isIdentifier(node) && ["eval","Function","global","globalThis","createRequire","Deno","Bun","WebAssembly"].includes(node.text)) fail("runtime code loading is unsupported");
      if (ts.isIdentifier(node) && node.text === "require") {
        if (!ts.isCallExpression(node.parent) || node.parent.expression !== node || node.parent.arguments.length !== 1) fail("aliased/runtime require is unsupported");
      }
      if (ts.isIdentifier(node) && node.text === "module") {
        if (!ts.isPropertyAccessExpression(node.parent) || node.parent.expression !== node || node.parent.name.text !== "exports") fail("runtime module loading is unsupported");
      }
      if (ts.isIdentifier(node) && node.text === "process") {
        if (!ts.isPropertyAccessExpression(node.parent) || node.parent.expression !== node || node.parent.name.text !== "env") fail("runtime process access is unsupported");
      }
      if (ts.isPropertyAccessExpression(node) && ["constructor","__proto__"].includes(node.name.text)) fail("reflective runtime loading is unsupported");
      if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression) && ["constructor","__proto__","require"].includes(node.argumentExpression.text)) fail("reflective runtime loading is unsupported");
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        if (node.arguments.length !== 1) fail("unsupported runtime import options");
        check(node.arguments[0]);
      }
      ts.forEachChild(node,visit);
    }
    visit(source);
  }
}

/** Wrap only the approved config; candidate configs/plugins are never loaded. Check actual Vite
 * resolutions as well as the static graph, including conditional exports and directory resolution.
 */
export function guardedExecutionConfig(config: any, candidate: string, policy: string, sourceFiles: string[], policyFiles: string[]): any {
  const allowed=new Set([...sourceFiles.map(f=>path.resolve(candidate,f)),...policyFiles.map(f=>path.resolve(policy,f))]);
  if (!config || typeof config !== "object" || Object.keys(config).some(k=>!["resolve","test"].includes(k))) fail("unsupported policy config");
  const resolve=config.resolve ?? {};
  if (Object.keys(resolve).some(k=>k!=="alias")) fail("unsupported resolution config");
  const aliases=resolve.alias ?? {};
  if (Array.isArray(aliases) || Object.keys(aliases).some(k=>k!=="pod-deliverable") || (aliases["pod-deliverable"] && !sourceFiles.some(f=>path.resolve(candidate,f)===path.resolve(aliases["pod-deliverable"])))) fail("unapproved policy alias");
  const test=config.test ?? {};
  const testKeys=["root","include","testTimeout","hookTimeout","pool","maxWorkers","minWorkers"];
  if (Object.keys(test).some(k=>!testKeys.includes(k)) || path.resolve(test.root ?? policy)!==path.resolve(policy) || !Array.isArray(test.include) || test.include.some((p:unknown)=>typeof p!=="string" || p.includes("..") || path.isAbsolute(p))) fail("unsupported policy test configuration");
  return {...config, plugins:[{
    name:"pod-closed-dependencies",enforce:"pre",
    async resolveId(this:any,id:string,importer?:string) {
      if (!importer || !allowed.has(path.resolve(importer.split("?")[0]))) return null;
      const plain=id.replace(/^node:/,"");
      if (builtins.has(plain) || (["fs","fs/promises"].includes(plain) && inside(policy,importer))) return null;
      const resolved=await this.resolve(id,importer,{skipSelf:true});
      if (!resolved) fail("unresolved execution import");
      const target=resolved.id.split("?")[0];
      if (!allowed.has(path.resolve(target))) lockedPackage(target);
      return resolved;
    },
  }]};
}
