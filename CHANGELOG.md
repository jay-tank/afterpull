# Changelog

## 0.1.1

- AfterPull now has its own icon in the activity bar, with a badge for the number of pending chores. The view moved there from the Source Control side bar and is now called **Chores**; it groups chores by repository when several have some.
- Empty states for an untrusted workspace (with Manage Workspace Trust), AfterPull turned off (with a settings link), no git repository (with Open Folder) and nothing to do after the last pull (what it detects, with Pull and Add your own rules buttons).

## 0.1.0 - Initial release

- Watches the HEAD of every repository in the workspace through the built-in Git extension. When it moves (pull, merge, checkout, rebase, reset) the old and new HEAD are diffed and the after-pull chores are listed. Your own new commits (reflog `commit:` / `commit (amend):`) are skipped.
- Chores AP001-AP013: JavaScript dependencies (npm, Yarn classic and Berry, pnpm, Bun, picked by lockfile, dependency sections of `package.json` compared so a scripts-only change is ignored), Python (Poetry, uv, pip, Pipenv), Go, Cargo, Bundler, Composer, newly added migrations (Django, Alembic, Prisma, Rails, Knex, Flyway, generic), new `.env.example` keys missing from your `.env`, Dockerfile / compose changes, toolchain version files (`.nvmrc`, `.tool-versions`, `rust-toolchain.toml` and more, with old -> new versions), submodules, Terraform lock / module / provider changes, and custom rules.
- AfterPull view in the Source Control side bar with Run, Run all (modal listing every command first), Add missing keys to .env, and Dismiss. Commands run as visible VS Code Tasks in the chore's folder; exit code 0 marks a chore done.
- Notification ("AfterPull: 3 things to do after this pull") and a status bar count.
- Settings: `enabled`, `notify`, `ignore`, `disabledChores`, `commands` (per tool or chore code), `rules`.
- Security: nothing runs without a click; hardened git calls (no shell, validated commit ids, global/system config ignored, `core.fsmonitor` off, no pager / external diff / textconv, capped output); task folders and the `.env` target confined to the repository (symlinks out are refused); `commands` and `rules` ignored in untrusted workspaces; nothing runs in an untrusted workspace. No network access, no telemetry.
