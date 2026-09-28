"use strict";

/**
 * AfterPull core - given two commits of one repository (the HEAD before and after a pull,
 * merge, checkout or rebase), works out the "after pull" chores: reinstall dependencies,
 * apply new migrations, add new .env keys, rebuild containers, switch toolchains, update
 * submodules, run terraform init, plus user-defined rules. No dependency on the VS Code API,
 * so the same code runs in the editor and in the plain Node tests.
 *
 * Every git call goes through runGit(), which is hardened:
 *   - child_process.execFile with an argument array (no shell string is ever built)
 *   - GIT_CONFIG_GLOBAL / GIT_CONFIG_SYSTEM point at the null device, GIT_CONFIG_NOSYSTEM=1,
 *     GIT_OPTIONAL_LOCKS=0, GIT_TERMINAL_PROMPT=0, inherited GIT_DIR / GIT_WORK_TREE /
 *     GIT_EXTERNAL_DIFF / GIT_PAGER and similar variables are removed
 *   - leading args `-c core.fsmonitor=` (a repo-local fsmonitor hook can never run),
 *     `-c core.quotePath=true` and `--no-pager`
 *   - diff and show add --no-ext-diff --no-textconv --no-color (and --no-renames,
 *     --no-relative, --ignore-submodules=none for diff), so repo-local diff.* settings
 *     cannot run programs or change the output format
 *   - commits are only ever passed as validated full hex object names, paths after `--`
 *   - output is capped and every call has a timeout
 *
 * No network access of any kind. Nothing here runs a package manager; it only describes the
 * commands. The editor side shows them and starts them as visible tasks after a click.
 */

const { execFile } = require("child_process");
const path = require("path");

const posix = path.posix;
const NULL_DEVICE = process.platform === "win32" ? "\\\\.\\NUL" : "/dev/null";
const MAX_DIFF_BYTES = 16 * 1024 * 1024;
const MAX_SHOW_BYTES = 1024 * 1024;
const MAX_ENTRIES = 50000;
const MAX_CHORES = 200;
const MAX_CONTENT_READS = 400;

// ---------------------------------------------------------------------------------------
// Chore catalogue
// ---------------------------------------------------------------------------------------

const CHORES = {
  AP001: "Reinstall JavaScript dependencies",
  AP002: "Reinstall Python dependencies",
  AP003: "Download Go modules",
  AP004: "Fetch Rust crates",
  AP005: "Install Ruby gems",
  AP006: "Install PHP packages",
  AP007: "Apply new database migrations",
  AP008: "Add new .env keys",
  AP009: "Rebuild containers",
  AP010: "Toolchain version changed",
  AP011: "Update submodules",
  AP012: "Run terraform init",
  AP013: "Custom rule",
};

/** Built-in commands per tool: [executable, ...args]. */
const TOOL_COMMANDS = {
  npm: ["npm", "ci"],
  npmInstall: ["npm", "install"],
  yarn: ["yarn", "install", "--frozen-lockfile"],
  yarnBerry: ["yarn", "install", "--immutable"],
  pnpm: ["pnpm", "install", "--frozen-lockfile"],
  bun: ["bun", "install"],
  poetry: ["poetry", "install"],
  uv: ["uv", "sync"],
  pip: ["pip", "install"],
  pipenv: ["pipenv", "sync"],
  go: ["go", "mod", "download"],
  cargo: ["cargo", "fetch"],
  bundler: ["bundle", "install"],
  composer: ["composer", "install"],
  django: ["python", "manage.py", "migrate"],
  alembic: ["alembic", "upgrade", "head"],
  prisma: ["npx", "prisma", "migrate", "dev"],
  rails: ["bin/rails", "db:migrate"],
  knex: ["npx", "knex", "migrate:latest"],
  flyway: ["mvn", "flyway:migrate"],
  flywayGradle: ["gradle", "flywayMigrate"],
  docker: ["docker", "compose", "up", "-d", "--build"],
  dockerBuild: ["docker", "build"],
  submodules: ["git", "submodule", "update", "--init", "--recursive"],
  terraform: ["terraform", "init"],
};

// Override keys: the user-facing tool name for a tool (yarnBerry is still "yarn").
const OVERRIDE_KEY = { yarnBerry: "yarn", npmInstall: "npm", flywayGradle: "flyway" };

const JS_LOCKS = ["pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock", "package-lock.json", "npm-shrinkwrap.json"];
const JS_LOCK_TOOL = {
  "pnpm-lock.yaml": "pnpm", "yarn.lock": "yarn", "bun.lockb": "bun", "bun.lock": "bun",
  "package-lock.json": "npm", "npm-shrinkwrap.json": "npm",
};
const JS_DEP_SECTIONS = [
  "dependencies", "devDependencies", "optionalDependencies", "peerDependencies",
  "bundleDependencies", "bundledDependencies", "overrides", "resolutions", "pnpm",
  "workspaces", "packageManager",
];
const PY_LOCKS = { "poetry.lock": "poetry", "uv.lock": "uv", "Pipfile.lock": "pipenv" };
const SIMPLE_LOCKS = {
  "go.mod": ["AP003", "go"], "go.sum": ["AP003", "go"], "Cargo.lock": ["AP004", "cargo"],
  "Gemfile.lock": ["AP005", "bundler"], "composer.lock": ["AP006", "composer"],
};
const ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template"]);
const TOOLCHAIN_FILES = new Set([
  ".nvmrc", ".node-version", ".python-version", ".ruby-version", ".go-version",
  ".terraform-version", ".tool-versions", "rust-toolchain", "rust-toolchain.toml",
]);
const COMPOSE_DEFAULTS = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
const COMPOSE_AUTO = new Set(COMPOSE_DEFAULTS.concat(["compose.override.yaml", "compose.override.yml", "docker-compose.override.yaml", "docker-compose.override.yml"]));
const SKIP_SEGMENTS = new Set(["node_modules", "bower_components", ".terraform", ".git"]);

// ---------------------------------------------------------------------------------------
// Hardened git runner
// ---------------------------------------------------------------------------------------

function hardenedEnv() {
  const env = Object.assign({}, process.env, {
    GIT_CONFIG_GLOBAL: NULL_DEVICE,
    GIT_CONFIG_SYSTEM: NULL_DEVICE,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ATTR_NOSYSTEM: "1",
    LC_ALL: "C",
  });
  for (const k of [
    "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_EXTERNAL_DIFF", "GIT_PAGER", "PAGER",
    "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE",
    "GIT_COMMON_DIR", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
    "GIT_LITERAL_PATHSPECS", "GIT_GLOB_PATHSPECS", "GIT_ICASE_PATHSPECS",
  ]) {
    delete env[k];
  }
  return env;
}

const LEADING_ARGS = ["-c", "core.fsmonitor=", "-c", "core.quotePath=true", "--no-pager"];

/**
 * Run git hardened. Never throws; resolves to { ok, code, stdout: Buffer, stderr }.
 * @param {string} gitPath
 * @param {string} cwd
 * @param {string[]} args
 * @param {{maxBytes?: number, timeout?: number}} [opts]
 */
function runGit(gitPath, cwd, args, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    try {
      execFile(
        gitPath || "git",
        LEADING_ARGS.concat(args),
        {
          cwd,
          env: hardenedEnv(),
          encoding: "buffer",
          maxBuffer: o.maxBytes || MAX_SHOW_BYTES,
          timeout: o.timeout || 15000,
          windowsHide: true,
        },
        (err, stdout, stderr) => {
          resolve({
            ok: !err,
            code: err ? (typeof err.code === "number" ? err.code : -1) : 0,
            stdout: stdout || Buffer.alloc(0),
            stderr: String(stderr || (err && err.message) || "").slice(0, 4096),
          });
        }
      );
    } catch (e) {
      resolve({ ok: false, code: -1, stdout: Buffer.alloc(0), stderr: String(e) });
    }
  });
}

/** A full object name: 40 hex (SHA-1) or 64 hex (SHA-256 repositories). */
function isSha(s) {
  return typeof s === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(s);
}

// ---------------------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------------------

/** True if a repo-relative git path is a plain relative path with no escape tricks. */
function isSafeRelPath(rel) {
  if (typeof rel !== "string" || rel === "" || rel.length > 4096) return false;
  if (/[\u0000-\u001f\u007f]/.test(rel)) return false;
  if (rel.startsWith("/") || /^[A-Za-z]:/.test(rel) || rel.includes("\\")) return false;
  return !rel.split("/").some((seg) => seg === ".." || seg === "." || seg === "" || seg.toLowerCase() === ".git");
}

function dirOf(rel) {
  const d = posix.dirname(rel);
  return d === "." ? "" : d;
}

function joinRel(dir, name) {
  return dir ? dir + "/" + name : name;
}

/** Directories from `dir` up to the repository root ("" last). */
function ancestors(dir) {
  const out = [];
  let d = dir;
  for (;;) {
    out.push(d);
    if (!d) break;
    d = dirOf(d);
  }
  return out;
}

/** The prefix before a marker segment sequence, e.g. prefixBefore("a/db/migrate/x.rb", "db/migrate/") === "a". */
function prefixBefore(rel, marker) {
  const withSlash = "/" + rel;
  const idx = withSlash.lastIndexOf("/" + marker);
  if (idx < 0) return null;
  const pre = withSlash.slice(1, idx + 1).replace(/\/$/, "");
  return pre;
}

/** Show control characters in a path as escapes, for display only. */
function displayPath(p) {
  return String(p).replace(/[\u0000-\u001f\u007f]/g, (ch) => {
    const map = { "\n": "\\n", "\t": "\\t", "\r": "\\r" };
    return map[ch] || "\\x" + ch.charCodeAt(0).toString(16).padStart(2, "0");
  });
}

/** Quote one argument for display (the task itself receives the argument unmodified). */
function quoteArg(a) {
  const s = String(a);
  if (/^[\w@%+=:,./-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ---------------------------------------------------------------------------------------
// Globs and configuration
// ---------------------------------------------------------------------------------------

/** Convert a simple glob (**, *, ?, {a,b}) into a RegExp matching repo-relative posix paths. */
function globToRegExp(glob) {
  let g = String(glob == null ? "" : glob).trim().replace(/\\/g, "/");
  if (!g) return null;
  const anchored = g.startsWith("/");
  if (anchored) g = g.slice(1);
  if (g.endsWith("/")) g += "**";
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        i++;
        if (g[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      const close = g.indexOf("}", i);
      if (close === -1) {
        re += "\\{";
      } else {
        re += "(?:" + g.slice(i + 1, close).split(",").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")";
        i = close;
      }
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    }
  }
  const hasSlash = g.includes("/");
  const prefix = anchored || hasSlash ? "^" : "^(?:.*/)?";
  return new RegExp(prefix + re + "$");
}

function normalizeConfig(cfg) {
  const c = cfg || {};
  const disabled = new Set((Array.isArray(c.disabledChores) ? c.disabledChores : []).map((x) => String(x).toUpperCase()));
  const ignore = (Array.isArray(c.ignore) ? c.ignore : []).map(globToRegExp).filter(Boolean);
  const commands = {};
  if (c.commands && typeof c.commands === "object" && !Array.isArray(c.commands)) {
    for (const [k, v] of Object.entries(c.commands)) {
      if (typeof v === "string" && v.trim()) commands[k] = v.trim();
    }
  }
  const rules = [];
  (Array.isArray(c.rules) ? c.rules : []).forEach((r, index) => {
    if (!r || typeof r !== "object") return;
    if (typeof r.command !== "string" || !r.command.trim()) return;
    const re = globToRegExp(r.glob);
    if (!re) return;
    rules.push({
      index,
      re,
      glob: String(r.glob),
      command: r.command.trim(),
      label: typeof r.label === "string" && r.label.trim() ? r.label.trim() : "Run " + r.command.trim(),
      cwd: r.cwd === "file" ? "file" : "root",
      when: r.when === "added" ? "added" : "changed",
    });
  });
  return { disabled, ignore, commands, rules };
}

// ---------------------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------------------

/**
 * Parse `git diff --raw -z --no-abbrev --no-renames`. Each record is
 * ":<oldmode> <newmode> <oldsha> <newsha> <status>\0<path>\0".
 * @param {Buffer} buf
 * @returns {{status: string, oldMode: string, newMode: string, path: string}[]}
 */
function parseRawDiff(buf) {
  const parts = buf.toString("utf8").split("\0");
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i];
    const p = parts[i + 1];
    const m = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(meta);
    if (!m) {
      // Resynchronise if the stream is not in the expected shape.
      continue;
    }
    out.push({ oldMode: m[1], newMode: m[2], status: m[3], path: p });
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

/**
 * Parse dotenv-style text into an ordered Map of key -> raw value (first occurrence wins).
 * Understands `KEY=value`, `export KEY=value`, bare `KEY`, comments, quoted values and
 * multi-line quoted values (whose value is reported as "").
 * @param {string} text
 */
function parseEnv(text) {
  const map = new Map();
  const lines = String(text || "").replace(/^﻿/, "").split(/\r?\n/);
  let open = null;
  for (const raw of lines) {
    if (open) {
      if (raw.includes(open)) open = null;
      continue;
    }
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*(?:=\s*(.*))?$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let value = m[2] === undefined ? "" : m[2];
    const q = value[0];
    if (q === '"' || q === "'" || q === "`") {
      const close = value.indexOf(q, 1);
      if (close === -1) {
        open = q;
        value = "";
      } else {
        value = value.slice(0, close + 1);
      }
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    value = value.replace(/[\u0000-\u001f\u007f]/g, "");
    if (!map.has(key)) map.set(key, value);
  }
  return map;
}

/** Keys (with template values) present in newText but not in oldText. */
function gainedEnvKeys(oldText, newText) {
  const before = parseEnv(oldText);
  const out = [];
  for (const [key, value] of parseEnv(newText)) {
    if (!before.has(key)) out.push({ key, value });
  }
  return out;
}

/** Of the given keys, the ones the local .env text does not define. */
function missingEnvKeys(envText, keys) {
  const have = parseEnv(envText);
  return (keys || []).filter((k) => !have.has(k.key));
}

/**
 * Text to append to a .env so it gains `missing` keys. Never touches existing lines.
 * @param {string} envText current content ("" for a new file)
 * @param {{key: string, value: string}[]} missing
 * @param {string} templateName shown in the comment line
 */
function buildEnvAppend(envText, missing, templateName) {
  if (!missing || missing.length === 0) return "";
  const text = String(envText || "");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let out = text && !text.endsWith("\n") ? eol : "";
  out += "# Added by AfterPull from " + String(templateName).replace(/[\u0000-\u001f\u007f]/g, "") + eol;
  for (const { key, value } of missing) out += key + "=" + value + eol;
  return out;
}

/** Stable JSON for comparisons (sorted object keys). */
function stableStringify(v) {
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
  }
  return JSON.stringify(v === undefined ? null : v);
}

/**
 * True when the dependency-related sections of two package.json texts differ. A change to
 * "scripts", "version", "description" and so on does not count. oldText null = new file.
 */
function packageDepsChanged(oldText, newText) {
  const parse = (t) => {
    if (t == null) return {};
    try {
      const v = JSON.parse(t);
      return v && typeof v === "object" && !Array.isArray(v) ? v : null;
    } catch (_) {
      return null;
    }
  };
  const a = parse(oldText);
  const b = parse(newText);
  if (a === null || b === null) return oldText !== newText; // unparsable: be conservative
  const pick = (o) => {
    const r = {};
    for (const s of JS_DEP_SECTIONS) {
      if (o[s] !== undefined && !(o[s] && typeof o[s] === "object" && !Array.isArray(o[s]) && Object.keys(o[s]).length === 0)) r[s] = o[s];
    }
    return r;
  };
  return stableStringify(pick(a)) !== stableStringify(pick(b));
}

function firstMeaningfulLine(text) {
  for (const raw of String(text || "").split(/\r?\n/)) {
    const l = raw.replace(/#.*$/, "").trim();
    if (l) return l.replace(/\s+/g, " ").slice(0, 80);
  }
  return "";
}

function rustChannel(text) {
  const m = /^\s*channel\s*=\s*["']([^"']+)["']/m.exec(String(text || ""));
  return m ? m[1] : firstMeaningfulLine(text);
}

function toolVersionsMap(text) {
  const m = new Map();
  for (const raw of String(text || "").split(/\r?\n/)) {
    const l = raw.replace(/#.*$/, "").trim();
    if (!l) continue;
    const [tool, ...versions] = l.split(/\s+/);
    if (!m.has(tool)) m.set(tool, versions.join(" ").slice(0, 60));
  }
  return m;
}

/**
 * Describe a toolchain version change, or null when the effective version is the same.
 * @param {string} name file basename
 * @param {string|null} oldText null when the file did not exist
 * @param {string|null} newText null when the file was removed
 */
function toolchainChange(name, oldText, newText) {
  if (name === ".tool-versions") {
    const a = toolVersionsMap(oldText);
    const b = toolVersionsMap(newText);
    const parts = [];
    for (const [tool, v] of b) {
      if (!a.has(tool)) parts.push(`${tool} (none) -> ${v}`);
      else if (a.get(tool) !== v) parts.push(`${tool} ${a.get(tool)} -> ${v}`);
    }
    for (const [tool, v] of a) if (!b.has(tool)) parts.push(`${tool} ${v} -> (removed)`);
    return parts.length ? parts.join(", ") : null;
  }
  const read = name.startsWith("rust-toolchain") ? rustChannel : firstMeaningfulLine;
  const a = oldText == null ? "(none)" : read(oldText) || "(empty)";
  const b = newText == null ? "(removed)" : read(newText) || "(empty)";
  return a === b ? null : `${a} -> ${b}`;
}

/**
 * The parts of a Terraform file that `terraform init` depends on: module source/version,
 * terraform.required_providers and terraform.backend / cloud blocks. Two files with the same
 * signature need no new init. Heuristic line parser, not a full HCL parser.
 */
function terraformInitSignature(text) {
  const stack = [];
  const rec = [];
  const lines = String(text || "").split(/\r?\n/);
  for (const raw of lines) {
    let line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    line = line.replace(/\s+(#|\/\/).*$/, "").replace(/\s+/g, " ");
    const open = /^([\w-]+)((?: "[^"]*")*) ?(=)? ?\{(.*)$/.exec(line);
    if (open) {
      const name = open[1] + (open[2] || "");
      const rest = open[4].trim();
      if (rest.endsWith("}")) {
        // Single-line object, e.g. aws = { source = "hashicorp/aws", version = "~> 5.0" }
        if (inInitScope(stack.concat(name))) rec.push(stack.concat(name).join(">") + " " + rest);
        continue;
      }
      stack.push(name);
      continue;
    }
    if (line === "}" || line.startsWith("}")) {
      stack.pop();
      continue;
    }
    if (!stack.length) continue;
    const top = stack[0];
    if (top.startsWith("module ") && stack.length === 1 && /^(source|version) ?=/.test(line)) {
      rec.push(stack.join(">") + " " + line);
    } else if (inInitScope(stack)) {
      rec.push(stack.join(">") + " " + line);
    }
  }
  return rec.sort().join("\n");
}

function inInitScope(stack) {
  if (!stack.length || stack[0] !== "terraform") return false;
  return stack.includes("required_providers") || /^(backend|cloud)\b/.test(stack[1] || "");
}

function terraformInitNeeded(oldText, newText) {
  return terraformInitSignature(oldText) !== terraformInitSignature(newText);
}

// ---------------------------------------------------------------------------------------
// Rule engine
// ---------------------------------------------------------------------------------------

/**
 * @typedef {{
 *   id: string, key: string, title: string, detail: string, cwd: string,
 *   kind: "task" | "env" | "info", tool: string,
 *   command?: { cmd?: string, args?: string[], line?: string }, commandText: string,
 *   files: string[], env?: { template: string, target: string, keys: {key: string, value: string}[] }
 * }} Chore
 */

class ChoreSet {
  constructor(cfg) {
    this.cfg = cfg;
    this.map = new Map();
  }

  /** Add or merge a chore. `tool` selects the built-in command unless overridden. */
  add(id, tool, cwd, file, detail, extra) {
    if (this.cfg.disabled.has(id)) return null;
    const x = extra || {};
    const override = this.cfg.commands[OVERRIDE_KEY[tool] || tool] || this.cfg.commands[tool] || this.cfg.commands[id];
    let command;
    let kind = x.kind || "task";
    if (x.line) {
      command = { line: x.line };
    } else if (override && kind !== "env") {
      command = { line: override };
      kind = "task";
    } else if (kind === "task" && (x.cmdArgs || TOOL_COMMANDS[tool])) {
      const [cmd, ...args] = x.cmdArgs || TOOL_COMMANDS[tool];
      command = { cmd, args };
    }
    if (kind === "task" && !command) kind = "info";
    const key = [id, tool, cwd, x.keySuffix || ""].join("\u0001");
    let c = this.map.get(key);
    if (!c) {
      if (this.map.size >= MAX_CHORES) return null;
      c = {
        id,
        key,
        title: x.title || CHORES[id],
        detail,
        details: [detail],
        cwd,
        kind,
        tool,
        command,
        files: [],
      };
      this.map.set(key, c);
    } else if (!c.details.includes(detail)) {
      c.details.push(detail);
    }
    if (file && !c.files.includes(file)) {
      c.files.push(file);
      if (x.extraArgs && c.command && c.command.args) {
        for (const a of x.extraArgs) c.command.args.push(...a);
      }
    }
    if (x.env) c.env = x.env;
    return c;
  }

  list() {
    const out = [...this.map.values()];
    for (const c of out) {
      c.detail = c.details.slice(0, 4).join("; ") + (c.details.length > 4 ? `; and ${c.details.length - 4} more` : "");
      delete c.details;
      c.commandText = commandText(c.command);
    }
    const order = (c) => c.id + "\u0000" + c.cwd;
    return out.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
  }
}

function commandText(command) {
  if (!command) return "";
  if (command.line) return command.line;
  return [command.cmd].concat(command.args || []).map(quoteArg).join(" ");
}

/** Argument form of a file name that can never be read as an option. */
function safeFileArg(name) {
  return name.startsWith("-") ? "./" + name : name;
}

function isSkipped(rel, cfg) {
  if (rel.split("/").some((seg) => SKIP_SEGMENTS.has(seg))) return true;
  return cfg.ignore.some((re) => re.test(rel));
}

/**
 * Work out the chores for a set of changed entries.
 * @param {{
 *   entries: {status: string, oldMode: string, newMode: string, path: string}[],
 *   readOld: (rel: string) => Promise<string|null>,
 *   readNew: (rel: string) => Promise<string|null>,
 *   existsNew: (rel: string) => Promise<boolean>,
 *   config?: object
 * }} ctx
 * @returns {Promise<Chore[]>}
 */
async function analyze(ctx) {
  const cfg = normalizeConfig(ctx.config);
  const set = new ChoreSet(cfg);
  let reads = 0;
  const budget = () => reads++ < MAX_CONTENT_READS;
  const existsCache = new Map();
  const existsNew = async (rel) => {
    if (!existsCache.has(rel)) existsCache.set(rel, await ctx.existsNew(rel));
    return existsCache.get(rel);
  };

  const entries = (ctx.entries || []).filter((e) => isSafeRelPath(e.path) && !isSkipped(e.path, cfg));

  // Submodules (AP011): .gitmodules or a gitlink changed.
  const subFiles = entries.filter((e) => e.path === ".gitmodules" || e.path.endsWith("/.gitmodules") || e.oldMode === "160000" || e.newMode === "160000");
  for (const e of subFiles) {
    set.add("AP011", "submodules", "", e.path, e.oldMode === "160000" || e.newMode === "160000" ? `submodule ${e.path} moved` : `${e.path} changed`);
  }

  const addJs = async (lockDir, lockName, file, detail) => {
    let tool = JS_LOCK_TOOL[lockName] || "npmInstall";
    if (tool === "yarn" && (await existsNew(joinRel(lockDir, ".yarnrc.yml")))) tool = "yarnBerry";
    set.add("AP001", tool, lockDir, file, detail);
  };

  for (const e of entries) {
    if (e.newMode === "160000" || e.oldMode === "160000") continue;
    const rel = e.path;
    const name = posix.basename(rel);
    const dir = dirOf(rel);
    const live = e.status !== "D";

    // AP001 JavaScript lockfiles.
    if (live && JS_LOCK_TOOL[name]) {
      await addJs(dir, name, rel, `${rel} changed`);
      continue;
    }
    // AP001 package.json dependency sections.
    if (live && name === "package.json") {
      if (!budget()) continue;
      const before = e.status === "A" ? null : await ctx.readOld(rel);
      const after = await ctx.readNew(rel);
      if (after == null || !packageDepsChanged(before, after)) continue;
      let found = null;
      for (const d of ancestors(dir)) {
        for (const lock of JS_LOCKS) {
          if (await existsNew(joinRel(d, lock))) {
            found = { d, lock };
            break;
          }
        }
        if (found) break;
      }
      if (found) await addJs(found.d, found.lock, rel, `dependencies changed in ${rel}`);
      else await addJs(dir, "", rel, `dependencies changed in ${rel} (no lockfile)`);
      continue;
    }
    // AP002 Python.
    if (live && PY_LOCKS[name]) {
      set.add("AP002", PY_LOCKS[name], dir, rel, `${rel} changed`);
      continue;
    }
    if (live && (/^requirements[\w.-]*\.(txt|in)$/i.test(name) || (posix.basename(dir) === "requirements" && /\.txt$/i.test(name)))) {
      if (/\.in$/i.test(name)) continue; // pip-tools input, the compiled .txt is what gets installed
      set.add("AP002", "pip", dir, rel, `${rel} changed`, { extraArgs: [["-r", safeFileArg(name)]] });
      continue;
    }
    // AP003-AP006 single-command lockfiles.
    if (live && SIMPLE_LOCKS[name]) {
      const [id, tool] = SIMPLE_LOCKS[name];
      set.add(id, tool, dir, rel, `${rel} changed`);
      continue;
    }
    // AP007 migrations: only newly added files.
    if (e.status === "A") {
      const mig = await classifyMigration(rel, existsNew);
      if (mig) {
        set.add("AP007", mig.tool, mig.cwd, rel, `new migration ${rel}`);
        continue;
      }
    }
    // AP008 .env templates.
    if (live && ENV_TEMPLATES.has(name)) {
      if (!budget()) continue;
      const before = e.status === "A" ? "" : await ctx.readOld(rel);
      const after = await ctx.readNew(rel);
      if (after == null) continue;
      const gained = gainedEnvKeys(before || "", after);
      if (gained.length === 0) continue;
      set.add("AP008", "env", dir, rel, `${rel} gained ${gained.map((k) => k.key).slice(0, 6).join(", ")}${gained.length > 6 ? ", ..." : ""}`, {
        kind: "env",
        keySuffix: rel,
        env: { template: rel, target: joinRel(dir, ".env"), keys: gained },
      });
      continue;
    }
    // AP009 containers.
    if (live && /^(docker-)?compose(\.[\w.-]+)?\.ya?ml$/i.test(name)) {
      if (COMPOSE_AUTO.has(name)) set.add("AP009", "docker", dir, rel, `${rel} changed`);
      else set.add("AP009", "docker", dir, rel, `${rel} changed`, { keySuffix: name, cmdArgs: ["docker", "compose", "-f", safeFileArg(name), "up", "-d", "--build"] });
      continue;
    }
    if (live && (/^Dockerfile(\.[\w.-]+)?$/i.test(name) || /\.dockerfile$/i.test(name) || /^Containerfile$/.test(name))) {
      let composeDir = null;
      for (const d of ancestors(dir)) {
        let hit = false;
        for (const cf of COMPOSE_DEFAULTS) {
          if (await existsNew(joinRel(d, cf))) {
            hit = true;
            break;
          }
        }
        if (hit) {
          composeDir = d;
          break;
        }
      }
      if (composeDir !== null) set.add("AP009", "docker", composeDir, rel, `${rel} changed`);
      else set.add("AP009", "dockerBuild", dir, rel, `${rel} changed`, { keySuffix: name, cmdArgs: ["docker", "build", "-f", safeFileArg(name), "."] });
      continue;
    }
    // AP010 toolchain versions.
    if (TOOLCHAIN_FILES.has(name)) {
      if (!budget()) continue;
      const before = e.status === "A" ? null : await ctx.readOld(rel);
      const after = e.status === "D" ? null : await ctx.readNew(rel);
      const change = toolchainChange(name, before, after);
      if (!change) continue;
      set.add("AP010", "toolchain", dir, rel, `${rel}: ${change}`, { kind: "info", keySuffix: rel, title: `Toolchain version changed: ${change}` });
      continue;
    }
    // AP012 Terraform.
    if (live && name === ".terraform.lock.hcl") {
      set.add("AP012", "terraform", dir, rel, `${rel} changed`);
      continue;
    }
    if (/\.tf$/i.test(name)) {
      if (!budget()) continue;
      const before = e.status === "A" ? "" : await ctx.readOld(rel);
      const after = e.status === "D" ? "" : await ctx.readNew(rel);
      if (terraformInitNeeded(before || "", after || "")) set.add("AP012", "terraform", dir, rel, `module or provider sources changed in ${rel}`);
    }
  }

  // AP013 custom rules (checked against every entry, independent of the built-in rules).
  for (const r of cfg.rules) {
    for (const e of entries) {
      if (r.when === "added" && e.status !== "A") continue;
      if (!r.re.test(e.path)) continue;
      const cwd = r.cwd === "file" ? dirOf(e.path) : "";
      set.add("AP013", "custom" + r.index, cwd, e.path, `${e.path} matches ${r.glob}`, { line: r.command, title: r.label });
    }
  }

  return set.list();
}

/**
 * Classify a newly added file as a migration. Returns { tool, cwd } or null.
 * @param {string} rel
 * @param {(rel: string) => Promise<boolean>} existsNew
 */
async function classifyMigration(rel, existsNew) {
  const name = posix.basename(rel);
  let pre;
  if ((pre = matchPrefix(rel, /(^|\/)alembic\/versions\/[^/]+\.py$/, "alembic/versions/")) !== null) {
    return { tool: "alembic", cwd: pre };
  }
  if ((pre = matchPrefix(rel, /(^|\/)prisma\/migrations\/[^/]+\/migration\.sql$/, "prisma/migrations/")) !== null) {
    return { tool: "prisma", cwd: pre };
  }
  if ((pre = matchPrefix(rel, /(^|\/)db\/migrate\/[^/]+\.rb$/, "db/migrate/")) !== null) {
    return { tool: "rails", cwd: pre };
  }
  if ((pre = matchPrefix(rel, /(^|\/)src\/main\/resources\/db\/migration\/.+\.sql$/, "src/main/resources/db/migration/")) !== null) {
    const gradle = !(await existsNew(joinRel(pre, "pom.xml"))) && ((await existsNew(joinRel(pre, "build.gradle"))) || (await existsNew(joinRel(pre, "build.gradle.kts"))));
    return { tool: gradle ? "flywayGradle" : "flyway", cwd: pre };
  }
  if (/(^|\/)migrations\/[^/]+\.py$/.test(rel)) {
    if (name === "__init__.py") return null;
    const appDir = dirOf(dirOf(rel));
    for (const d of ancestors(appDir)) {
      if (await existsNew(joinRel(d, "manage.py"))) return { tool: "django", cwd: d };
    }
    return { tool: "migrate", cwd: appDir };
  }
  if (/(^|\/)migrations\/[^/]+\.(js|ts|mjs|cjs)$/.test(rel)) {
    const base = dirOf(dirOf(rel));
    for (const d of ancestors(base)) {
      for (const k of ["knexfile.js", "knexfile.ts", "knexfile.mjs", "knexfile.cjs"]) {
        if (await existsNew(joinRel(d, k))) return { tool: "knex", cwd: d };
      }
    }
    return { tool: "migrate", cwd: base };
  }
  const segs = rel.split("/");
  const idx = segs.findIndex((s) => s === "migrations" || s === "migration");
  if (idx >= 0 && idx < segs.length - 1 && /\.(sql|py|rb|js|ts|go|php|java|kt|cs|exs|ex)$/i.test(name)) {
    if (name === "migration_lock.toml") return null;
    return { tool: "migrate", cwd: segs.slice(0, idx).join("/") };
  }
  return null;
}

function matchPrefix(rel, re, marker) {
  if (!re.test(rel)) return null;
  return prefixBefore(rel, marker);
}

// ---------------------------------------------------------------------------------------
// Repository-level entry point
// ---------------------------------------------------------------------------------------

/**
 * Compute the chores for the move of HEAD from oldSha to newSha in the repository at root.
 * @param {{root: string, gitPath?: string, oldSha: string, newSha: string, config?: object}} opts
 * @returns {Promise<{chores: Chore[], fileCount: number, error?: string}>}
 */
async function computeChores(opts) {
  const { root, gitPath, oldSha, newSha } = opts;
  if (!isSha(oldSha) || !isSha(newSha)) return { chores: [], fileCount: 0, error: "invalid commit id" };
  if (oldSha === newSha) return { chores: [], fileCount: 0 };
  const diff = await runGit(gitPath, root, [
    "diff", "--raw", "-z", "--no-abbrev", "--no-renames", "--no-relative", "--no-ext-diff",
    "--no-textconv", "--no-color", "--ignore-submodules=none", oldSha, newSha, "--",
  ], { maxBytes: MAX_DIFF_BYTES, timeout: 30000 });
  if (!diff.ok) return { chores: [], fileCount: 0, error: "git diff failed: " + diff.stderr.trim().split("\n")[0] };
  const entries = parseRawDiff(diff.stdout);
  const show = async (sha, rel) => {
    if (!isSafeRelPath(rel)) return null;
    const r = await runGit(gitPath, root, ["show", "--no-textconv", "--no-ext-diff", "--no-color", sha + ":" + rel], { maxBytes: MAX_SHOW_BYTES });
    return r.ok ? r.stdout.toString("utf8") : null;
  };
  const chores = await analyze({
    entries,
    readOld: (rel) => show(oldSha, rel),
    readNew: (rel) => show(newSha, rel),
    existsNew: async (rel) => {
      if (!isSafeRelPath(rel)) return false;
      const r = await runGit(gitPath, root, ["cat-file", "-e", newSha + ":" + rel], { timeout: 5000 });
      return r.ok;
    },
    config: opts.config,
  });
  return { chores, fileCount: entries.length };
}

/**
 * The most recent reflog entry for HEAD: { sha, subject } or null. Used to skip HEAD moves
 * that are your own new commit (subject "commit: ..." or "commit (amend): ...").
 */
async function lastReflog(root, gitPath) {
  const r = await runGit(gitPath, root, ["reflog", "show", "-n", "1", "--format=%H%x00%gs", "HEAD", "--"], { timeout: 5000 });
  if (!r.ok) return null;
  const [sha, subject] = r.stdout.toString("utf8").replace(/\n$/, "").split("\0");
  if (!isSha(sha)) return null;
  return { sha, subject: subject || "" };
}

/** True when a reflog subject means HEAD moved because you committed (not pulled). */
function isOwnCommit(subject) {
  return /^commit( \((amend|initial)\))?:/.test(String(subject || ""));
}

module.exports = {
  CHORES,
  TOOL_COMMANDS,
  runGit,
  hardenedEnv,
  isSha,
  isSafeRelPath,
  displayPath,
  quoteArg,
  globToRegExp,
  normalizeConfig,
  parseRawDiff,
  parseEnv,
  gainedEnvKeys,
  missingEnvKeys,
  buildEnvAppend,
  packageDepsChanged,
  toolchainChange,
  terraformInitSignature,
  terraformInitNeeded,
  classifyMigration,
  analyze,
  computeChores,
  lastReflog,
  isOwnCommit,
  commandText,
};
