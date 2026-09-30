"use strict";

// Plain Node tests of the AfterPull rule engine against real temporary git repositories.
// Run: node test/core.test.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const core = require("../core");
const { git, makeMainRepo, makeHostileRepo } = require("./fixtures");

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log("PASS " + name);
  } else {
    fail++;
    console.log("FAIL " + name + (detail ? " :: " + detail : ""));
  }
}

const find = (chores, id, cwd, text) => chores.find((c) => c.id === id && c.cwd === cwd && (text === undefined || c.commandText === text));

const TEST_CONFIG = {
  ignore: ["examples/**", "docs/"],
  rules: [
    { glob: "proto/**/*.proto", command: "make proto", label: "Regenerate protobuf code" },
    { glob: "*.md", command: "echo md", when: "added" },
    { glob: "", command: "echo empty glob" },
    { glob: "x", command: "" },
  ],
};

async function main() {
  const base = fs.mkdtempSync(path.join(process.env.AP_TMP || os.tmpdir(), "ap-core-"));

  // ---------------------------------------------------------------- pure helpers
  check("isSha 40 hex", core.isSha("a".repeat(40)));
  check("isSha 64 hex", core.isSha("b".repeat(64)));
  check("isSha rejects short", !core.isSha("abc123"));
  check("isSha rejects option-like", !core.isSha("--output=" + "a".repeat(31)));
  check("isSha rejects uppercase / refs", !core.isSha("A".repeat(40)) && !core.isSha("HEAD") && !core.isSha("main"));
  check("isSafeRelPath ok", core.isSafeRelPath("a/b/package.json"));
  for (const bad of ["", "/etc/passwd", "../x", "a/../b", "a//b", "a\\b", "C:/x", ".git/config", "a\nb/go.sum", "./x"]) {
    check("isSafeRelPath rejects " + JSON.stringify(bad), !core.isSafeRelPath(bad));
  }

  // package.json dependency comparison.
  const p = (o) => JSON.stringify(o);
  check("deps: scripts-only change is not a dependency change", !core.packageDepsChanged(p({ scripts: { a: "1" }, dependencies: { x: "1" } }), p({ scripts: { a: "2" }, dependencies: { x: "1" } })));
  check("deps: version/description change ignored", !core.packageDepsChanged(p({ version: "1", dependencies: { x: "1" } }), p({ version: "2", description: "d", dependencies: { x: "1" } })));
  check("deps: key order does not matter", !core.packageDepsChanged(p({ dependencies: { a: "1", b: "2" } }), p({ dependencies: { b: "2", a: "1" } })));
  check("deps: empty section equals missing section", !core.packageDepsChanged(p({ dependencies: {} }), p({})));
  check("deps: bump detected", core.packageDepsChanged(p({ dependencies: { x: "1" } }), p({ dependencies: { x: "2" } })));
  check("deps: devDependencies added", core.packageDepsChanged(p({}), p({ devDependencies: { jest: "29" } })));
  check("deps: overrides change", core.packageDepsChanged(p({ overrides: { a: "1" } }), p({ overrides: { a: "2" } })));
  check("deps: new file with deps", core.packageDepsChanged(null, p({ dependencies: { a: "1" } })));
  check("deps: new file without deps", !core.packageDepsChanged(null, p({ name: "x", scripts: {} })));
  check("deps: unparsable but changed -> conservative true", core.packageDepsChanged("{", "{ }"));

  // env parsing and diff.
  const tpl = "# c\nA=1\nexport B=two\nC=\"quoted value\" # note\nD=plain # note\nE\nMULTI=\"line1\nline2\"\nF=x\nA=dup\n";
  const env = core.parseEnv(tpl);
  check("env: keys parsed in order", [...env.keys()].join(",") === "A,B,C,D,E,MULTI,F", [...env.keys()].join(","));
  check("env: export prefix", env.get("B") === "two");
  check("env: quoted value kept with quotes, comment dropped", env.get("C") === '"quoted value"', env.get("C"));
  check("env: inline comment dropped", env.get("D") === "plain");
  check("env: bare key", env.has("E") && env.get("E") === "");
  check("env: multi-line value collapsed to empty", env.get("MULTI") === "");
  check("env: continuation line is not a key", !env.has("line2\""));
  check("env: first occurrence wins", env.get("A") === "1");
  const gained = core.gainedEnvKeys("A=1\nB=2\n", "A=1\nB=2\nC=3\nexport D=\n");
  check("env: gained keys", gained.map((k) => k.key + "=" + k.value).join(",") === "C=3,D=", JSON.stringify(gained));
  check("env: no gain when only values change", core.gainedEnvKeys("A=1\n", "A=2\n").length === 0);
  check("env: no gain when key removed", core.gainedEnvKeys("A=1\nB=1\n", "A=1\n").length === 0);
  const missing = core.missingEnvKeys("C=local\n# D=commented\n", gained);
  check("env: missing excludes keys already in .env", missing.map((k) => k.key).join(",") === "D", JSON.stringify(missing));
  const app = core.buildEnvAppend("X=1", [{ key: "D", value: "" }, { key: "E", value: "e" }], ".env.example");
  check("env: append adds newline, comment and keys", app === "\n# Added by AfterPull from .env.example\nD=\nE=e\n", JSON.stringify(app));
  check("env: CRLF preserved", core.buildEnvAppend("X=1\r\n", [{ key: "D", value: "" }], "t") === "# Added by AfterPull from t\r\nD=\r\n");
  check("env: nothing to append when nothing missing", core.buildEnvAppend("X=1\n", [], "t") === "");

  // toolchain.
  check("toolchain: .nvmrc", core.toolchainChange(".nvmrc", "18\n", "20\n") === "18 -> 20");
  check("toolchain: comment-only change is not a change", core.toolchainChange(".python-version", "3.11\n", "3.11\n# pinned\n") === null);
  check("toolchain: new file", core.toolchainChange(".node-version", null, "v22.1.0\n") === "(none) -> v22.1.0");
  check("toolchain: removed file", core.toolchainChange(".nvmrc", "18\n", null) === "18 -> (removed)");
  check("toolchain: rust-toolchain.toml channel", core.toolchainChange("rust-toolchain.toml", '[toolchain]\nchannel = "1.75.0"\n', '[toolchain]\nchannel = "1.80.0"\ncomponents = ["clippy"]\n') === "1.75.0 -> 1.80.0");
  check("toolchain: rust components only is not a change", core.toolchainChange("rust-toolchain.toml", '[toolchain]\nchannel = "stable"\n', '[toolchain]\nchannel = "stable"\ncomponents = ["rustfmt"]\n') === null);
  check("toolchain: .tool-versions per tool", core.toolchainChange(".tool-versions", "nodejs 18\npython 3.11\ngolang 1.21\n", "nodejs 20\npython 3.11\nruby 3.3\n") === "nodejs 18 -> 20, ruby (none) -> 3.3, golang 1.21 -> (removed)");

  // terraform.
  const mod = (v, extra) => `module "vpc" {\n  source  = "x/vpc/aws"\n  version = "${v}"\n  ${extra || ""}\n}\n`;
  check("tf: module version bump needs init", core.terraformInitNeeded(mod("5.0.0"), mod("5.1.0")));
  check("tf: module input change does not", !core.terraformInitNeeded(mod("5.0.0", 'cidr = "a"'), mod("5.0.0", 'cidr = "b"')));
  check("tf: resource change does not", !core.terraformInitNeeded('resource "a" "b" {\n  x = 1\n}\n', 'resource "a" "b" {\n  x = 2\n}\n'));
  check("tf: provider version (single-line object) needs init", core.terraformInitNeeded(
    'terraform {\n  required_providers {\n    aws = { source = "hashicorp/aws", version = "~> 5.0" }\n  }\n}\n',
    'terraform {\n  required_providers {\n    aws = { source = "hashicorp/aws", version = "~> 6.0" }\n  }\n}\n'));
  check("tf: backend change needs init", core.terraformInitNeeded('terraform {\n  backend "s3" {\n    bucket = "a"\n  }\n}\n', 'terraform {\n  backend "s3" {\n    bucket = "b"\n  }\n}\n'));
  check("tf: required_version alone does not", !core.terraformInitNeeded('terraform {\n  required_version = ">= 1.5"\n}\n', 'terraform {\n  required_version = ">= 1.6"\n}\n'));
  check("tf: new module block needs init", core.terraformInitNeeded("", mod("1.0.0")));
  check("tf: comments ignored", !core.terraformInitNeeded(mod("1.0.0"), "# note\n" + mod("1.0.0")));

  // globs.
  check("glob: ** matches nested", core.globToRegExp("proto/**/*.proto").test("proto/a/b/c.proto"));
  check("glob: no-slash pattern matches anywhere", core.globToRegExp("*.md").test("docs/x/y.md"));
  check("glob: dir pattern", core.globToRegExp("docs/").test("docs/a.md") && !core.globToRegExp("docs/").test("src/docs.md"));
  check("glob: {a,b}", core.globToRegExp("*.{yml,yaml}").test("a/b.yaml"));

  // reflog classification.
  check("reflog: own commit skipped", core.isOwnCommit("commit: fix bug") && core.isOwnCommit("commit (amend): x") && core.isOwnCommit("commit (initial): x"));
  for (const s of ["pull: Fast-forward", "merge feature: Fast-forward", "checkout: moving from a to b", "commit (merge): Merge branch x", "rebase (finish): returning to refs/heads/main", "reset: moving to origin/main", "pull --rebase (finish): returning to refs/heads/main"]) {
    check("reflog: not own commit: " + s, !core.isOwnCommit(s));
  }

  // ---------------------------------------------------------------- real repository
  const m = makeMainRepo(path.join(base, "main"));
  const res = await core.computeChores({ root: m.root, oldSha: m.oldSha, newSha: m.newSha, config: TEST_CONFIG });
  const C = res.chores;
  check("computeChores has no error", !res.error, res.error);
  check("no chore with a control character or escape in cwd", C.every((c) => c.cwd === "" || core.isSafeRelPath(c.cwd)));

  // AP001
  const rootJs = find(C, "AP001", "", "npm ci");
  check("AP001 root npm ci", !!rootJs);
  check("AP001 root merges lockfile + package.json + monorepo packages/lib", rootJs && ["package-lock.json", "package.json", "packages/lib/package.json"].every((f) => rootJs.files.includes(f)), rootJs && rootJs.files.join(","));
  check("AP001 api: deps change + unchanged pnpm lock -> pnpm install --frozen-lockfile", !!find(C, "AP001", "api", "pnpm install --frozen-lockfile"));
  check("AP001 berry: yarn --immutable when .yarnrc.yml exists", !!find(C, "AP001", "berry", "yarn install --immutable"));
  check("AP001 negative: web/package.json scripts-only change not flagged", !C.some((c) => c.cwd === "web" || c.files.includes("web/package.json")));
  check("AP001 negative: node_modules content skipped", !C.some((c) => c.files.some((f) => f.includes("node_modules/"))));
  check("ignore setting: examples/** skipped", !C.some((c) => c.files.some((f) => f.startsWith("examples/"))));
  check("ignore setting: docs/ skipped", !C.some((c) => c.files.some((f) => f.startsWith("docs/"))));
  // AP002
  check("AP002 poetry install", !!find(C, "AP002", "py", "poetry install"));
  check("AP002 uv sync", !!find(C, "AP002", "uvproj", "uv sync"));
  check("AP002 pipenv sync", !!find(C, "AP002", "pipenvproj", "pipenv sync"));
  check("AP002 pip with both requirement files", !!find(C, "AP002", "svc", "pip install -r requirements-dev.txt -r requirements.txt"), JSON.stringify(C.filter((c) => c.id === "AP002").map((c) => c.commandText)));
  check("AP002 negative: requirements.in not used", !C.some((c) => c.commandText.includes("requirements.in")));
  // AP003-AP006
  check("AP003 go mod download", !!find(C, "AP003", "gosvc", "go mod download"));
  check("AP004 cargo fetch", !!find(C, "AP004", "rust", "cargo fetch"));
  check("AP005 bundle install", !!find(C, "AP005", "ruby", "bundle install"));
  check("AP006 composer install", !!find(C, "AP006", "php", "composer install"));
  // AP007
  check("AP007 django (manage.py found above the app)", !!find(C, "AP007", "django", "python manage.py migrate"));
  check("AP007 alembic", !!find(C, "AP007", "", "alembic upgrade head"));
  check("AP007 prisma", !!find(C, "AP007", "", "npx prisma migrate dev"));
  check("AP007 rails", !!find(C, "AP007", "rails", "bin/rails db:migrate"));
  check("AP007 knex (knexfile found)", !!find(C, "AP007", "server", "npx knex migrate:latest"));
  check("AP007 flyway (pom.xml)", !!find(C, "AP007", "javaapp", "mvn flyway:migrate"));
  const generic = find(C, "AP007", "sqlmig");
  check("AP007 generic migrations dir without a command is info", generic && generic.kind === "info" && generic.files.join() === "sqlmig/migrations/002_more.sql");
  check("AP007 negative: modified migration not flagged (shop)", !C.some((c) => c.files.some((f) => f.startsWith("django/shop/"))));
  check("AP007 negative: modified 0001 in blog not listed", !C.some((c) => c.files.includes("django/blog/migrations/0001_initial.py")));
  check("AP007 negative: prisma migration_lock.toml not listed", !C.some((c) => c.files.some((f) => f.endsWith("migration_lock.toml"))));
  // AP008
  const envC = find(C, "AP008", "");
  check("AP008 env chore", envC && envC.kind === "env" && envC.env.target === ".env" && envC.env.template === ".env.example");
  check("AP008 gained keys with placeholders", envC && JSON.stringify(envC.env.keys) === JSON.stringify([{ key: "REDIS_URL", value: "redis://localhost:6379" }, { key: "FEATURE_FLAG", value: "" }, { key: "SECRET_KEY", value: '"change me"' }]), envC && JSON.stringify(envC.env.keys));
  const localEnv = fs.readFileSync(path.join(m.root, ".env"), "utf8");
  check("AP008 missing vs local .env skips REDIS_URL", core.missingEnvKeys(localEnv, envC.env.keys).map((k) => k.key).join() === "FEATURE_FLAG,SECRET_KEY");
  // AP009
  const dock = find(C, "AP009", "", "docker compose up -d --build");
  check("AP009 compose + Dockerfiles under a compose root merge", dock && dock.files.length === 3, dock && dock.files.join());
  // AP010
  check("AP010 .nvmrc 18 -> 20", C.some((c) => c.id === "AP010" && c.title === "Toolchain version changed: 18 -> 20" && c.kind === "info"));
  check("AP010 .tool-versions", C.some((c) => c.id === "AP010" && c.detail.includes("nodejs 18.19.0 -> 20.11.0") && c.detail.includes("terraform (none) -> 1.7.0")));
  check("AP010 rust-toolchain.toml", C.some((c) => c.id === "AP010" && c.cwd === "rs" && c.detail.includes("1.75.0 -> 1.80.0")));
  check("AP010 negative: .python-version comment-only", !C.some((c) => c.files.includes(".python-version")));
  // AP011
  const sub = find(C, "AP011", "", "git submodule update --init --recursive");
  check("AP011 submodules (gitmodules + gitlink)", sub && sub.files.includes(".gitmodules") && sub.files.includes("libs/sub"), sub && sub.files.join());
  // AP012
  check("AP012 lock.hcl", !!find(C, "AP012", "infra", "terraform init"));
  check("AP012 module version bump", !!find(C, "AP012", "infra2", "terraform init"));
  check("AP012 provider version bump", !!find(C, "AP012", "infra4", "terraform init"));
  check("AP012 negative: resource + module input change", !find(C, "AP012", "infra3"));
  // AP013
  const custom = C.find((c) => c.id === "AP013");
  check("AP013 custom rule", custom && custom.title === "Regenerate protobuf code" && custom.commandText === "make proto" && custom.cwd === "");
  check("AP013 negative: when=added rule not fired by modified README.md", !C.some((c) => c.commandText === "echo md"));
  check("AP013 negative: invalid rules ignored", !C.some((c) => c.commandText.startsWith("echo empty")));
  check("chore keys unique", new Set(C.map((c) => c.key)).size === C.length);

  // Overrides and disabled chores.
  const res2 = await core.computeChores({
    root: m.root, oldSha: m.oldSha, newSha: m.newSha,
    config: { commands: { npm: "npm install --no-audit", migrate: "make migrate", AP010: "mise install", docker: "docker compose up -d" }, disabledChores: ["AP005", "ap006"] },
  });
  const C2 = res2.chores;
  check("override npm", !!find(C2, "AP001", "", "npm install --no-audit"));
  check("override does not touch pnpm", !!find(C2, "AP001", "api", "pnpm install --frozen-lockfile"));
  check("override migrate makes generic migration runnable", (find(C2, "AP007", "sqlmig") || {}).commandText === "make migrate" && find(C2, "AP007", "sqlmig").kind === "task");
  check("override by chore code (AP010) makes toolchain a task", C2.some((c) => c.id === "AP010" && c.kind === "task" && c.commandText === "mise install"));
  check("override docker", !!find(C2, "AP009", "", "docker compose up -d"));
  check("disabledChores (case-insensitive)", !C2.some((c) => c.id === "AP005" || c.id === "AP006"));

  // A scripts-only change alone produces nothing.
  const s = path.join(base, "scripts-only");
  fs.mkdirSync(s);
  git(s, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(s, "package.json"), JSON.stringify({ scripts: { a: "1" }, dependencies: { x: "1" } }));
  fs.writeFileSync(path.join(s, "package-lock.json"), "{}");
  git(s, "add", "-A");
  git(s, "commit", "-q", "-m", "a");
  const s1 = git(s, "rev-parse", "HEAD").trim();
  fs.writeFileSync(path.join(s, "package.json"), JSON.stringify({ scripts: { a: "2", b: "3" }, dependencies: { x: "1" } }));
  git(s, "commit", "-q", "-am", "b");
  const s2 = git(s, "rev-parse", "HEAD").trim();
  const rs = await core.computeChores({ root: s, oldSha: s1, newSha: s2 });
  check("scripts-only repo: zero chores", rs.chores.length === 0, JSON.stringify(rs.chores.map((c) => c.id)));
  const back = await core.computeChores({ root: m.root, oldSha: m.newSha, newSha: m.oldSha });
  check("moving back (reverse checkout) also lists reinstall", !!find(back.chores, "AP001", "", "npm ci"));
  check("reverse: deleted migration is not a new migration", !back.chores.some((c) => c.id === "AP007"));
  check("same sha: nothing", (await core.computeChores({ root: m.root, oldSha: m.oldSha, newSha: m.oldSha })).chores.length === 0);
  const bad = await core.computeChores({ root: m.root, oldSha: "--output=/tmp/x", newSha: m.newSha });
  check("invalid sha rejected before git runs", bad.error === "invalid commit id" && bad.chores.length === 0);
  const unknown = await core.computeChores({ root: m.root, oldSha: "0".repeat(40), newSha: m.newSha });
  check("unknown sha: error, no crash", !!unknown.error && unknown.chores.length === 0);

  // Reflog
  git(m.root, "merge", "-q", "--ff-only", "feature");
  let rl = await core.lastReflog(m.root);
  check("reflog after merge: not own commit", rl && rl.sha === m.newSha && !core.isOwnCommit(rl.subject), JSON.stringify(rl));
  fs.writeFileSync(path.join(m.root, "local.txt"), "x");
  git(m.root, "add", "local.txt");
  git(m.root, "commit", "-q", "-m", "my change");
  rl = await core.lastReflog(m.root);
  check("reflog after local commit: own commit", rl && core.isOwnCommit(rl.subject), JSON.stringify(rl));

  // ---------------------------------------------------------------- hostile repository
  const outside = path.join(base, "outside");
  const markers = path.join(base, "markers");
  const h = makeHostileRepo(path.join(base, "hostile"), outside, markers);
  const hr = await core.computeChores({ root: h.root, oldSha: h.oldSha, newSha: h.newSha });
  const H = hr.chores;
  check("hostile: no error despite hostile config", !hr.error, hr.error);
  check("hostile: 40-hex branch name colliding with old sha does not change the diff", hr.fileCount === 8, String(hr.fileCount));
  check("hostile: diff.relative / noprefix / ignoreSubmodules ignored (paths are repo-relative)", H.some((c) => c.files.includes("cfg/.env.example")));
  check("hostile: option-like requirements file passed as ./-e.txt", H.some((c) => c.id === "AP002" && c.command.args.includes("./-e.txt")), JSON.stringify(H.filter((c) => c.id === "AP002").map((c) => c.command)));
  check("hostile: -rf directory is only a cwd, never an argument", H.some((c) => c.id === "AP001" && c.cwd === "-rf" && c.commandText === "npm ci"));
  check("hostile: newline path dropped", !H.some((c) => c.files.some((f) => /\n/.test(f)) || /\n/.test(c.cwd)));
  check("hostile: Dockerfile with no compose -> docker build -f Dockerfile .", H.some((c) => c.id === "AP009" && c.commandText === "docker build -f Dockerfile ."));
  const he = H.find((c) => c.id === "AP008" && c.cwd === "");
  check("hostile: injected-looking placeholder kept as inert text", he && he.env.keys.some((k) => k.key === "INJECTED" && k.value === "$(touch /tmp/should-not-exist)"));
  const hostileBranch = await core.computeChores({ root: h.root, oldSha: "feature/$(touch${IFS}pwned)", newSha: h.newSha });
  check("hostile: branch name instead of sha rejected", hostileBranch.error === "invalid commit id");
  check("hostile: no pwned file", !fs.existsSync(path.join(h.root, "pwned")) && !fs.existsSync("/tmp/should-not-exist"));
  const hrl = await core.lastReflog(h.root);
  check("hostile: reflog read works with pager config", hrl && core.isSha(hrl.sha));
  check("hostile: no marker files (fsmonitor, pager, external diff, textconv)", fs.readdirSync(markers).length === 0, fs.readdirSync(markers).join(","));
  check("hostile: outside files untouched", fs.readFileSync(path.join(outside, "outside.env"), "utf8") === "OUTSIDE_SECRET=do-not-touch\n");

  console.log(`\ncore tests: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.log("FAIL unexpected exception :: " + (e && e.stack ? e.stack : e));
  process.exit(1);
});
