# GitController

Desktop git client for people who juggle many repositories. It brings as much
automation as possible so that everyday git is fast and friendly: no need to drive an interactive
rebase by hand to squash, reorder or reword commits. It also understands workspaces managed by
Google's `repo` tool (git-repo).

Targets Windows and Linux (macOS later).

## Status

Steps 1 and 2 of the roadmap are in place: the multi-repository workspace and the repository view.

- Add repositories from a folder dialog or by dropping folders onto the window. A folder that is not
  a repository is searched for the repositories it contains (a folder of projects, a git-repo
  workspace…).
- One tab per repository, plus an overview tab. Tabs can be dragged to reorder, closed with the
  middle button or Ctrl+W, and are remembered between sessions. A closed tab's repository stays in
  the overview, where a click opens it again; removing it from the workspace is a separate command.
- The overview shows every repository at a glance: branch, commits to push or pull, changes,
  conflicts, operation left in progress (rebase, merge…), stashes and last commit. It can be searched
  (name, path, branch, upstream, last commit; several words all have to match, case and accents are
  ignored) and filtered (changes, to sync, needs attention).
- The repository tab shows the history of every branch, remote branch and tag as a commit graph,
  with a working-copy row on top. Selecting a commit shows its message, author and files; selecting
  a file shows its diff in a panel below the graph, which can be folded or enlarged to the whole
  centre. The diff is shown in one column or side by side, before on the left and after on the right
  (Alt+5); the choice is remembered.
- Commits are searched with Ctrl+F through the whole history, every branch and tag included, not
  only the commits drawn: by message, author, commit id, changed file or changed code, with case
  matching and regular expressions. Matches are highlighted and the other commits fade, or only the
  matches are listed; Enter, F3 and Shift+F3 move from one to the next.
- Images (PNG, JPEG, GIF, WebP, SVG…) are shown before and after, side by side, in place of a
  binary diff. Markdown and HTML files switch between their diff and a formatted preview; HTML is
  rendered in a sandboxed frame where scripts never run.
- The side panels (branches, working copy or commit details) and the diff panel are resized with
  their splitters and folded with the strip along their edge, a double click on the splitter or
  Alt+1 to Alt+4; the layout is remembered.
- A branch can be created from any commit of the graph (right click, or the button shown on hover):
  local changes are stashed, the new branch is checked out and the changes are applied again.
- Each repository can be given a colour (right click on its tab or its card),
  used for its avatar, its tab and its card.
- Staging by file or by hunk, discarding changes (with confirmation), and committing with a summary
  counter. With nothing staged, the commit button stages everything. Amending loads the last message.
- Branches in a side panel: double-click to switch (a remote branch becomes a local tracking branch),
  create from HEAD, delete (asks again to force an unmerged branch). Local changes can be brought
  along when switching.
- Fetch, pull and push in one click. Pull fast-forwards when it can and asks between rebase and merge
  when the branch has diverged; push sets the upstream on the first push and offers to pull first or
  force with lease when it is rejected. Local changes are stashed and restored automatically.
- Every repository is read again when the window regains focus, in parallel.
- English (default) or French interface, light or dark theme, splash screen.

## Roadmap

1. Foundation and multi-repository workspace (done).
2. Repository view: commit graph, diffs, staging and commit, branches, fetch / pull / push (done).
3. Automation: squash, fixup, reword and reorder without an interactive rebase, undo based on the
   reflog, help with conflict resolution.
4. git-repo: manifest detection, `repo sync`, `repo start` and a global status of all projects.

## Layout

| Folder | Role |
| --- | --- |
| `crates/core` | Runs git and reads repositories: status (porcelain v2), history and graph layout, diffs, file contents, staging and commits, branches, fetch / pull / push, history search, repository discovery on disk. No dependency on the interface or the storage. |
| `crates/storage` | The workspace (`workspace.json` in the user's data folder): repositories in tab order and the active one, written atomically. |
| `crates/gui` | Tauri 2 application: commands called by the interface (`src/commands`). |
| `crates/gui/ui` | Interface in HTML, CSS and JavaScript (ES modules, no framework, no bundler). |
| `crates/gui/ui/vendor` | Third-party code, kept as published: [marked](https://github.com/markedjs/marked) (MIT) for the Markdown preview. |

The Rust side is the single source of truth: each command returns a snapshot (repositories and their
state) that the interface displays without computing anything itself.

Every git operation goes through the `git` command line rather than a library, so GitController
behaves exactly like the user's own git: same configuration, credentials, hooks, worktrees and
`repo` integration. Git calls never open a console window on Windows, never wait for a prompt, and
never take the index lock when they only read.

## Requirements

- Git on the PATH (Git for Windows on Windows).
- Rust (stable) and the Tauri 2 prerequisites: WebView2 on Windows (already present on Windows 10/11),
  `libwebkit2gtk-4.1-dev`, `libgtk-3-dev` and `librsvg2-dev` on Linux.

## Build and run

```sh
cargo run -p gitcontroller          # the application
cargo test --workspace              # tests (they create temporary repositories with git)
```

Design preview without Rust: serve `crates/gui/ui` with any static server (for example
`python -m http.server 5179 --directory crates/gui/ui`) and open it in a browser. A fake backend with
sample repositories takes over (`ui/js/api/mock`).

On some Linux machines (virtual machines, some GPU drivers) WebKitGTK shows a blank window; starting
the application with `WEBKIT_DISABLE_DMABUF_RENDERER=1` fixes it.
