// Repositories shown by the fake backend (design preview in a browser).

const hour = 3600;
const now = () => Math.floor(Date.now() / 1000);

const file = (path, index, worktree, origPath = null) => ({ path, origPath, index, worktree });

function summary(overrides) {
  const files = overrides.files ?? [];
  const count = (test) => files.filter(test).length;
  return {
    head: { branch: 'main', oid: '3f9a1c2' },
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    stashes: 0,
    operation: null,
    remotes: ['origin'],
    lastCommit: { oid: '3f9a1c2d', summary: 'Initial commit', author: 'Sam Taylor', time: now() - 5 * hour },
    ...overrides,
    files,
    fileCount: files.length,
    staged: count((f) => !['unmodified', 'untracked', 'ignored', 'conflicted'].includes(f.index)),
    unstaged: count((f) => ['modified', 'typeChanged', 'deleted'].includes(f.worktree)),
    untracked: count((f) => f.worktree === 'untracked'),
    conflicted: count((f) => f.index === 'conflicted'),
  };
}

export function sampleWorkspace() {
  const root = 'C:\\Users\\sam\\dev';
  return [
    {
      path: `${root}\\waypoint`,
      summary: summary({
        head: { branch: 'feature/gantt-export', oid: 'a1b2c3d' },
        upstream: 'origin/feature/gantt-export',
        ahead: 2,
        behind: 1,
        stashes: 1,
        lastCommit: { oid: 'a1b2c3d4', summary: 'Export the Gantt chart with one column per day', author: 'Sam Taylor', time: now() - 2 * hour },
        files: [
          file('crates/export/src/gantt.rs', 'modified', 'unmodified'),
          file('crates/export/src/style.rs', 'added', 'unmodified'),
          file('crates/gui/ui/js/views/gantt/bars.js', 'unmodified', 'modified'),
          file('docs/export guide.md', 'renamed', 'unmodified', 'docs/export.md'),
          file('notes/todo.txt', 'untracked', 'untracked'),
          file('docs/screens/gantt.png', 'unmodified', 'modified'),
        ],
      }),
    },
    {
      path: `${root}\\spektra`,
      summary: summary({
        lastCommit: { oid: '9e8d7c6b', summary: 'Smooth the curves of the line charts', author: 'Sam Taylor', time: now() - 26 * hour },
      }),
    },
    {
      path: `${root}\\traffic_spy`,
      summary: summary({
        head: { branch: 'main', oid: '55aa66b' },
        operation: 'rebase',
        lastCommit: { oid: '55aa66bb', summary: 'Poll the network counters every second', author: 'Sam Taylor', time: now() - 50 * hour },
        files: [
          file('core/src/watch.rs', 'conflicted', 'conflicted'),
          file('core/src/lines.rs', 'modified', 'unmodified'),
        ],
      }),
    },
    {
      path: `${root}\\aosp\\frameworks\\base`,
      summary: summary({
        head: { branch: null, oid: 'c0ffee1' },
        upstream: null,
        remotes: ['aosp'],
        lastCommit: { oid: 'c0ffee12', summary: 'Merge "Update battery stats" into main', author: 'Android Build', time: now() - 9 * 24 * hour },
      }),
    },
    {
      path: `${root}\\old-prototype`,
      error: { code: 'path_missing', subject: `${root}\\old-prototype`, message: 'the folder does not exist' },
    },
  ];
}
