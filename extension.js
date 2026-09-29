"use strict";

/**
 * AfterPull - when HEAD moves (pull, merge, checkout, rebase), lists what you need to run
 * afterwards: reinstall dependencies, apply new migrations, add new .env keys, rebuild
 * containers, switch toolchains, update submodules, terraform init, plus your own rules.
 *
 * - HEAD moves come from the built-in Git extension (vscode.git API v1:
 *   repositories, state.onDidChange, state.HEAD.commit). The changed files between the old
 *   and the new HEAD are read by core.js with hardened git calls (see the header there).
 * - HEAD moves that are your own new commit (reflog "commit:" / "commit (amend):") are
 *   skipped, so committing your own lockfile change does not ask you to reinstall.
 * - Nothing ever runs on its own. Every command is started as a visible VS Code Task after an
 *   explicit click (Run on one chore, or Run all after a modal that lists every command).
 * - The ".env" edit is a WorkspaceEdit that only appends missing keys, on a .env whose real
 *   path is inside the repository (a symlink pointing elsewhere is refused).
 * - Nothing runs in an untrusted workspace; AfterPull starts when trust is granted.
 * - No network access, no telemetry.
 */

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const core = require("./core");

const CONFIG_SECTION = "afterpull";
const DEBOUNCE_MS = 1200;
const MAX_ENV_BYTES = 1024 * 1024;

/** @type {vscode.StatusBarItem} */
let statusItem;
/** @type {ChoreTree} */
let tree;
/** @type {vscode.TreeView<any>} */
let treeView;
let gitApi = null;
let started = false;
let disposed = false;
/** Map<string, RepoState> keyed by repository rootUri.fsPath. */
const repos = new Map();
/** Map<string uid, Entry> - every chore currently listed. */
const chores = new Map();
/** Map<string uid, (code: number | undefined) => void> - running task waiters. */
const running = new Map();
const gitDisposables = [];

/**
 * @typedef {{ repo: any, cwd: string, realRoot: string, head?: string, timer?: any,
 *   chain: Promise<void>, lastRange?: {from: string, to: string, verb: string}, listener?: vscode.Disposable }} RepoState
 * @typedef {{ uid: string, repoRoot: string, status: "pending"|"running"|"done"|"failed",
 *   chore: object, blocked?: string, missing?: {key: string, value: string}[] }} Entry
 */

function getConfig() {
  const c = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    enabled: c.get("enabled", true),
    notify: c.get("notify", true),
    ignore: c.get("ignore", []),
    commands: c.get("commands", {}),
    rules: c.get("rules", []),
    disabledChores: c.get("disabledChores", []),
  };
}

function gitPath() {
  return gitApi && gitApi.git && typeof gitApi.git.path === "string" && gitApi.git.path ? gitApi.git.path : "git";
}

// ---------------------------------------------------------------------------------------
// Path confinement
// ---------------------------------------------------------------------------------------

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function realpathOrNull(p) {
  try {
    return await fs.promises.realpath(p);
  } catch (_) {
    return null;
  }
}

/** Real path of the repository root if it lies inside an open workspace folder, else null. */
async function confinedRepoRoot(rootFsPath) {
  const real = await realpathOrNull(rootFsPath);
  if (!real) return null;
  for (const wf of vscode.workspace.workspaceFolders || []) {
    if (wf.uri.scheme !== "file") continue;
    const wfReal = await realpathOrNull(wf.uri.fsPath);
    if (wfReal && isInside(wfReal, real)) return real;
  }
  return null;
}

/** Absolute real directory for a chore's repo-relative cwd, or null if it escapes. */
async function resolveChoreDir(repoRoot, rel) {
  const st = repos.get(repoRoot);
  if (!st) return null;
  if (rel && !core.isSafeRelPath(rel)) return null;
  const abs = rel ? path.join(st.cwd, ...rel.split("/")) : st.cwd;
  const real = await realpathOrNull(abs);
  if (!real || !isInside(st.realRoot, real)) return null;
  try {
    if (!(await fs.promises.stat(real)).isDirectory()) return null;
  } catch (_) {
    return null;
  }
  return real;
}

/**
 * Resolve the local .env for an env chore. Returns { real, exists } when the file (or, when
 * missing, its folder) is really inside the repository, or { refused: reason }.
 */
async function resolveEnvTarget(repoRoot, rel) {
  const st = repos.get(repoRoot);
  if (!st || !core.isSafeRelPath(rel)) return { refused: "invalid path" };
  const abs = path.join(st.cwd, ...rel.split("/"));
  let lst = null;
  try {
    lst = await fs.promises.lstat(abs);
  } catch (_) {
    lst = null;
  }
  if (!lst) {
    const parentReal = await realpathOrNull(path.dirname(abs));
    if (!parentReal || !isInside(st.realRoot, parentReal)) return { refused: "its folder is outside the workspace" };
    return { real: path.join(parentReal, path.basename(abs)), exists: false };
  }
  const real = await realpathOrNull(abs);
  if (!real || !isInside(st.realRoot, real)) return { refused: `${core.displayPath(rel)} points outside the workspace` };
  try {
    const s = await fs.promises.stat(real);
    if (!s.isFile()) return { refused: `${core.displayPath(rel)} is not a regular file` };
    if (s.size > MAX_ENV_BYTES) return { refused: `${core.displayPath(rel)} is too large` };
  } catch (_) {
    return { refused: "cannot read " + core.displayPath(rel) };
  }
  return { real, exists: true };
}

/** Current text of a confined .env: the open editor buffer if any, else the file on disk. */
async function readEnvText(real) {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === "file" && d.uri.fsPath === real);
  if (open) return open.getText();
  const buf = await fs.promises.readFile(real);
  return buf.subarray(0, MAX_ENV_BYTES).toString("utf8");
}

// ---------------------------------------------------------------------------------------
// Repository tracking
// ---------------------------------------------------------------------------------------

function headOf(repo) {
  const h = repo && repo.state && repo.state.HEAD;
  return h && core.isSha(h.commit) ? h.commit : undefined;
}

async function addRepository(repo) {
  if (disposed || !repo || !repo.rootUri || repo.rootUri.scheme !== "file") return;
  const cwd = repo.rootUri.fsPath;
  if (repos.has(cwd)) return;
  const realRoot = await confinedRepoRoot(cwd);
  if (!realRoot || repos.has(cwd)) return;
  /** @type {RepoState} */
  const st = { repo, cwd, realRoot, head: headOf(repo), chain: Promise.resolve() };
  st.listener = repo.state.onDidChange(() => onRepoChange(st));
  repos.set(cwd, st);
  refreshViews();
}

function removeRepository(repo) {
  const cwd = repo && repo.rootUri && repo.rootUri.fsPath;
  const st = cwd && repos.get(cwd);
  if (!st) return;
  if (st.timer) clearTimeout(st.timer);
  if (st.listener) st.listener.dispose();
  repos.delete(cwd);
  for (const [uid, e] of chores) if (e.repoRoot === cwd) chores.delete(uid);
  refreshViews();
}

function onRepoChange(st) {
  const now = headOf(st.repo);
  if (!now) return;
  if (!st.head) {
    st.head = now; // first observation: remember, nothing to compare with yet
    return;
  }
  if (now === st.head) return;
  if (st.timer) clearTimeout(st.timer);
  st.timer = setTimeout(() => {
    st.timer = null;
    st.chain = st.chain.then(() => processMove(st)).catch(() => undefined);
  }, DEBOUNCE_MS);
}

function verbFor(subject) {
  const s = String(subject || "");
  if (/^checkout:/.test(s)) return "checkout";
  if (/^merge\b/.test(s) || /^commit \(merge\)/.test(s)) return "merge";
  if (/^rebase\b/.test(s)) return "rebase";
  if (/^reset:/.test(s)) return "reset";
  return "pull";
}

/** @param {RepoState} st */
async function processMove(st) {
  const cfg = getConfig();
  const to = headOf(st.repo);
  const from = st.head;
  if (!to || !from || to === from || disposed || !repos.has(st.cwd)) return;
  st.head = to;
  if (!cfg.enabled || !vscode.workspace.isTrusted) return;
  const rl = await core.lastReflog(st.cwd, gitPath());
  if (rl && rl.sha === to && core.isOwnCommit(rl.subject)) return;
  st.lastRange = { from, to, verb: verbFor(rl && rl.sha === to ? rl.subject : "") };
  await computeRange(st, true);
}

/**
 * Compute chores for st.lastRange and merge them into the list. With notify=false (a
 * settings change) existing statuses are kept.
 * @param {RepoState} st
 * @param {boolean} isMove
 */
async function computeRange(st, isMove) {
  const cfg = getConfig();
  const range = st.lastRange;
  if (!range) return;
  const res = await core.computeChores({ root: st.cwd, gitPath: gitPath(), oldSha: range.from, newSha: range.to, config: cfg });
  if (disposed || !repos.has(st.cwd)) return;
  let fresh = 0;
  const seen = new Set();
  for (const c of res.chores) {
    const uid = st.cwd + "\u0002" + c.key;
    seen.add(uid);
    let blocked;
    let missing;
    if (c.kind === "env") {
      const t = await resolveEnvTarget(st.cwd, c.env.target);
      if (t.refused) {
        blocked = t.refused;
      } else {
        if (!t.exists) continue; // no local .env in that folder: nothing has drifted
        let text = "";
        try {
          text = await readEnvText(t.real);
        } catch (_) {
          continue;
        }
        missing = core.missingEnvKeys(text, c.env.keys);
        if (missing.length === 0) continue; // your .env already has every new key
      }
    }
    const prev = chores.get(uid);
    if (prev && !isMove) {
      prev.chore = c;
      prev.blocked = blocked;
      prev.missing = missing;
      continue;
    }
    if (prev && prev.status === "running") continue;
    if (!prev || prev.status !== "pending") fresh++;
    chores.set(uid, { uid, repoRoot: st.cwd, status: "pending", chore: c, blocked, missing });
  }
  if (!isMove) {
    // Settings changed: drop pending chores of this range that no longer apply.
    for (const [uid, e] of chores) if (e.repoRoot === st.cwd && !seen.has(uid) && e.status === "pending") chores.delete(uid);
  }
  refreshViews();
  if (isMove && fresh > 0 && cfg.notify) {
    const n = pendingCount();
    vscode.window
      .showInformationMessage(`AfterPull: ${n} thing${n === 1 ? "" : "s"} to do after this ${range.verb}`, "Show")
      .then((choice) => {
        if (choice === "Show") vscode.commands.executeCommand("afterpull.show");
      });
  }
}

async function recomputeAll() {
  await Promise.all([...repos.values()].map((st) => (st.chain = st.chain.then(() => computeRange(st, false)).catch(() => undefined))));
}

function start() {
  if (started || disposed) return;
  if (!vscode.workspace.isTrusted || !getConfig().enabled) {
    refreshViews();
    return;
  }
  const ext = vscode.extensions.getExtension("vscode.git");
  if (!ext) return;
  started = true;
  Promise.resolve(ext.isActive ? ext.exports : ext.activate()).then((exp) => {
    if (disposed) return;
    const api = exp && exp.getAPI ? exp.getAPI(1) : null;
    if (!api) return;
    gitApi = api;
    const attach = () => {
      for (const r of api.repositories) addRepository(r);
    };
    gitDisposables.push(api.onDidOpenRepository((r) => addRepository(r)));
    gitDisposables.push(api.onDidCloseRepository((r) => removeRepository(r)));
    if (api.state === "initialized") attach();
    else gitDisposables.push(api.onDidChangeState((s) => s === "initialized" && attach()));
    attach();
  }, () => { started = false; });
}

function stop() {
  for (const d of gitDisposables.splice(0)) d.dispose();
  for (const st of repos.values()) {
    if (st.timer) clearTimeout(st.timer);
    if (st.listener) st.listener.dispose();
  }
  repos.clear();
  chores.clear();
  started = false;
  refreshViews();
}

// ---------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------

function pendingCount() {
  let n = 0;
  for (const e of chores.values()) if (e.status !== "done") n++;
  return n;
}

function statusText() {
  if (!getConfig().enabled || !vscode.workspace.isTrusted) return "";
  const n = pendingCount();
  return n ? `$(checklist) AfterPull: ${n}` : "";
}

/** Context keys for the view's empty states; only sent when the value changes. */
const contextValues = new Map();
function setContext(key, value) {
  if (contextValues.get(key) === value) return;
  contextValues.set(key, value);
  vscode.commands.executeCommand("setContext", key, value);
}

function refreshViews() {
  if (statusItem) {
    const t = statusText();
    statusItem.text = t;
    statusItem.tooltip = "AfterPull: things to run after the last pull, merge, checkout or rebase";
    if (t) statusItem.show();
    else statusItem.hide();
  }
  setContext("afterpull.disabled", !getConfig().enabled);
  setContext("afterpull.hasRepos", repos.size > 0);
  if (tree) tree.fire();
  if (treeView) {
    const n = vscode.workspace.isTrusted && getConfig().enabled ? pendingCount() : 0;
    treeView.badge = n ? { value: n, tooltip: `${n} after-pull chore${n === 1 ? "" : "s"}` } : undefined;
  }
}

function sortedEntries() {
  return [...chores.values()].sort((a, b) => {
    const ka = a.repoRoot + "\u0000" + a.chore.id + "\u0000" + a.chore.cwd;
    const kb = b.repoRoot + "\u0000" + b.chore.id + "\u0000" + b.chore.cwd;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

function repoLabel(root) {
  return path.basename(root);
}

class ChoreTree {
  constructor() {
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
  }

  fire() {
    this.emitter.fire(undefined);
  }

  getChildren(element) {
    const list = sortedEntries();
    const roots = [...new Set(list.map((e) => e.repoRoot))];
    if (!element) {
      if (roots.length > 1) return roots.map((r) => ({ group: r }));
      return list;
    }
    if (element.group) return list.filter((e) => e.repoRoot === element.group);
    return [];
  }

  getTreeItem(element) {
    if (element.group) {
      const item = new vscode.TreeItem(repoLabel(element.group), vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = "afterpullRepo";
      item.iconPath = new vscode.ThemeIcon("repo");
      item.tooltip = element.group;
      return item;
    }
    return choreItem(element);
  }
}

function choreItem(e) {
  const c = e.chore;
  const item = new vscode.TreeItem(c.title, vscode.TreeItemCollapsibleState.None);
  const where = c.cwd ? core.displayPath(c.cwd) : "(root)";
  let desc;
  if (c.kind === "env") {
    desc = e.blocked ? "refused: " + e.blocked : `${(e.missing || []).length} key${(e.missing || []).length === 1 ? "" : "s"}: ${(e.missing || []).map((k) => k.key).slice(0, 4).join(", ")}`;
  } else if (c.kind === "info") {
    desc = c.id === "AP007" ? "set afterpull.commands.migrate to run it here" : where;
  } else {
    desc = c.commandText;
  }
  const status = { done: "done", running: "running", failed: "failed" }[e.status];
  item.description = (status ? status + " - " : "") + desc;
  const lines = [c.title, "", c.detail, "", "Folder: " + where];
  if (c.kind === "task") lines.push("Command: " + c.commandText);
  if (c.kind === "env" && !e.blocked) lines.push("Appends to " + core.displayPath(c.env.target) + ": " + (e.missing || []).map((k) => k.key).join(", "));
  if (c.files.length) lines.push("", "Files:", ...c.files.slice(0, 12).map((f) => "  " + core.displayPath(f)), ...(c.files.length > 12 ? [`  and ${c.files.length - 12} more`] : []));
  item.tooltip = lines.join("\n");
  item.id = e.uid;
  if (e.status === "done") {
    item.iconPath = new vscode.ThemeIcon("pass-filled", new vscode.ThemeColor("testing.iconPassed"));
    item.contextValue = "afterpull.done";
  } else if (e.status === "running") {
    item.iconPath = new vscode.ThemeIcon("sync~spin");
    item.contextValue = "afterpull.running";
  } else if (c.kind === "env") {
    item.iconPath = new vscode.ThemeIcon(e.blocked ? "warning" : "key");
    item.contextValue = e.blocked ? "afterpull.envBlocked" : "afterpull.env";
  } else if (c.kind === "info") {
    item.iconPath = new vscode.ThemeIcon("info");
    item.contextValue = "afterpull.info";
  } else {
    item.iconPath = new vscode.ThemeIcon(e.status === "failed" ? "error" : "terminal", e.status === "failed" ? new vscode.ThemeColor("testing.iconFailed") : undefined);
    item.contextValue = "afterpull.task";
  }
  return item;
}

// ---------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------

/** Accept only a live chore (by uid); forged command arguments resolve to null. */
function lookup(arg) {
  const uid = arg && typeof arg === "object" ? arg.uid : typeof arg === "string" ? arg : null;
  return uid && chores.has(uid) ? chores.get(uid) : null;
}

/** Build the visible Task for a chore, or null when its folder cannot be confirmed. */
async function buildTask(e) {
  const c = e.chore;
  if (c.kind !== "task" || !c.command) return null;
  const cwd = await resolveChoreDir(e.repoRoot, c.cwd);
  if (!cwd) return null;
  let execution;
  if (c.command.line) {
    execution = new vscode.ShellExecution(c.command.line, { cwd });
  } else {
    execution = new vscode.ShellExecution(
      c.command.cmd,
      c.command.args.map((a) => ({ value: a, quoting: vscode.ShellQuoting.Strong })),
      { cwd }
    );
  }
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(e.repoRoot)) || vscode.TaskScope.Workspace;
  const name = c.title + (c.cwd ? ` (${core.displayPath(c.cwd)})` : "");
  const task = new vscode.Task({ type: "afterpull", chore: e.uid }, folder, name, "AfterPull", execution, []);
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: false, focus: false };
  return task;
}

/**
 * Start one chore as a task. Resolves to the exit code (undefined if it could not start or
 * the task was terminated without one).
 */
async function runEntry(e) {
  if (!vscode.workspace.isTrusted || e.status === "running") return undefined;
  const task = await buildTask(e);
  if (!task) {
    vscode.window.showWarningMessage(`AfterPull: cannot run "${e.chore.title}" - its folder is not inside the workspace any more.`);
    return undefined;
  }
  const done = new Promise((resolve) => running.set(e.uid, resolve));
  e.status = "running";
  refreshViews();
  try {
    await vscode.tasks.executeTask(task);
  } catch (err) {
    running.delete(e.uid);
    e.status = "failed";
    refreshViews();
    vscode.window.showErrorMessage("AfterPull: could not start the task: " + (err && err.message ? err.message : String(err)));
    return undefined;
  }
  return done;
}

function onTaskEnd(ev) {
  const def = ev.execution && ev.execution.task && ev.execution.task.definition;
  if (!def || def.type !== "afterpull") return;
  const uid = def.chore;
  const resolve = running.get(uid);
  running.delete(uid);
  const e = chores.get(uid);
  const code = typeof ev.exitCode === "number" ? ev.exitCode : undefined;
  if (e) {
    e.status = code === 0 ? "done" : "failed";
    refreshViews();
  }
  if (resolve) resolve(code);
}

async function cmdRun(arg) {
  const e = lookup(arg);
  if (!e || e.chore.kind !== "task") return false;
  runEntry(e);
  return true;
}

async function cmdRunAll() {
  if (!vscode.workspace.isTrusted) return false;
  const list = sortedEntries().filter((e) => e.chore.kind === "task" && (e.status === "pending" || e.status === "failed"));
  if (list.length === 0) {
    vscode.window.showInformationMessage("AfterPull: nothing to run.");
    return false;
  }
  const others = sortedEntries().filter((e) => e.chore.kind !== "task" && e.status !== "done").length;
  const detail =
    list.map((e, i) => `${i + 1}. ${e.chore.cwd ? core.displayPath(e.chore.cwd) : "(root)"}${repos.size > 1 ? " in " + repoLabel(e.repoRoot) : ""}: ${e.chore.commandText}`).join("\n") +
    "\n\nEach command runs as a visible task, one after the other; the run stops at the first failure." +
    (others ? `\n${others} other item${others === 1 ? "" : "s"} (.env keys, notes) need${others === 1 ? "s" : ""} your action separately.` : "");
  const choice = await vscode.window.showWarningMessage(`AfterPull: run ${list.length} command${list.length === 1 ? "" : "s"}?`, { modal: true, detail }, "Run all");
  if (choice !== "Run all") return false;
  for (const e of list) {
    if (!chores.has(e.uid)) continue;
    const code = await runEntry(e);
    if (code !== 0) {
      vscode.window.showErrorMessage(`AfterPull: "${e.chore.commandText}" did not finish successfully${typeof code === "number" ? " (exit " + code + ")" : ""}. Stopped.`);
      return false;
    }
  }
  return true;
}

async function cmdAddEnvKeys(arg) {
  const e = lookup(arg);
  if (!e || e.chore.kind !== "env" || !vscode.workspace.isTrusted) return false;
  const c = e.chore;
  const t = await resolveEnvTarget(e.repoRoot, c.env.target);
  if (t.refused) {
    e.blocked = t.refused;
    refreshViews();
    vscode.window.showWarningMessage(`AfterPull: not editing ${core.displayPath(c.env.target)} - ${t.refused}.`);
    return false;
  }
  const uri = vscode.Uri.file(t.real);
  const text = t.exists ? await readEnvText(t.real) : "";
  const missing = core.missingEnvKeys(text, c.env.keys);
  if (missing.length === 0) {
    e.status = "done";
    refreshViews();
    return true;
  }
  const append = core.buildEnvAppend(text, missing, path.posix.basename(c.env.template));
  const edit = new vscode.WorkspaceEdit();
  if (!t.exists) {
    edit.createFile(uri, { ignoreIfExists: true, contents: Buffer.from(append, "utf8") });
  } else {
    const doc = await vscode.workspace.openTextDocument(uri);
    edit.insert(uri, doc.positionAt(doc.getText().length), append);
  }
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) return false;
  const doc = await vscode.workspace.openTextDocument(uri);
  if (doc.isDirty) await doc.save();
  e.status = "done";
  e.missing = missing;
  refreshViews();
  vscode.window.showInformationMessage(`AfterPull: added ${missing.map((k) => k.key).join(", ")} to ${core.displayPath(c.env.target)}. Fill in real values where needed.`);
  return true;
}

function cmdDismiss(arg) {
  const e = lookup(arg);
  if (!e || e.status === "running") return false;
  chores.delete(e.uid);
  refreshViews();
  return true;
}

function cmdDismissAll() {
  for (const [uid, e] of chores) if (e.status !== "running") chores.delete(uid);
  refreshViews();
  return true;
}

async function cmdShow() {
  try {
    await vscode.commands.executeCommand("afterpull.chores.focus");
  } catch (_) {
    /* view not available */
  }
  return true;
}

// ---------------------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------------------

function activate(context) {
  disposed = false;
  contextValues.clear();
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 40);
  statusItem.name = "AfterPull";
  statusItem.command = "afterpull.show";
  tree = new ChoreTree();
  treeView = vscode.window.createTreeView("afterpull.chores", { treeDataProvider: tree });
  context.subscriptions.push(
    statusItem,
    treeView,
    vscode.commands.registerCommand("afterpull.show", cmdShow),
    vscode.commands.registerCommand("afterpull.run", cmdRun),
    vscode.commands.registerCommand("afterpull.runAll", cmdRunAll),
    vscode.commands.registerCommand("afterpull.addEnvKeys", cmdAddEnvKeys),
    vscode.commands.registerCommand("afterpull.dismiss", cmdDismiss),
    vscode.commands.registerCommand("afterpull.dismissAll", cmdDismissAll),
    vscode.tasks.onDidEndTaskProcess(onTaskEnd),
    vscode.workspace.onDidGrantWorkspaceTrust(() => start()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      stop();
      start();
    }),
    vscode.workspace.onDidChangeConfiguration((ev) => {
      if (!ev.affectsConfiguration(CONFIG_SECTION)) return;
      if (ev.affectsConfiguration(CONFIG_SECTION + ".enabled")) {
        if (getConfig().enabled) start();
        else stop();
        return;
      }
      recomputeAll();
    }),
    { dispose: () => { disposed = true; stop(); } }
  );
  refreshViews();
  start();

  // Small read-only API, used by the in-editor tests.
  return {
    getChores: () => sortedEntries().map((e) => Object.assign({ uid: e.uid, repoRoot: e.repoRoot, status: e.status, blocked: e.blocked, missing: e.missing }, e.chore)),
    getStatusText: statusText,
    getRepositoryRoots: () => [...repos.keys()],
    getHead: (root) => (repos.get(root) || {}).head,
    getTreeItems: () => tree.getChildren().map((el) => tree.getTreeItem(el)),
    getBadge: () => (treeView && treeView.badge ? treeView.badge.value : 0),
    getContext: () => Object.fromEntries(contextValues),
    buildTaskFor: async (uid) => {
      const e = chores.get(uid);
      return e ? buildTask(e) : null;
    },
  };
}

function deactivate() {
  disposed = true;
  stop();
}

module.exports = { activate, deactivate };
