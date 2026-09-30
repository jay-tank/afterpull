"use strict";

// In-editor test, loaded by VS Code through --extensionTestsPath. Expects the workspace built
// by test/run-vscode.js (main repo + hostile repo) and its JSON config in AP_TEST_CONFIG.

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const { git } = require("../fixtures");

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: cond ? undefined : detail });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (_) { /* retry */ }
    await sleep(250);
  }
  throw new Error("timeout waiting for " + label);
}

async function soft(name, fn, timeoutMs) {
  try {
    await waitFor(fn, timeoutMs || 20000, name);
    check(name, true);
  } catch (e) {
    check(name, false, String(e));
  }
}

function finish(resultFile) {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  fs.writeFileSync(resultFile, JSON.stringify({ passed, failed, results }, null, 2));
  if (failed) throw new Error(`${failed} in-editor checks failed`);
}

async function runUntrusted(cfg) {
  const { main, hostile, outsideDir, resultFile } = cfg;
  try {
    check("untrusted: workspace is not trusted", !vscode.workspace.isTrusted);
    const ext = vscode.extensions.getExtension("jaytankdev.afterpull");
    let api;
    try {
      api = ext.isActive ? ext.exports : await ext.activate();
    } catch (_) { /* activation blocked in restricted mode */ }
    // Move HEAD in both repos while untrusted.
    git(main.root, "checkout", "-q", main.newSha);
    git(hostile.root, "checkout", "-q", hostile.newSha);
    await sleep(6000);
    if (api) {
      check("untrusted: no chores (git never run)", api.getChores().length === 0);
      check("untrusted: no status bar text", api.getStatusText() === "", api.getStatusText());
      check("untrusted: view is empty and badge is 0", api.getTreeItems().length === 0 && api.getBadge() === 0);
    } else {
      const g = vscode.extensions.getExtension("vscode.git");
      const cmds = (await vscode.commands.getCommands(true)).filter((c) => c.startsWith("afterpull.") && !c.startsWith("afterpull.chores."));
      check("untrusted: vscode.git is disabled in Restricted Mode", !g);
      check("untrusted: AfterPull activate() never ran (no commands besides the built-in view ones, no API)", cmds.length === 0 && ext.exports === undefined, JSON.stringify(cmds));
    }
    let r;
    try {
      r = await vscode.commands.executeCommand("afterpull.runAll");
    } catch (_) {
      r = "command unavailable";
    }
    check("untrusted: Run all does nothing", r !== true, String(r));
    check("untrusted: no tasks started", vscode.tasks.taskExecutions.length === 0);
    {
      const pkg = require("../../package.json");
      const w = (pkg.contributes.viewsWelcome || []).find((x) => x.view === "afterpull.chores" && x.when === "!isWorkspaceTrusted");
      check("untrusted: empty state explains trust with a Manage Workspace Trust button", w && w.contents.includes("command:workbench.trust.manage"));
      let opened = true;
      try {
        await vscode.commands.executeCommand("workbench.view.extension.afterpull");
      } catch (_) {
        opened = false;
      }
      check("untrusted: AfterPull activity bar container opens", opened);
    }
    check("untrusted: outside file untouched", fs.readFileSync(path.join(outsideDir, "outside.env"), "utf8") === "OUTSIDE_SECRET=do-not-touch\n");
  } catch (e) {
    check("unexpected exception", false, String(e && e.stack ? e.stack : e));
  }
  finish(resultFile);
}

async function runNoRepo(cfg) {
  try {
    check("norepo: workspace is trusted", vscode.workspace.isTrusted);
    const ext = vscode.extensions.getExtension("jaytankdev.afterpull");
    await vscode.commands.executeCommand("workbench.view.extension.afterpull");
    const api = ext.isActive ? ext.exports : await ext.activate();
    await sleep(4000);
    check("norepo: no repositories tracked", api.getRepositoryRoots().length === 0, JSON.stringify(api.getRepositoryRoots()));
    check("norepo: afterpull.hasRepos context is false (no git repo empty state)", api.getContext()["afterpull.hasRepos"] === false, JSON.stringify(api.getContext()));
    check("norepo: view is empty and badge is 0", api.getTreeItems().length === 0 && api.getBadge() === 0);
    const pkg = require("../../package.json");
    const w = (pkg.contributes.viewsWelcome || []).find((x) => x.view === "afterpull.chores" && /!afterpull\.hasRepos/.test(x.when || ""));
    check("norepo: empty state says no git repository, explains what it detects, Open Folder button", w && /No git repository/.test(w.contents) && /migrations/.test(w.contents) && w.contents.includes("command:vscode.openFolder"));
  } catch (e) {
    check("unexpected exception", false, String(e && e.stack ? e.stack : e));
  }
  finish(cfg.resultFile);
}

async function run() {
  const cfg = JSON.parse(fs.readFileSync(process.env.AP_TEST_CONFIG, "utf8"));
  if (cfg.mode === "untrusted") return runUntrusted(cfg);
  if (cfg.mode === "norepo") return runNoRepo(cfg);
  const { main, hostile, outsideDir, markerDir, resultFile } = cfg;
  const M = main.root;
  const H = hostile.root;

  const started = [];
  const startSub = vscode.tasks.onDidStartTask((e) => started.push(e.execution.task));

  try {
    check("workspace is trusted (trust disabled for the test)", vscode.workspace.isTrusted);
    const gitExt = vscode.extensions.getExtension("vscode.git");
    check("built-in vscode.git present", !!gitExt);
    if (!gitExt.isActive) await gitExt.activate();

    const ext = vscode.extensions.getExtension("jaytankdev.afterpull");
    check("AfterPull extension found", !!ext);
    const api = ext.isActive ? ext.exports : await ext.activate();

    await waitFor(() => api.getRepositoryRoots().includes(M) && api.getRepositoryRoots().includes(H) && api.getHead(M) === main.oldSha && api.getHead(H) === hostile.oldSha, 60000, "both repos tracked with their HEAD");
    check("tracks main and hostile repos at the old HEAD", true);
    check("no chores before HEAD moves", api.getChores().length === 0);
    check("status bar hidden when there is nothing to do", api.getStatusText() === "");

    // ---- Activity bar container, view, badge and empty states. ----
    {
      const pkg = require("../../package.json");
      const ac = (pkg.contributes.viewsContainers || {}).activitybar || [];
      check("activity bar container contributed (id afterpull, title AfterPull)", ac.some((c) => c.id === "afterpull" && c.title === "AfterPull" && c.icon === "media/activity.svg"));
      check("activity bar icon file exists", fs.existsSync(path.join(__dirname, "..", "..", "media", "activity.svg")));
      const views = pkg.contributes.views || {};
      check("view afterpull.chores moved out of Source Control into the afterpull container", !views.scm && (views.afterpull || []).some((v) => v.id === "afterpull.chores"), JSON.stringify(Object.keys(views)));
      const whens = (pkg.contributes.viewsWelcome || []).filter((w) => w.view === "afterpull.chores").map((w) => w.when);
      check("empty states: untrusted, turned off, no git repo, nothing to do", ["!isWorkspaceTrusted", "isWorkspaceTrusted && afterpull.disabled", "isWorkspaceTrusted && !afterpull.disabled && !afterpull.hasRepos", "isWorkspaceTrusted && !afterpull.disabled && afterpull.hasRepos"].every((w) => whens.includes(w)), JSON.stringify(whens));
      const nothing = (pkg.contributes.viewsWelcome || []).find((w) => w.when === "isWorkspaceTrusted && !afterpull.disabled && afterpull.hasRepos");
      check("nothing-to-do empty state explains what it detects and has a button", nothing && /Nothing to do after the last pull/.test(nothing.contents) && /\.env/.test(nothing.contents) && /\]\(command:/.test(nothing.contents));
      await vscode.commands.executeCommand("workbench.view.extension.afterpull");
      await sleep(1000);
      check("context: afterpull.hasRepos true, afterpull.disabled false", api.getContext()["afterpull.hasRepos"] === true && api.getContext()["afterpull.disabled"] === false, JSON.stringify(api.getContext()));
      check("view empty and no badge before HEAD moves", api.getTreeItems().length === 0 && api.getBadge() === 0);
    }

    // ---- The pull: fast-forward main to feature. ----
    git(M, "merge", "-q", "--ff-only", "feature");
    await waitFor(() => api.getChores().filter((c) => c.repoRoot === M).length >= 20, 30000, "main chores after merge");
    let C = api.getChores().filter((c) => c.repoRoot === M);
    const has = (id, cwd, text) => C.find((c) => c.id === id && c.cwd === cwd && (text === undefined || c.commandText === text));
    check("vscode: AP001 root (npm override)", !!has("AP001", ""));
    check("vscode: AP001 api (pnpm override)", !!has("AP001", "api"));
    check("vscode: AP001 berry yarn --immutable", !!has("AP001", "berry", "yarn install --immutable"));
    check("vscode: AP001 negative web scripts-only", !C.some((c) => c.cwd === "web"));
    check("vscode: AP002 pip", !!has("AP002", "svc", "pip install -r requirements-dev.txt -r requirements.txt"));
    check("vscode: AP003 go", !!has("AP003", "gosvc"));
    check("vscode: AP007 django migrate", !!has("AP007", "django", "python manage.py migrate"));
    check("vscode: AP007 negative modified migration (shop)", !C.some((c) => c.files.some((f) => f.startsWith("django/shop/"))));
    check("vscode: AP009 docker compose", !!has("AP009", "", "docker compose up -d --build"));
    check("vscode: AP010 .nvmrc 18 -> 20", C.some((c) => c.id === "AP010" && c.title.endsWith("18 -> 20")));
    check("vscode: AP011 submodules", !!has("AP011", "", "git submodule update --init --recursive"));
    check("vscode: AP012 terraform", !!has("AP012", "infra2", "terraform init"));
    check("vscode: AP013 custom rule, cwd = file folder", !!has("AP013", "proto/api/v1"));
    check("vscode: ignore setting applied", !C.some((c) => c.files.some((f) => f.startsWith("examples/") || f.startsWith("docs/"))));
    const envC = has("AP008", "");
    check("vscode: AP008 env chore lists only keys missing locally", envC && (envC.missing || []).map((k) => k.key).join() === "FEATURE_FLAG,SECRET_KEY", envC && JSON.stringify(envC.missing));
    const pending = api.getChores().length;
    check("status bar shows AfterPull: N", api.getStatusText() === `$(checklist) AfterPull: ${pending}`, api.getStatusText());
    check("activity bar badge = number of pending chores", api.getBadge() === pending, `badge=${api.getBadge()} pending=${pending}`);
    {
      const items = api.getTreeItems();
      check("view lists one row per chore (single repo with chores: no repo groups)", items.length === pending && items.every((i) => /^afterpull\./.test(i.contextValue)), `${items.length} vs ${pending}`);
      check("afterpull.show focuses the view", (await vscode.commands.executeCommand("afterpull.show")) === true);
    }

    // ---- Built-in command task shape (not run). ----
    const pip = has("AP002", "svc");
    const pipTask = await api.buildTaskFor(pip.uid);
    const pe = pipTask && pipTask.execution;
    check("task: built-in pip is a ShellExecution with strong-quoted args", pe && pe.command === "pip" && pe.args.map((a) => a.value).join(" ") === "install -r requirements-dev.txt -r requirements.txt" && pe.args.every((a) => a.quoting === vscode.ShellQuoting.Strong), pe && JSON.stringify(pe.args));
    check("task: pip cwd is the requirements folder", pe && pe.options.cwd === path.join(M, "svc"), pe && pe.options.cwd);
    check("task: type afterpull, source AfterPull", pipTask.definition.type === "afterpull" && pipTask.source === "AfterPull");

    // ---- .env: add missing keys. ----
    const envBefore = fs.readFileSync(path.join(M, ".env"), "utf8");
    const added = await vscode.commands.executeCommand("afterpull.addEnvKeys", envC);
    check("addEnvKeys returned true", added === true);
    const envAfter = fs.readFileSync(path.join(M, ".env"), "utf8");
    check(".env: existing lines kept, new keys appended with template placeholders", envAfter === envBefore + "# Added by AfterPull from .env.example\nFEATURE_FLAG=\nSECRET_KEY=\"change me\"\n", JSON.stringify(envAfter));
    check(".env: existing value not overwritten, REDIS_URL not duplicated", envAfter.split("\n").filter((l) => l.startsWith("REDIS_URL=")).length === 1 && envAfter.includes("REDIS_URL=redis://custom:6380"));
    check(".env chore marked done", api.getChores().find((c) => c.uid === envC.uid).status === "done");
    check("badge drops by one when a chore is done", api.getBadge() === pending - 1, `badge=${api.getBadge()} pending=${pending}`);
    const again = await vscode.commands.executeCommand("afterpull.addEnvKeys", envC);
    check("addEnvKeys is idempotent", again === true && fs.readFileSync(path.join(M, ".env"), "utf8") === envAfter);

    // ---- Run one chore: a visible Task with the right command and cwd. ----
    const npmC = has("AP001", "");
    const ran = await vscode.commands.executeCommand("afterpull.run", npmC);
    check("run command returned true", ran === true);
    await soft("npm override task wrote its marker in the repo root", () => fs.existsSync(path.join(M, "ap-npm-ran.txt")));
    const t = started.find((x) => x.definition.type === "afterpull" && x.definition.chore === npmC.uid);
    check("task started with the override command line", t && t.execution.commandLine === npmC.commandText, t && t.execution.commandLine);
    check("task cwd = chore folder (repo root)", t && t.execution.options.cwd === M, t && t.execution.options.cwd);
    check("marker content is the repo root (process.cwd)", fs.existsSync(path.join(M, "ap-npm-ran.txt")) && fs.readFileSync(path.join(M, "ap-npm-ran.txt"), "utf8") === M);
    await soft("chore marked done after exit code 0", () => api.getChores().find((c) => c.uid === npmC.uid).status === "done");

    // Custom rule with cwd=file.
    const protoC = has("AP013", "proto/api/v1");
    await vscode.commands.executeCommand("afterpull.run", protoC);
    await soft("custom rule task ran in the file's folder", () => fs.existsSync(path.join(M, "proto", "api", "v1", "ap-proto-ran.txt")));
    await soft("custom rule chore done", () => api.getChores().find((c) => c.uid === protoC.uid).status === "done");

    // A failing command is marked failed, not done.
    const pnpmC = has("AP001", "api");
    await vscode.commands.executeCommand("afterpull.run", pnpmC);
    await soft("non-zero exit marks the chore failed", () => api.getChores().find((c) => c.uid === pnpmC.uid).status === "failed");

    // Forged / stale arguments are ignored.
    check("forged run argument rejected", (await vscode.commands.executeCommand("afterpull.run", { uid: "nope", kind: "task" })) === false);
    check("forged env argument rejected", (await vscode.commands.executeCommand("afterpull.addEnvKeys", { uid: M + "\u0002x", env: { target: "../../outside/outside.env" } })) === false);
    check("info chore cannot be run", (await vscode.commands.executeCommand("afterpull.run", C.find((c) => c.kind === "info"))) === false);

    // Dismiss.
    const goC = has("AP003", "gosvc");
    check("dismiss returned true", (await vscode.commands.executeCommand("afterpull.dismiss", goC)) === true);
    check("dismissed chore removed", !api.getChores().some((c) => c.uid === goC.uid));

    // ---- Your own commit is not a pull. ----
    await vscode.commands.executeCommand("afterpull.dismissAll");
    check("dismissAll empties the list", api.getChores().length === 0);
    check("dismissAll clears the badge and the view", api.getBadge() === 0 && api.getTreeItems().length === 0);
    fs.writeFileSync(path.join(M, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, local: true }) + "\n");
    git(M, "add", "package-lock.json");
    git(M, "commit", "-q", "-m", "my own lockfile change");
    const ownHead = git(M, "rev-parse", "HEAD").trim();
    await soft("HEAD move to own commit observed", () => api.getHead(M) === ownHead, 20000);
    await sleep(2500);
    check("own commit produces no chores", api.getChores().length === 0, JSON.stringify(api.getChores().map((c) => c.id)));

    // ---- git checkout back to the old commit (detached). ----
    git(M, "checkout", "-q", main.oldSha);
    await waitFor(() => api.getChores().some((c) => c.repoRoot === M && c.id === "AP001" && c.cwd === ""), 30000, "chores after checkout").then(
      () => check("checkout to old commit lists reinstall again", true),
      (e) => check("checkout to old commit lists reinstall again", false, String(e))
    );
    C = api.getChores().filter((c) => c.repoRoot === M);
    check("checkout back: no migration chores (migrations were removed, not added)", !C.some((c) => c.id === "AP007"));
    check("checkout back: toolchain 20 -> 18", C.some((c) => c.id === "AP010" && c.title.endsWith("20 -> 18")));

    // ---- Settings: disabledChores and enabled. ----
    const conf = vscode.workspace.getConfiguration("afterpull");
    await conf.update("disabledChores", ["AP010"], vscode.ConfigurationTarget.Global);
    await soft("disabledChores applied to the listed chores", () => !api.getChores().some((c) => c.id === "AP010") && api.getChores().some((c) => c.id === "AP001"));
    await conf.update("disabledChores", undefined, vscode.ConfigurationTarget.Global);

    // ---- Hostile repository. ----
    git(H, "checkout", "-q", "feature/$(touch${IFS}pwned)");
    await waitFor(() => api.getChores().filter((c) => c.repoRoot === H).length >= 4, 30000, "hostile chores");
    const HC = api.getChores().filter((c) => c.repoRoot === H);
    {
      const items = api.getTreeItems();
      check("two repos with chores: view groups by repository", items.length === 2 && items.every((i) => i.contextValue === "afterpullRepo"), JSON.stringify(items.map((i) => i.label)));
      check("badge counts chores across both repos", api.getBadge() === api.getChores().filter((c) => c.status !== "done").length, `badge=${api.getBadge()}`);
    }
    check("hostile: 40-hex branch collision does not change the chores (npm chore in -rf)", HC.some((c) => c.id === "AP001" && c.cwd === "-rf") && HC.length === 6, JSON.stringify(HC.map((c) => [c.id, c.cwd, c.commandText])));
    check("hostile: option-like requirements file passed as ./-e.txt", HC.some((c) => c.id === "AP002" && c.commandText.includes("./-e.txt")));
    check("hostile: newline path dropped", !HC.some((c) => /\n/.test(c.cwd) || c.files.some((f) => /\n/.test(f))));
    const rootEnv = HC.find((c) => c.id === "AP008" && c.cwd === "");
    check("hostile: .env symlinked outside is flagged as refused", rootEnv && /outside the workspace/.test(rootEnv.blocked || ""), rootEnv && rootEnv.blocked);
    check("hostile: addEnvKeys refuses symlinked .env", (await vscode.commands.executeCommand("afterpull.addEnvKeys", rootEnv)) === false);
    const cfgEnv = HC.find((c) => c.id === "AP008" && c.cwd === "cfg");
    check("hostile: cfg/.env escaping through a linked dir is refused", cfgEnv && !!cfgEnv.blocked && (await vscode.commands.executeCommand("afterpull.addEnvKeys", cfgEnv)) === false);
    check("hostile: outside .env untouched", fs.readFileSync(path.join(outsideDir, "outside.env"), "utf8") === "OUTSIDE_SECRET=do-not-touch\n");
    check("hostile: outside cfg.env untouched", fs.readFileSync(path.join(outsideDir, "cfg.env"), "utf8") === "OUTSIDE=1\n");
    check("hostile: repo .env is still a symlink", fs.lstatSync(path.join(H, ".env")).isSymbolicLink());
    const dockerH = HC.find((c) => c.id === "AP009");
    const dt = dockerH && (await api.buildTaskFor(dockerH.uid));
    check("hostile: docker build task args are literal", dt && dt.execution.command === "docker" && dt.execution.args.map((a) => a.value).join(" ") === "build -f Dockerfile ." && dt.execution.options.cwd === H);
    check("hostile: branch name never executed (no pwned file)", !fs.existsSync(path.join(H, "pwned")) && !fs.existsSync(path.join(M, "pwned")));
    check("hostile: no marker files", fs.readdirSync(markerDir).length === 0, fs.readdirSync(markerDir).join(","));

    // ---- Disable clears everything. ----
    await conf.update("enabled", false, vscode.ConfigurationTarget.Global);
    await soft("enabled=false clears chores and status bar", () => api.getChores().length === 0 && api.getStatusText() === "");
    check("enabled=false: badge 0 and afterpull.disabled context set (turned off empty state)", api.getBadge() === 0 && api.getContext()["afterpull.disabled"] === true, JSON.stringify(api.getContext()));
    await conf.update("enabled", undefined, vscode.ConfigurationTarget.Global);
    await soft("re-enabled tracks repositories again", () => api.getRepositoryRoots().length === 2, 30000);
  } catch (e) {
    check("unexpected exception", false, String(e && e.stack ? e.stack : e));
  }
  startSub.dispose();
  finish(resultFile);
}

module.exports = { run };
