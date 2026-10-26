import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { DISPATCH_QUEUE_NAME } from "../dispatch-queue/index.js";

// Source checks for @irs/worker (addendum §3.2 rule 4 and 6d; Task 012A
// record §8 A1 2a-2d; 012A-3 prompt step 3b-3c). A small lexer separates
// code from comments and strings, so the rules see identifiers, string
// values and argument lists. The words the rules look for are assembled at
// run time, so that this file does not trip its own rules.

// ---- lexer ----------------------------------------------------------------

export type TokenKind = "identifier" | "string" | "template" | "number" | "regex" | "punctuator";

export interface Token {
  readonly kind: TokenKind;
  readonly value: string;
  readonly line: number;
}

const IDENTIFIER_START = /[A-Za-z_$À-￿]/;
const IDENTIFIER_PART = /[A-Za-z0-9_$À-￿]/;
const REGEX_AFTER_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await",
]);

function regexAllowedAfter(previous: Token | undefined): boolean {
  if (previous === undefined) return true;
  if (previous.kind === "identifier") return REGEX_AFTER_KEYWORDS.has(previous.value);
  if (previous.kind === "punctuator") return ![")", "]", "}"].includes(previous.value);
  return false;
}

/** Tokens of a TypeScript or JavaScript source; comments and whitespace are dropped. */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const braces: ("brace" | "template")[] = [];
  let i = 0;
  let line = 1;

  const push = (kind: TokenKind, value: string, at: number) => tokens.push({ kind, value, line: at });

  // Reads template text from i (just after a backtick or a closing brace of a
  // substitution) up to the closing backtick or the next substitution.
  const readTemplateText = () => {
    const start = line;
    let value = "";
    while (i < text.length) {
      const c = text[i];
      if (c === "\\") {
        value += text[i + 1] ?? "";
        if (text[i + 1] === "\n") line++;
        i += 2;
      } else if (c === "`") {
        i++;
        push("template", value, start);
        return;
      } else if (c === "$" && text[i + 1] === "{") {
        i += 2;
        braces.push("template");
        push("template", value, start);
        return;
      } else {
        if (c === "\n") line++;
        value += c;
        i++;
      }
    }
    push("template", value, start);
  };

  while (i < text.length) {
    const c = text[i] ?? "";
    const next = text[i + 1];
    if (c === "\n") {
      line++;
      i++;
    } else if (/\s/.test(c)) {
      i++;
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n") line++;
        i++;
      }
      i += 2;
    } else if (c === '"' || c === "'") {
      const start = line;
      let value = "";
      i++;
      while (i < text.length && text[i] !== c && text[i] !== "\n") {
        if (text[i] === "\\") {
          value += text[i + 1] ?? "";
          i += 2;
        } else {
          value += text[i];
          i++;
        }
      }
      i++;
      push("string", value, start);
    } else if (c === "`") {
      i++;
      readTemplateText();
    } else if (c === "}" && braces[braces.length - 1] === "template") {
      braces.pop();
      i++;
      readTemplateText();
    } else if (IDENTIFIER_START.test(c)) {
      let value = "";
      while (i < text.length && IDENTIFIER_PART.test(text[i] ?? "")) {
        value += text[i];
        i++;
      }
      push("identifier", value, line);
    } else if (/[0-9]/.test(c)) {
      let value = "";
      while (i < text.length && /[0-9A-Za-z_.]/.test(text[i] ?? "")) {
        value += text[i];
        i++;
      }
      push("number", value, line);
    } else if (c === "/" && regexAllowedAfter(tokens[tokens.length - 1])) {
      let value = "/";
      let inClass = false;
      i++;
      while (i < text.length && text[i] !== "\n") {
        const r = text[i];
        value += r;
        i++;
        if (r === "\\") {
          value += text[i] ?? "";
          i++;
        } else if (r === "[") {
          inClass = true;
        } else if (r === "]") {
          inClass = false;
        } else if (r === "/" && !inClass) {
          break;
        }
      }
      while (i < text.length && /[a-z]/.test(text[i] ?? "")) {
        value += text[i];
        i++;
      }
      push("regex", value, line);
    } else if (text.startsWith("...", i)) {
      push("punctuator", "...", line);
      i += 3;
    } else if (c === "=" && next === ">") {
      push("punctuator", "=>", line);
      i += 2;
    } else {
      if (c === "{") braces.push("brace");
      if (c === "}") braces.pop();
      push("punctuator", c, line);
      i++;
    }
  }
  return tokens;
}

// ---- rules ----------------------------------------------------------------

export interface Violation {
  readonly rule: string;
  readonly file: string;
  readonly line: number;
}

export interface Construction {
  readonly file: string;
  readonly className: string;
  readonly argumentCount: number;
}

export interface LibraryImport {
  readonly file: string;
  readonly valueNames: readonly string[];
  readonly typeNames: readonly string[];
}

export interface FileScan {
  readonly violations: readonly Violation[];
  readonly constructions: readonly Construction[];
  readonly libraryImports: readonly LibraryImport[];
}

/** The queue library's package name. */
export const LIBRARY = ["bull", "mq"].join("");
/** The central module's directory, relative to the package root. */
export const MODULE_DIRECTORY = "src/dispatch-queue/";
export const MODULE_ENTRY = "src/dispatch-queue/index";

/** Value imports the central module may take from the library (record A1 2a). */
export const VALUE_ALLOWLIST: readonly string[] = ["Queue", "Worker"];
/** Type-only imports the central module may take from the library. */
export const TYPE_ALLOWLIST: readonly string[] = ["JobsOptions", "QueueOptions", "WorkerOptions"];
/**
 * Maximum constructor arguments per allowlisted class (record A1 2c): no
 * argument after the options argument. Adding a class to the allowlist
 * requires its row here and its planted-violation control.
 */
export const MAX_CONSTRUCTOR_ARGUMENTS: Readonly<Record<string, number>> = Object.freeze({ Queue: 2, Worker: 3 });

const FAMILY_WORD = new RegExp(["re", "lay"].join(""), "i");
const SELECTOR_WORD = new RegExp(["back", "end"].join(""), "i");
const SELECTOR_KEY = new RegExp(`^${["back", "end"].join("")}(factory)?$`, "i");
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const SPECIFIER_EXTENSION = /\.(d\.ts|ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

function isLibrarySpecifier(value: string): boolean {
  return value === LIBRARY || value.startsWith(`${LIBRARY}/`);
}

function isSpecifierToken(token: Token | undefined): token is Token {
  return token !== undefined && (token.kind === "string" || token.kind === "template");
}

function isPunctuator(token: Token | undefined, value: string): boolean {
  return token !== undefined && token.kind === "punctuator" && token.value === value;
}

function isIdentifier(token: Token | undefined, value?: string): boolean {
  return token !== undefined && token.kind === "identifier" && (value === undefined || token.value === value);
}

/** Index of the punctuator closing the bracket opened at `open`, or -1. */
function closingIndex(tokens: readonly Token[], open: number): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">" };
  const opener = tokens[open]?.value ?? "";
  const closer = pairs[opener];
  let depth = 0;
  for (let k = open; k < tokens.length; k++) {
    const token = tokens[k];
    if (token?.kind !== "punctuator") continue;
    if (token.value === opener) depth++;
    if (token.value === closer) depth--;
    if (depth === 0) return k;
  }
  return -1;
}

interface ImportStatement {
  /** Index of the specifier token. */
  readonly specifier: number;
  /** Token indexes of the clause between `import` and `from`. */
  readonly clauseStart: number;
  readonly clauseEnd: number;
  readonly kind: "static" | "side-effect" | "dynamic" | "require" | "re-export";
}

/** Every module-specifier position: static, side-effect and dynamic imports, require, re-exports. */
function importStatements(tokens: readonly Token[]): ImportStatement[] {
  const found: ImportStatement[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k];
    if (token === undefined || token.kind !== "identifier" || isPunctuator(tokens[k - 1], ".")) continue;
    if (token.value === "import") {
      if (isPunctuator(tokens[k + 1], "(")) {
        if (isSpecifierToken(tokens[k + 2])) found.push({ specifier: k + 2, clauseStart: k + 1, clauseEnd: k + 1, kind: "dynamic" });
        continue;
      }
      if (isPunctuator(tokens[k + 1], ".")) continue;
      if (isSpecifierToken(tokens[k + 1])) {
        found.push({ specifier: k + 1, clauseStart: k + 1, clauseEnd: k + 1, kind: "side-effect" });
        continue;
      }
      for (let j = k + 1; j < tokens.length && j < k + 400; j++) {
        if (isPunctuator(tokens[j], ";")) break;
        if (isSpecifierToken(tokens[j])) {
          const viaFrom = isIdentifier(tokens[j - 1], "from");
          found.push({ specifier: j, clauseStart: k + 1, clauseEnd: viaFrom ? j - 1 : j, kind: viaFrom ? "static" : "require" });
          break;
        }
      }
    } else if (token.value === "export") {
      let j = k + 1;
      if (isIdentifier(tokens[j], "type")) j++;
      if (isPunctuator(tokens[j], "{")) {
        j = closingIndex(tokens, j) + 1;
      } else if (isPunctuator(tokens[j], "*")) {
        j++;
        if (isIdentifier(tokens[j], "as")) j += 2;
      } else {
        continue;
      }
      if (j > 0 && isIdentifier(tokens[j], "from") && isSpecifierToken(tokens[j + 1])) {
        found.push({ specifier: j + 1, clauseStart: k + 1, clauseEnd: j, kind: "re-export" });
      }
    } else if (token.value === "require" || token.value === "resolve") {
      if (isPunctuator(tokens[k + 1], "(") && isSpecifierToken(tokens[k + 2])) {
        found.push({ specifier: k + 2, clauseStart: k + 1, clauseEnd: k + 1, kind: "require" });
      }
    }
  }
  return found;
}

/** Package-relative path of a relative specifier, without extension; undefined for a bare one. */
function resolveSpecifier(file: string, specifier: string): string | undefined {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined;
  return posix.normalize(posix.join(posix.dirname(file), specifier)).replace(SPECIFIER_EXTENSION, "");
}

/** Checks the clause of a static library import in the central module. */
function checkLibraryClause(
  tokens: readonly Token[],
  statement: ImportStatement,
  report: (rule: string, line: number) => void,
): LibraryImport | undefined {
  const line = tokens[statement.specifier]?.line ?? 0;
  const clause = tokens.slice(statement.clauseStart, statement.clauseEnd);
  let start = 0;
  let typeOnly = false;
  if (isIdentifier(clause[0], "type")) {
    typeOnly = true;
    start = 1;
  }
  if (clause.some((token) => isPunctuator(token, "*"))) {
    report("library-namespace-import", line);
    return undefined;
  }
  if (!isPunctuator(clause[start], "{") || !isPunctuator(clause[clause.length - 1], "}")) {
    report(clause.length === 0 ? "library-side-effect-import" : isIdentifier(clause[start]) ? "library-default-import" : "library-import-form", line);
    return undefined;
  }
  const valueNames: string[] = [];
  const typeNames: string[] = [];
  const inner = clause.slice(start + 1, clause.length - 1);
  let specifier: Token[] = [];
  const flush = () => {
    if (specifier.length === 0) return;
    let parts = specifier;
    let isType = typeOnly;
    if (parts.length > 1 && isIdentifier(parts[0], "type")) {
      isType = true;
      parts = parts.slice(1);
    }
    const name = parts[0];
    if (parts.length !== 1 || name === undefined || name.kind !== "identifier") {
      report("library-import-alias", line);
    } else if (isType) {
      typeNames.push(name.value);
      if (!TYPE_ALLOWLIST.includes(name.value)) report("library-type-not-allowed", line);
    } else {
      valueNames.push(name.value);
      if (!VALUE_ALLOWLIST.includes(name.value)) report("library-value-not-allowed", line);
    }
    specifier = [];
  };
  for (const token of inner) {
    if (isPunctuator(token, ",")) flush();
    else specifier.push(token);
  }
  flush();
  return { file: "", valueNames, typeNames };
}

/**
 * Scans one source file. `file` is its path relative to the @irs/worker
 * package root, with forward slashes.
 */
export function scanSource(file: string, text: string): FileScan {
  const violations: Violation[] = [];
  const constructions: Construction[] = [];
  const libraryImports: LibraryImport[] = [];
  const report = (rule: string, line: number) => violations.push({ rule, file, line });
  const inModule = file.startsWith(MODULE_DIRECTORY);
  const tokens = tokenize(text);

  // Library imports: outside the module, any reference at all; inside, only
  // allowlisted named imports in a plain static import statement.
  const statements = importStatements(tokens);
  const accepted = new Set<number>();
  const allowedClassTokens = new Set<number>();
  for (const statement of statements) {
    const token = tokens[statement.specifier];
    if (token === undefined) continue;
    if (isLibrarySpecifier(token.value) && inModule) {
      if (token.value !== LIBRARY) {
        report("library-subpath-import", token.line);
      } else if (statement.kind === "static") {
        const record = checkLibraryClause(tokens, statement, report);
        if (record !== undefined) libraryImports.push({ ...record, file });
        for (let k = statement.clauseStart; k < statement.clauseEnd; k++) allowedClassTokens.add(k);
      } else {
        report(`library-${statement.kind}`, token.line);
      }
      accepted.add(statement.specifier);
    }
    // Code outside the module imports only the module's public entry.
    const target = resolveSpecifier(file, token.value);
    if (!inModule && target !== undefined) {
      const intoModule = `${target}/`.startsWith(MODULE_DIRECTORY);
      if ((intoModule && target !== MODULE_ENTRY) || target === "dist" || target.startsWith("dist/")) {
        report("module-internal-import", token.line);
      }
    }
  }
  tokens.forEach((token, k) => {
    if ((token.kind === "string" || token.kind === "template") && isLibrarySpecifier(token.value) && !accepted.has(k)) {
      report(inModule ? "library-other-reference" : "library-outside-module", token.line);
    }
  });

  tokens.forEach((token, k) => {
    if (token.kind === "identifier") {
      if (FAMILY_WORD.test(token.value)) report("relay-symbol", token.line);
      if (SELECTOR_WORD.test(token.value)) report("backend-identifier", token.line);
    } else if ((token.kind === "string" || token.kind === "template") && SELECTOR_KEY.test(token.value)) {
      report("backend-key", token.line);
    }

    // Constructions of the allowlisted classes, from the table.
    if (!isIdentifier(token, "new")) return;
    let j = k + 1;
    while (isIdentifier(tokens[j]) && isPunctuator(tokens[j + 1], ".")) j += 2;
    const name = tokens[j];
    if (name === undefined || name.kind !== "identifier") return;
    const maximum = MAX_CONSTRUCTOR_ARGUMENTS[name.value];
    if (maximum === undefined) return;
    allowedClassTokens.add(j);
    let open = j + 1;
    if (isPunctuator(tokens[open], "<")) open = closingIndex(tokens, open) + 1;
    if (open === 0 || !isPunctuator(tokens[open], "(")) {
      report("constructor-form", name.line);
      return;
    }
    const close = closingIndex(tokens, open);
    if (close === -1) {
      report("constructor-form", name.line);
      return;
    }
    let argumentCount = close > open + 1 ? 1 : 0;
    let depth = 0;
    for (let a = open + 1; a < close; a++) {
      const inner = tokens[a];
      if (inner?.kind !== "punctuator") continue;
      if (["(", "[", "{"].includes(inner.value)) depth++;
      else if ([")", "]", "}"].includes(inner.value)) depth--;
      else if (depth === 0 && inner.value === "," && a < close - 1) argumentCount++;
      else if (depth === 0 && inner.value === "...") report("constructor-spread", inner.line);
    }
    constructions.push({ file, className: name.value, argumentCount });
    if (argumentCount > maximum) report(`${name.value.toLowerCase()}-argument-count`, name.line);
  });

  // Inside the module the classes appear only in their import and in `new`,
  // so a construction cannot be hidden behind another name.
  if (inModule) {
    tokens.forEach((token, k) => {
      if (token.kind === "identifier" && VALUE_ALLOWLIST.includes(token.value) && !allowedClassTokens.has(k)) {
        report("class-alias", token.line);
      }
    });
  }

  // The fixed queue name is written only in the module.
  if (!inModule && text.includes(DISPATCH_QUEUE_NAME)) {
    const line = text.slice(0, text.indexOf(DISPATCH_QUEUE_NAME)).split("\n").length;
    report("queue-name-literal", line);
  }

  return { violations, constructions, libraryImports };
}

export interface PackageScan extends FileScan {
  /** Every scanned file, relative to the package root. */
  readonly files: readonly string[];
}

/**
 * Lists every source file under `root` from the file system (so tracked and
 * untracked files alike), skipping dist and node_modules. A symbolic link is
 * not followed; it is reported, so nothing escapes the scan.
 */
export function listSourceFiles(root: string): { files: string[]; links: string[] } {
  const files: string[] = [];
  const links: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relativePath = relative(root, path).split(sep).join("/");
      if (entry.isSymbolicLink()) {
        links.push(relativePath);
      } else if (entry.isDirectory()) {
        if (entry.name !== "dist" && entry.name !== "node_modules") walk(path);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
        files.push(relativePath);
      }
    }
  };
  walk(root);
  return { files: files.sort(), links: links.sort() };
}

export function scanPackage(root: string): PackageScan {
  const { files, links } = listSourceFiles(root);
  const violations: Violation[] = links.map((file) => ({ rule: "unscanned-link", file, line: 0 }));
  const constructions: Construction[] = [];
  const libraryImports: LibraryImport[] = [];
  for (const file of files) {
    const scan = scanSource(file, readFileSync(join(root, file), "utf8"));
    violations.push(...scan.violations);
    constructions.push(...scan.constructions);
    libraryImports.push(...scan.libraryImports);
  }
  return { files, violations, constructions, libraryImports };
}

// ---- declaration surface --------------------------------------------------

export interface DeclarationScan {
  readonly files: readonly string[];
  readonly violations: readonly Violation[];
}

const FORBIDDEN_PACKAGES = [LIBRARY, ["io", "redis"].join("")];
const FORBIDDEN_REFERENCE = new RegExp(`^(${FORBIDDEN_PACKAGES.join("|")})(/|$)`, "i");
const FORBIDDEN_WORD = new RegExp(`^(${FORBIDDEN_PACKAGES.join("|")})$`, "i");
const TRIPLE_SLASH_REFERENCE = new RegExp(`^\\s*///\\s*<reference\\b.*\\b(${FORBIDDEN_PACKAGES.join("|")})\\b`, "im");

/**
 * Follows every relative import and re-export from a declaration file and
 * reports any import of, or reference to, the queue library or the Redis
 * client in any file reached. An unresolved relative reference is reported too.
 */
export function checkDeclarationSurface(entry: string): DeclarationScan {
  const files: string[] = [];
  const violations: Violation[] = [];
  const pending = [entry];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const path = pending.shift();
    if (path === undefined || seen.has(path)) continue;
    seen.add(path);
    const file = relative(dirname(entry), path).split(sep).join("/");
    files.push(file);
    if (!existsSync(path)) {
      violations.push({ rule: "declaration-unresolved", file, line: 0 });
      continue;
    }
    const text = readFileSync(path, "utf8");
    if (TRIPLE_SLASH_REFERENCE.test(text)) violations.push({ rule: "declaration-reference-directive", file, line: 0 });
    const tokens = tokenize(text);
    for (const token of tokens) {
      if ((token.kind === "string" || token.kind === "template") && FORBIDDEN_REFERENCE.test(token.value)) {
        violations.push({ rule: "declaration-package-reference", file, line: token.line });
      } else if (token.kind === "identifier" && FORBIDDEN_WORD.test(token.value)) {
        violations.push({ rule: "declaration-package-name", file, line: token.line });
      }
    }
    for (const statement of importStatements(tokens)) {
      const specifier = tokens[statement.specifier]?.value ?? "";
      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        pending.push(join(dirname(path), specifier.replace(/\.js$/, "").replace(/\.d\.ts$/, "") + ".d.ts"));
      }
    }
  }
  return { files, violations };
}
