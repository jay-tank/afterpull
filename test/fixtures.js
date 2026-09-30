"use strict";

// Builds throwaway git repositories for the AfterPull tests. The main repository has a
// baseline commit on "main" and a "feature" branch one commit ahead that touches every rule
// (plus negatives). main stays checked out, so moving HEAD to feature is "the pull".

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const GIT_ENV = Object.assign({}, process.env, {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
});

/** Hardened git for the harness itself: no global config, fsmonitor off, hooks off. */
function git(cwd, ...args) {
  return execFileSync("git", ["-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null", "--no-pager"].concat(args), {
    cwd,
    env: GIT_ENV,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString("utf8");
}

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function pkg(obj) {
  return JSON.stringify(obj, null, 2) + "\n";
}

function commitAll(root, msg) {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", msg);
  return git(root, "rev-parse", "HEAD").trim();
}

/**
 * Main fixture. Returns { root, oldSha, newSha }. HEAD is left on main (= oldSha) and the
 * "feature" branch points at newSha.
 */
function makeMainRepo(root) {
  fs.mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");

  // ---- Baseline (commit A) ----
  write(root, ".gitignore", ".env\nnode_modules/\n");
  write(root, "package.json", pkg({ name: "root", version: "1.0.0", scripts: { test: "x" }, dependencies: { a: "1.0.0" } }));
  write(root, "package-lock.json", pkg({ lockfileVersion: 3, packages: { "node_modules/a": { version: "1.0.0" } } }));
  write(root, "web/package.json", pkg({ name: "web", scripts: { build: "old" }, dependencies: { react: "18.0.0" } }));
  write(root, "web/yarn.lock", "# yarn lockfile v1\nreact@18.0.0:\n  version 18.0.0\n");
  write(root, "api/package.json", pkg({ name: "api", dependencies: { express: "4.0.0" } }));
  write(root, "api/pnpm-lock.yaml", "lockfileVersion: '6.0'\n");
  write(root, "berry/package.json", pkg({ name: "berry" }));
  write(root, "berry/yarn.lock", "__metadata:\n  version: 6\n");
  write(root, "berry/.yarnrc.yml", "nodeLinker: node-modules\n");
  write(root, "packages/lib/package.json", pkg({ name: "lib", dependencies: {} }));
  write(root, "py/poetry.lock", "# poetry\n");
  write(root, "svc/requirements-dev.txt", "pytest==7.0\n");
  write(root, "svc/requirements.in", "pytest\n");
  write(root, "uvproj/uv.lock", "version = 1\n");
  write(root, "pipenvproj/Pipfile.lock", "{}\n");
  write(root, "gosvc/go.mod", "module x\n\ngo 1.21\n");
  write(root, "gosvc/go.sum", "");
  write(root, "rust/Cargo.lock", "version = 3\n");
  write(root, "ruby/Gemfile.lock", "GEM\n");
  write(root, "php/composer.lock", "{}\n");
  write(root, "django/manage.py", "# manage\n");
  write(root, "django/blog/migrations/__init__.py", "");
  write(root, "django/blog/migrations/0001_initial.py", "# initial\n");
  write(root, "django/shop/migrations/0001_initial.py", "# shop initial\n");
  write(root, "alembic.ini", "[alembic]\n");
  write(root, "alembic/versions/001_base.py", "# base\n");
  write(root, "prisma/schema.prisma", "// schema\n");
  write(root, "rails/db/migrate/20260101000000_base.rb", "# base\n");
  write(root, "server/knexfile.js", "module.exports = {};\n");
  write(root, "server/migrations/20260101_base.js", "// base\n");
  write(root, "javaapp/pom.xml", "<project/>\n");
  write(root, "sqlmig/migrations/001_base.sql", "-- base\n");
  write(root, ".env.example", "# config\nDB_URL=postgres://localhost/app\nexport API_PORT=3000\n");
  write(root, "docker-compose.yml", "services:\n  app:\n    image: app:1\n");
  write(root, "worker/Dockerfile", "FROM node:18\n");
  write(root, "solo/Dockerfile.dev", "FROM alpine:3.18\n");
  write(root, ".nvmrc", "18\n");
  write(root, ".tool-versions", "nodejs 18.19.0\npython 3.11.4\n");
  write(root, "rs/rust-toolchain.toml", "[toolchain]\nchannel = \"1.75.0\"\n");
  write(root, ".python-version", "3.11\n");
  write(root, "infra/.terraform.lock.hcl", "# lock\n");
  write(root, "infra2/main.tf", 'module "vpc" {\n  source  = "terraform-aws-modules/vpc/aws"\n  version = "5.0.0"\n  cidr    = "10.0.0.0/16"\n}\n');
  write(root, "infra3/main.tf", 'resource "aws_s3_bucket" "b" {\n  bucket = "one"\n}\nmodule "vpc" {\n  source = "./vpc"\n  cidr   = "10.0.0.0/16"\n}\n');
  write(root, "infra4/versions.tf", 'terraform {\n  required_providers {\n    aws = {\n      source  = "hashicorp/aws"\n      version = "~> 5.0"\n    }\n  }\n}\n');
  write(root, "proto/api/v1/user.proto", "syntax = \"proto3\";\n");
  write(root, "docs/guide.md", "# guide\n");
  write(root, "examples/demo/package-lock.json", "{}\n");
  write(root, "README.md", "# fixture\n");
  const oldSha = commitAll(root, "baseline");

  // ---- Feature (commit B) ----
  git(root, "checkout", "-q", "-b", "feature");
  // AP001 root: lockfile + deps.
  write(root, "package.json", pkg({ name: "root", version: "1.0.0", scripts: { test: "x" }, dependencies: { a: "1.1.0" } }));
  write(root, "package-lock.json", pkg({ lockfileVersion: 3, packages: { "node_modules/a": { version: "1.1.0" } } }));
  // Negative: scripts-only and version-only change.
  write(root, "web/package.json", pkg({ name: "web", version: "2.0.0", scripts: { build: "new" }, dependencies: { react: "18.0.0" } }));
  // AP001 api: deps changed, lockfile (pnpm) unchanged.
  write(root, "api/package.json", pkg({ name: "api", dependencies: { express: "4.0.0", zod: "3.0.0" } }));
  // AP001 berry: yarn.lock changed with .yarnrc.yml -> --immutable.
  write(root, "berry/yarn.lock", "__metadata:\n  version: 6\n\"left-pad@npm:1.0.0\":\n");
  // AP001 monorepo: packages/lib deps changed, nearest lock is the root package-lock.json.
  write(root, "packages/lib/package.json", pkg({ name: "lib", dependencies: { lodash: "4.0.0" } }));
  // Skipped: node_modules content is never considered.
  write(root, "node_modules/x/package-lock.json", "{}\n");
  git(root, "add", "-f", "node_modules/x/package-lock.json");
  // AP002.
  write(root, "py/poetry.lock", "# poetry 2\n");
  write(root, "svc/requirements-dev.txt", "pytest==8.0\n");
  write(root, "svc/requirements.txt", "flask==3.0\n");
  write(root, "svc/requirements.in", "pytest\nflask\n");
  write(root, "uvproj/uv.lock", "version = 1\n# 2\n");
  write(root, "pipenvproj/Pipfile.lock", "{\"x\": 1}\n");
  // AP003-AP006.
  write(root, "gosvc/go.sum", "example.com/x v1.0.0 h1:abc\n");
  write(root, "rust/Cargo.lock", "version = 3\n# 2\n");
  write(root, "ruby/Gemfile.lock", "GEM\n  rails\n");
  write(root, "php/composer.lock", "{\"a\": 1}\n");
  // AP007 migrations: added (flagged) and modified (not flagged).
  write(root, "django/blog/migrations/0002_add_title.py", "# add title\n");
  write(root, "django/blog/migrations/0001_initial.py", "# initial, edited\n");
  write(root, "django/shop/migrations/0001_initial.py", "# shop initial, edited\n");
  write(root, "alembic/versions/002_users.py", "# users\n");
  write(root, "prisma/migrations/20260901_init/migration.sql", "CREATE TABLE x();\n");
  write(root, "prisma/migrations/migration_lock.toml", "provider = \"postgresql\"\n");
  write(root, "rails/db/migrate/20260901000000_add_users.rb", "# users\n");
  write(root, "server/migrations/20260901_add.js", "// add\n");
  write(root, "javaapp/src/main/resources/db/migration/V2__add.sql", "-- v2\n");
  write(root, "sqlmig/migrations/002_more.sql", "-- more\n");
  write(root, "sqlmig/migrations/001_base.sql", "-- base edited\n");
  // AP008 .env template gains keys.
  write(root, ".env.example", "# config\nDB_URL=postgres://localhost/app\nexport API_PORT=3000\nREDIS_URL=redis://localhost:6379\nFEATURE_FLAG=\nSECRET_KEY=\"change me\" # comment\n");
  // AP009.
  write(root, "docker-compose.yml", "services:\n  app:\n    image: app:2\n");
  write(root, "worker/Dockerfile", "FROM node:20\n");
  write(root, "solo/Dockerfile.dev", "FROM alpine:3.20\n");
  // AP010.
  write(root, ".nvmrc", "20\n");
  write(root, ".tool-versions", "nodejs 20.11.0\npython 3.11.4\nterraform 1.7.0\n");
  write(root, "rs/rust-toolchain.toml", "[toolchain]\nchannel = \"1.80.0\"\n");
  write(root, ".python-version", "3.11\n# pinned\n"); // same effective version: not flagged
  // AP011: .gitmodules + gitlink.
  write(root, ".gitmodules", '[submodule "libs/sub"]\n\tpath = libs/sub\n\turl = ./sub\n');
  // AP012.
  write(root, "infra/.terraform.lock.hcl", "# lock 2\n");
  write(root, "infra2/main.tf", 'module "vpc" {\n  source  = "terraform-aws-modules/vpc/aws"\n  version = "5.1.0"\n  cidr    = "10.0.0.0/16"\n}\n');
  write(root, "infra3/main.tf", 'resource "aws_s3_bucket" "b" {\n  bucket = "two"\n}\nmodule "vpc" {\n  source = "./vpc"\n  cidr   = "10.1.0.0/16"\n}\n'); // not flagged
  write(root, "infra4/versions.tf", 'terraform {\n  required_providers {\n    aws = { source = "hashicorp/aws", version = "~> 6.0" }\n  }\n}\n');
  // AP013 custom rule target.
  write(root, "proto/api/v1/user.proto", "syntax = \"proto3\";\nmessage U {}\n");
  // Ignored by the ignore setting in tests.
  write(root, "examples/demo/package-lock.json", "{\"v\": 2}\n");
  write(root, "docs/guide.md", "# guide 2\n");
  git(root, "add", "-A");
  git(root, "update-index", "--add", "--cacheinfo", "160000," + oldSha + ",libs/sub");
  git(root, "commit", "-q", "-m", "feature work");
  const newSha = git(root, "rev-parse", "HEAD").trim();
  git(root, "checkout", "-q", "main");
  // Local, untracked .env with one existing key (a secret value that must never be shown).
  write(root, ".env", "DB_URL=postgres://user:hunter2@db/app\nREDIS_URL=redis://custom:6380\n");
  return { root, oldSha, newSha };
}

/**
 * Hostile fixture: .env symlinked outside the workspace, weird branch names, a 40-hex branch
 * name that collides with a commit id, file names that look like options, and hostile
 * repo-local git config that would create marker files if honored.
 */
function makeHostileRepo(root, outsideDir, markerDir, opts) {
  const execHooks = !opts || opts.execHooks !== false;
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.mkdirSync(markerDir, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  write(root, "README.md", "hostile\n");
  write(root, ".env.example", "A=1\n");
  write(root, "cfg/.env.example", "B=1\n");
  write(root, "requirements/base.txt", "x\n");
  write(root, "package.json", pkg({ name: "h", dependencies: { a: "1" } }));
  const oldSha = commitAll(root, "baseline");

  git(root, "checkout", "-q", "-b", "feature/$(touch${IFS}pwned)");
  write(root, ".env.example", "A=1\nINJECTED=$(touch /tmp/should-not-exist)\n");
  write(root, "cfg/.env.example", "B=1\nC=2\n");
  write(root, "requirements/-e.txt", "x\n");
  write(root, "requirements/base.txt", "y\n");
  write(root, "-rf/package-lock.json", "{}\n");
  write(root, "evil\nname/go.sum", "x\n");
  write(root, "package.json", pkg({ name: "h", dependencies: { a: "2" } }));
  write(root, "Dockerfile", "FROM scratch\n");
  const newSha = commitAll(root, "hostile feature");
  // A branch whose name is the old commit id but which points at the new commit.
  git(root, "branch", oldSha, newSha);
  git(root, "checkout", "-q", "main");

  // Outside files that must never be read or written.
  write(outsideDir, "outside.env", "OUTSIDE_SECRET=do-not-touch\n");
  write(outsideDir, "cfg.env", "OUTSIDE=1\n");
  fs.symlinkSync(path.join(outsideDir, "outside.env"), path.join(root, ".env"));
  // A directory symlink out of the repo, and cfg/.env reaching outside through it.
  fs.symlinkSync(outsideDir, path.join(root, "linkdir"));
  fs.symlinkSync(path.join("..", "linkdir", "cfg.env"), path.join(root, "cfg", ".env"));

  const m = (n) => path.join(markerDir, n);
  if (execHooks) {
    git(root, "config", "core.fsmonitor", `touch '${m("fsmonitor")}'; echo`);
    git(root, "config", "core.pager", `touch '${m("pager")}'; cat`);
    git(root, "config", "pager.show", `touch '${m("pager-show")}'; cat`);
    git(root, "config", "diff.external", `sh -c "touch '${m("extdiff")}'"`);
    git(root, "config", "diff.fx.textconv", `sh -c "touch '${m("textconv")}'; cat"`);
    fs.writeFileSync(path.join(root, ".git", "info", "attributes"), "* diff=fx\n");
  }
  git(root, "config", "diff.noprefix", "true");
  git(root, "config", "diff.relative", "true");
  git(root, "config", "diff.renames", "copies");
  git(root, "config", "diff.ignoreSubmodules", "all");
  git(root, "config", "color.ui", "always");
  git(root, "config", "core.quotePath", "false");
  return { root, oldSha, newSha };
}

module.exports = { git, write, makeMainRepo, makeHostileRepo, GIT_ENV };
