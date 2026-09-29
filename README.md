<h1 align="center">AfterPull</h1>

<p align="center"><b>The "what do I need to run after this pull" checklist, worked out for you.</b><br>
New dependencies, new migrations, new <code>.env</code> keys, changed Dockerfiles, bumped <code>.nvmrc</code>, moved submodules, new Terraform providers - listed in one panel after every pull, merge, checkout or rebase. One click per command, nothing runs on its own, no network.</p>

## The problem

You pull `main` after lunch and the app will not start. `Cannot find module 'zod'` - a
teammate added a dependency and you did not reinstall. You fix that and the API returns
`relation "invoices" does not exist` - there was a new migration too. Then the payment
page crashes because `STRIPE_WEBHOOK_SECRET` is undefined: someone added it to
`.env.example`, but your own `.env` never heard of it. And the worker container is still
running last week's image because `docker-compose.yml` changed.

None of this is hard to fix. It is just easy to forget, because nothing tells you that the
pull you just did needs any of it. Teams write it down in a wiki ("after pulling, run...")
or try a `post-merge` git hook that every developer has to install by hand, and that does
not fire on `checkout` or `rebase` the same way.

AfterPull watches the HEAD of every repository in your workspace. When it moves, it diffs
the old HEAD against the new one and lists the chores that the change actually needs.

Further reading:

- npm Docs: [npm ci](https://docs.npmjs.com/cli/v10/commands/npm-ci) - why a clean install from the lockfile is the right command after someone else changed it.
- Git: [githooks](https://git-scm.com/docs/githooks) - `post-merge` and `post-checkout`, the per-clone hooks teams usually reach for.
- Django: [Migrations](https://docs.djangoproject.com/en/5.1/topics/migrations/) - new migration files in a pull do nothing until you run `migrate`.

## What it shows

- **Notification**: `AfterPull: 3 things to do after this pull` with a **Show** button.
- **Activity bar**: an AfterPull icon on the left, with a badge showing how many chores are
  pending. Click it for the **Chores** view: one row per chore with the command and the
  folder it runs in, grouped by repository when several have chores. Hover a row for the
  reason and the files that triggered it. When there is nothing to do, no git repository or
  the workspace is untrusted, the view says so.
  - **Run** (play button) starts that one command as a visible VS Code Task in the right
    folder. When the task exits with code 0 the chore is marked done; a non-zero exit marks
    it failed.
  - **Run all** first shows a modal with every command it is about to run, then runs them one
    after the other as tasks and stops at the first failure.
  - **Add missing keys to .env** appends the new keys to your `.env`.
  - **Dismiss** removes a chore you do not need.
- **Status bar**: `AfterPull: 3` while anything is left. Click it to open the view.

Nothing is ever run automatically. A new commit you make yourself does not count as a
pull (AfterPull reads the reflog), so committing your own lockfile change does not ask you
to reinstall.

## Chores

Every changed path is checked, in any folder, so monorepos work: each chore runs in the
folder where its file lives (for example `services/api/`).

| Code | Triggered by | Suggested command |
| --- | --- | --- |
| **AP001** | `package-lock.json` / `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb` / `bun.lock` changed, or a `package.json` whose **dependency sections** changed (`dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies`, `overrides`, `resolutions`, `workspaces`, `packageManager`). A change to `scripts` or `version` only is ignored. | `npm ci`, `yarn install --frozen-lockfile` (`--immutable` for Yarn 2+ with `.yarnrc.yml`), `pnpm install --frozen-lockfile` or `bun install`, picked by the lockfile. For a workspace package it walks up to the lockfile folder. No lockfile: `npm install`. |
| **AP002** | `poetry.lock`, `uv.lock`, `Pipfile.lock`, `requirements*.txt`, `requirements/*.txt` | `poetry install`, `uv sync`, `pipenv sync`, `pip install -r <file>` |
| **AP003** | `go.mod` / `go.sum` | `go mod download` |
| **AP004** | `Cargo.lock` | `cargo fetch` |
| **AP005** | `Gemfile.lock` | `bundle install` |
| **AP006** | `composer.lock` | `composer install` |
| **AP007** | **Newly added** migration files (a modified migration is not flagged): Django `*/migrations/*.py`, Alembic `alembic/versions/`, Prisma `prisma/migrations/*/migration.sql`, Rails `db/migrate/`, Knex `migrations/*.js` next to a `knexfile`, Flyway `src/main/resources/db/migration/`, or any other `migrations/` folder | `python manage.py migrate` (in the folder with `manage.py`), `alembic upgrade head`, `npx prisma migrate dev`, `bin/rails db:migrate`, `npx knex migrate:latest`, `mvn flyway:migrate` / `gradle flywayMigrate`. Other folders: set `afterpull.commands.migrate`. |
| **AP008** | `.env.example`, `.env.sample` or `.env.template` gained keys that your local `.env` in the same folder does not have | **Add missing keys to .env** appends `KEY=<placeholder from the template>` lines. Existing keys are never changed. Not listed when that folder has no `.env` at all. |
| **AP009** | `Dockerfile*`, `*.dockerfile`, `Containerfile`, `compose*.y*ml`, `docker-compose*.y*ml` | `docker compose up -d --build` in the compose folder (or `docker compose -f <file> ...` for a non-default file name). A Dockerfile with no compose file above it: `docker build -f <file> .` |
| **AP010** | `.nvmrc`, `.node-version`, `.python-version`, `.ruby-version`, `.go-version`, `.terraform-version`, `.tool-versions`, `rust-toolchain(.toml)` | A note such as `Toolchain version changed: 18 -> 20` (both versions are read from git). A comment-only change is ignored. |
| **AP011** | `.gitmodules` or a submodule pointer changed | `git submodule update --init --recursive` |
| **AP012** | `.terraform.lock.hcl`, or a `*.tf` file whose module `source` / `version`, `required_providers` or `backend` changed (a resource or module-input change does not count) | `terraform init` |
| **AP013** | Your own rules from `afterpull.rules` | Your command |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `afterpull.enabled` | `true` | Turn AfterPull on or off. |
| `afterpull.notify` | `true` | Show a notification when a HEAD move produces new chores. |
| `afterpull.ignore` | `[]` | Repository-relative globs that are never considered, for example `["examples/**", "fixtures/"]`. A pattern without a slash matches the file name anywhere. |
| `afterpull.disabledChores` | `[]` | Chore codes to turn off, for example `["AP010"]`. |
| `afterpull.commands` | `{}` | Replace a suggested command. Keys are tool names (`npm`, `yarn`, `pnpm`, `bun`, `poetry`, `uv`, `pip`, `pipenv`, `go`, `cargo`, `bundler`, `composer`, `django`, `alembic`, `prisma`, `rails`, `knex`, `flyway`, `migrate`, `docker`, `dockerBuild`, `submodules`, `terraform`) or chore codes (`AP010`). Example: `{"npm": "npm install", "docker": "make up", "migrate": "make migrate", "AP010": "mise install"}`. |
| `afterpull.rules` | `[]` | Your own chores: `[{"glob": "proto/**/*.proto", "command": "make proto", "label": "Regenerate protobuf code"}]`. Optional `"cwd": "file"` runs it in the changed file's folder (default: repository root), `"when": "added"` fires only for new files. |

`afterpull.commands` and `afterpull.rules` are ignored in untrusted workspaces, so a
repository's own `.vscode/settings.json` cannot plant a command before you trust it.

## Commands

- **AfterPull: Show chores** - opens the view (also the status bar click).
- **AfterPull: Run all** - modal with the full list of commands, then runs them in order.
- **AfterPull: Dismiss all** - clears the list.
- Per row: **Run**, **Add missing keys to .env**, **Dismiss**.

## Prior art

- **Refresh NPM Packages** and **Lock File Notifier** tell you that an npm lockfile changed
  and offer to reinstall. They cover the JavaScript lockfile case only.
- `post-merge` / `post-checkout` git hooks (and tools that install them) can run commands
  after a pull, but they must be set up in every clone and run without asking.

AfterPull covers the whole after-pull checklist across ecosystems (dependencies in twelve
package managers, migrations, `.env` drift, containers, toolchains, submodules, Terraform)
in one panel, and only ever runs a command when you click it.

## Privacy and safety

- **No network, no telemetry.** Everything is computed locally from your own git history.
- **Nothing runs by itself.** Commands start only as visible VS Code Tasks after your click;
  **Run all** lists every command in a modal first.
- **Workspace Trust.** AfterPull does nothing in an untrusted workspace (the built-in Git
  extension it builds on is disabled there too) and starts once you trust it.
- **Hardened git calls.** `git` is started without a shell, with an argument list; commits
  are passed only as validated full object ids; global and system git config are ignored;
  `core.fsmonitor` is forced off; pagers, external diff tools and textconv filters are
  disabled; output size and run time are capped. Branch names are never put on a command
  line.
- **Stays inside your workspace.** Only repositories inside an open workspace folder are
  watched. Every task folder is resolved and must stay inside the repository. The `.env`
  edit is refused when the file (or its folder) is a symlink pointing outside the
  repository. File names that look like options are passed as `./-name`. Values from your
  `.env` are never shown - only key names.

## Limitations

- AfterPull compares the HEAD before and after the move. If VS Code was closed while you
  pulled, it has nothing to compare with; the next move is detected normally.
- During a long rebase, intermediate HEADs are collapsed into one comparison after the
  rebase settles.
- Detection is by file name and a light look at the content (package.json dependency
  sections, `.env` keys, Terraform module and provider blocks). It is a checklist, not a
  build system: a generated file or a custom script that also needs re-running will only
  show up if you add a rule for it.
- Only migrations added as new files are reported, so a squashed or edited migration is not.
- The `.env` check looks at the `.env` in the same folder as the template. Other file names
  (`.env.local`, `.env.development`) are not edited.
- Only repositories the built-in Git extension has opened are watched.

## License

MIT - included with the extension.
