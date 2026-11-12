# Ramelo

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
  Tabs can be pinned: they stay at the start, always in view, without a close button. When the
  other tabs do not fit, they scroll (wheel or arrows) and a list of all open tabs finds one by name
  or path (Ctrl+Shift+A). The right click on a tab also closes the others, those to its right, or
  all of them except the pinned ones (Ctrl+Shift+W). All the repositories can be removed from the
  workspace at once (File menu, or the bin in the overview, which takes only those shown when a
  filter or a search is on); their folders on disk are not touched.
- A repository can be cloned from its address (File menu, Ctrl+Shift+O, the overview or the + after
  the tabs): the folder it goes into, its name there, and optionally a branch and the submodules.
  Git's progress shows while it runs and the clone can be stopped; it then opens in its own tab.
- The overview shows every repository at a glance: branch, commits to push or pull, changes,
  conflicts, operation left in progress (rebase, merge…), stashes and last commit. It can be searched
  (name, path, branch, upstream, last commit; several words all have to match, case and accents are
  ignored) and filtered (changes, to sync, needs attention).
  Repositories can be filed under sections (a team, a product…): right click on a card or a tab ›
  Section, or drag a card from one section to another. Sections fold, are renamed, removed (their
  repositories stay, in no section) and reordered by dragging their header. A search unfolds them so
  that no match stays hidden.
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
- A past commit of the current branch can be corrected without an interactive rebase: its message
  (button in its details, or right click in the graph), or the content of one of its files (Edit in
  the diff of that file). The commits after it are written again, keeping their own changes, and the
  working copy follows; a conflict with a later commit leaves everything as it was. A commit already
  pushed can be rewritten too: the dialog says which remote branches have it and that a force push
  (with lease) will be needed.
- A commit can be combined with the one before it (right click in the graph): squash, with a message
  to edit that starts from both, or fixup, which keeps the message of the commit before. Merges, the
  first commit, and a commit whose parent also starts another line cannot be combined.
- A merge, rebase, cherry-pick or revert that stops on conflicts shows a banner to continue it, skip
  the commit (rebase, cherry-pick) or abort it. A conflicted file opens in a conflict editor: both
  sides of each conflict next to each other, settled in one click (one side, or both in either
  order), and below the resulting file, which can also be edited by hand before marking it resolved.
  A binary file, or one deleted on one side, is settled by keeping one side as it is.
- Staging by file or by hunk, discarding changes (with confirmation), and committing with a summary
  counter. With nothing staged, the commit button stages everything. Amending loads the last message.
- Branches in a side panel: double-click to switch (a remote branch becomes a local tracking branch),
  create from HEAD, delete (asks again to force an unmerged branch). Local changes can be brought
  along when switching.
- Fetch, pull and push in one click. Pull fast-forwards when it can and asks between rebase and merge
  when the branch has diverged; push sets the upstream on the first push and offers to pull first or
  force with lease when it is rejected. Local changes are stashed and restored automatically.
- Every repository is read again when the window regains focus, in parallel.
- The remotes of every repository are fetched in the background (every 10 minutes by default, set in
  Settings), one repository at a time; such a fetch never asks for a password and stays silent when
  it fails.
- Worktrees: the sidebar lists them, creates one (on a new or an existing branch, next to the
  repository by default) and removes one (asking again when it has changes). A tab shows one
  worktree at a time: switching to another one keeps the same tab.
- The first connection to an ssh server (clone, fetch, pull, push) shows the server's keys and
  fingerprints and asks whether to trust it, as ssh would in a terminal; trusted keys go to
  `~/.ssh/known_hosts` and the command runs again. A server whose key changed is never trusted this way.
- Accounts on GitHub (github.com or Enterprise), GitLab (gitlab.com or self-hosted), Bitbucket Cloud
  and Bitbucket Data Center (File › Accounts…, Ctrl+,): a token is checked with the service before it
  is kept, in the system's credential store (Windows Credential Manager, the Secret Service on Linux),
  never in a file. A link opens the page of the service where the token is created.
- A repository can be found on an account (File › Find a repository…, Ctrl+Shift+N, or from the
  clone dialog): among the user's repositories or everything the service shows, with the README of
  the selected one formatted beside the list, then cloned over HTTPS or SSH.
- Pull requests (merge requests on GitLab) of every repository whose remote is on an account: their
  number on the overview cards, highlighted when the user's review is requested, and their list in
  the repository's side panel. One opens in place of the graph with its description and comments
  (Markdown, answered from Ramelo), its changes, all together or commit by commit, with each file's
  diff below (where any line of the whole changes can be commented, the comments shown under their
  line), and its commits; it can be merged (merge commit, squash or rebase, as the service
  allows) or closed. Its commits are fetched from the service, without adding a branch.
- A pull request is opened from Ramelo (Repository › New pull request…, or the + of the list): from a
  local branch to a branch of the remote, with a title, a Markdown description and the draft option;
  the current branch is pushed first when the service does not have all its commits.
- English (default) or French interface, light or dark theme, splash screen.

## Roadmap

1. Foundation and multi-repository workspace (done).
2. Repository view: commit graph, diffs, staging and commit, branches, fetch / pull / push (done).
3. Automation: reorder without an interactive rebase, undo based on the reflog (reword, editing a
   file of a past commit, squash, fixup and conflict resolution are done).
4. git-repo: manifest detection, `repo sync`, `repo start` and a global status of all projects.

## Layout

| Folder | Role |
| --- | --- |
| `crates/core` | Runs git and reads repositories: status (porcelain v2), history and graph layout, diffs, file contents, staging and commits, branches, fetch / pull / push, history search, cloning, the changes between two commits (a pull request), repository discovery on disk. No dependency on the interface or the storage. |
| `crates/storage` | The workspace (`workspace.json` in the user's data folder): repositories in tab order, the active one and the sections of the overview; and the accounts on hosting services (`accounts.json`, without their tokens). Files are written atomically. |
| `crates/hosting` | Hosting services through their web API (GitHub, GitLab, Bitbucket Cloud and Data Center): accounts, repository search, pull requests; and their tokens in the system's credential store. |
| `crates/gui` | Tauri 2 application: commands called by the interface (`src/commands`). |
| `crates/gui/ui` | Interface in HTML, CSS and JavaScript (ES modules, no framework, no bundler). |
| `crates/gui/ui/vendor` | Third-party code, kept as published: [marked](https://github.com/markedjs/marked) (MIT) for the Markdown preview and the pull request conversations. |

The Rust side is the single source of truth: each command returns a snapshot (repositories and their
state) that the interface displays without computing anything itself.

Every git operation goes through the `git` command line rather than a library, so Ramelo
behaves exactly like the user's own git: same configuration, credentials, hooks, worktrees and
`repo` integration. Git calls never open a console window on Windows, never wait for a prompt, and
never take the index lock when they only read.

## Requirements

- Git on the PATH (Git for Windows on Windows).
- Rust (stable) and the Tauri 2 prerequisites: WebView2 on Windows (already present on Windows 10/11),
  `libwebkit2gtk-4.1-dev`, `libgtk-3-dev` and `librsvg2-dev` on Linux.

## Build and run

```sh
cargo run -p ramelo                 # the application
cargo test --workspace              # tests (they create temporary repositories with git)
```

Design preview without Rust: serve `crates/gui/ui` with any static server (for example
`python -m http.server 5179 --directory crates/gui/ui`) and open it in a browser. A fake backend with
sample repositories takes over (`ui/js/api/mock`).

On some Linux machines (virtual machines, some GPU drivers) WebKitGTK shows a blank window; starting
the application with `WEBKIT_DISABLE_DMABUF_RENDERER=1` fixes it.
