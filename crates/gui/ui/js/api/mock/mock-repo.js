// Fake history, branches and diffs for the design preview, with the same shapes as the Tauri
// commands. The graph is laid out with the same rules as `crates/core/src/graph.rs`.

const now = () => Math.floor(Date.now() / 1000);
const AUTHORS = [['Steve Chadaud', 'steve@example.com'], ['Alex Martin', 'alex@example.com'], ['Sam Leroy', 'sam@example.com']];
const SUMMARIES = [
  'Export the Gantt chart with one column per day', 'Fix the week numbers around New Year', 'Show the team load per sprint',
  'Add the French holidays', 'Speed up the layout of large graphs', 'Keep the zoom between sessions', 'Rename Planificator to Waypoint',
  'Colour the tasks by team', 'Read old .planif files', 'Undo and redo on the Rust side', 'Lock shared projects while editing',
  'Draw dependencies with curves', 'Add the splash screen', 'Sprint velocity chart', 'Initial commit',
];

let seed = 7;
const random = () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
};
const oid = (n) => (`${(n * 2654435761 >>> 0).toString(16)}${(n * 40503 >>> 0).toString(16)}`.padEnd(40, 'a')).slice(0, 40);

/** A history with a main line, a feature branch merged back, and a branch still open. */
function makeHistory(count) {
  const commits = [];
  let n = count + 10;
  for (let i = 0; i < count; i += 1) {
    const [author, email] = AUTHORS[Math.floor(random() * AUTHORS.length)];
    commits.push({ oid: oid(n), parents: [], author, email, time: now() - i * 5400 - Math.floor(random() * 3000), summary: SUMMARIES[i % SUMMARIES.length], refs: [] });
    n -= 1;
  }
  // Main line by default; commits 2–5 are a topic branch merged by commit 1; 0 is on another branch.
  for (let i = 0; i < count - 1; i += 1) commits[i].parents = [commits[i + 1].oid];
  commits[1].parents = [commits[6].oid, commits[2].oid];
  commits[5].parents = [commits[6].oid];
  commits[0].parents = [commits[3].oid];
  commits[count - 1].parents = [];
  commits[1].summary = 'Merge branch \'feature/gantt-export\'';
  commits[0].refs = [{ kind: 'branch', name: 'feature/capacity', isHead: false }, { kind: 'remote', name: 'origin/feature/capacity', isHead: false }];
  commits[1].refs = [{ kind: 'branch', name: 'main', isHead: true }, { kind: 'remote', name: 'origin/main', isHead: false }];
  commits[7].refs = [{ kind: 'tag', name: 'v0.3.0', isHead: false }];
  commits.sort((a, b) => b.time - a.time);
  return commits;
}

/** Same algorithm as the backend: lanes wait for the first parent; merges open or join lanes. */
function layout(commits) {
  const lanes = [];
  let nextColor = 0;
  let width = 0;
  const free = () => {
    const i = lanes.findIndex((l) => !l);
    if (i >= 0) return i;
    lanes.push(null);
    return lanes.length - 1;
  };
  const rows = commits.map((commit) => {
    const waiting = lanes.map((l, i) => (l?.oid === commit.oid ? i : -1)).filter((i) => i >= 0);
    let lane;
    let color;
    if (waiting.length) [lane, color] = [waiting[0], lanes[waiting[0]].color];
    else [lane, color] = [free(), nextColor++];
    const top = lanes.flatMap((l, i) => (l ? [{ from: i, to: l.oid === commit.oid ? lane : i, color: l.color }] : []));
    for (const i of waiting) lanes[i] = null;
    const merges = [];
    const opened = [];
    if (commit.parents[0]) lanes[lane] = { oid: commit.parents[0], color };
    for (const parent of commit.parents.slice(1)) {
      const i = lanes.findIndex((l) => l?.oid === parent);
      if (i >= 0) merges.push({ from: lane, to: i, color: lanes[i].color });
      else {
        const j = free();
        const c = nextColor++;
        lanes[j] = { oid: parent, color: c };
        opened.push(j);
        merges.push({ from: lane, to: j, color: c });
      }
    }
    const bottom = lanes.flatMap((l, i) => (l && !opened.includes(i) ? [{ from: i, to: i, color: l.color }] : [])).concat(merges);
    while (lanes.length && !lanes[lanes.length - 1]) lanes.pop();
    width = Math.max(width, lanes.length, lane + 1);
    return { lane, color, top, bottom };
  });
  return { rows, width };
}

const histories = new Map();

export function history(path, limit) {
  if (!histories.has(path)) histories.set(path, path.includes('waypoint') ? makeHistory(60) : makeHistory(18));
  const commits = histories.get(path).slice(0, limit);
  const { rows, width } = layout(commits);
  return { rows: commits.map((c, i) => ({ ...c, graph: rows[i] })), width, hasMore: histories.get(path).length > limit };
}

/** A plausible diff for any file. */
export function diffFor(path, status = 'modified') {
  const lines = status === 'added'
    ? [['added', null, 1, '// New file'], ['added', null, 2, `pub fn ${path.split('/').pop().split('.')[0].replace(/\W/g, '_')}() {}`]]
    : [
      ['context', 12, 12, 'pub fn export(project: &Project) -> Result<Workbook> {'],
      ['deleted', 13, null, '    let days = project.span().days();'],
      ['added', null, 13, '    // One column per working day, weekends shaded.'],
      ['added', null, 14, '    let days = project.calendar().working_days(project.span());'],
      ['context', 14, 15, '    let mut sheet = Sheet::new("Gantt");'],
      ['context', 15, 16, '    for (i, task) in project.tasks().enumerate() {'],
    ];
  return {
    path, oldPath: null, status, binary: /\.(png|jpe?g|gif|webp)$/.test(path), truncated: false,
    additions: lines.filter((l) => l[0] === 'added').length,
    deletions: lines.filter((l) => l[0] === 'deleted').length,
    hunks: /\.(png|jpe?g|gif|webp)$/.test(path) ? [] : [{ header: '@@ -12,4 +12,5 @@ pub fn export', oldStart: 12, newStart: 12, lines: lines.map(([kind, old, nw, text]) => ({ kind, old, new: nw, text })) }],
  };
}

export function commitDetails(path, oid) {
  const commit = histories.get(path)?.find((c) => c.oid === oid);
  if (!commit) throw { code: 'git_failed', subject: 'show', message: 'unknown commit' };
  const files = ['crates/export/src/gantt.rs', 'crates/export/src/style.rs', 'README.md', 'docs/logo.png', 'docs/index.html'].map((p, i) => diffFor(p, i === 1 ? 'added' : 'modified'));
  // A picture moved without change, and one deleted.
  files.push({ ...diffFor('assets/images/icon.png', 'renamed'), oldPath: 'docs/images/icon.png', additions: 0, deletions: 0, binary: false, hunks: [] });
  files.push({ ...diffFor('docs/banner.png', 'deleted'), additions: 0, deletions: 0 });
  return {
    oid, parents: commit.parents, author: commit.author, email: commit.email, time: commit.time,
    committer: commit.author, commitTime: commit.time, message: `${commit.summary}\n\nThe export now follows the project calendar.`, files,
  };
}

export function branches(path) {
  const commits = histories.get(path) ?? history(path, 1000).rows;
  const tip = (name) => commits.find((c) => c.refs.some((r) => r.name === name))?.oid ?? commits[0].oid;
  const branch = (name, extra = {}) => ({ name, oid: tip(name), upstream: null, ahead: 0, behind: 0, gone: false, isHead: false, time: now(), summary: '', ...extra });
  return {
    local: [
      branch('main', { isHead: true, upstream: 'origin/main' }),
      branch('feature/capacity', { upstream: 'origin/feature/capacity', ahead: 1 }),
      branch('old-experiment', { gone: true, upstream: 'origin/old-experiment' }),
    ],
    remote: [branch('origin/main'), branch('origin/feature/capacity'), branch('origin/release/0.3')],
    tags: [{ name: 'v0.3.0', oid: tip('v0.3.0') }],
  };
}

// ---------- Contents, for images and previews ----------

const PNG_BEFORE = 'iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAYAAAABtjuPAAACX0lEQVR4nO3dPU4jQRSF0WI0OaSzkglgR7Ac2BEErGRSWAETWSIxrv5x39fV58Sm+kn+9Nq21KI1AAAAAGB0N2sedv/48bXmedT19nK3SjuLDxEdS2L8teTC4qO1ZR3MKld4nDN1G07egOLjJ1P7mBSg+OgxpZNFnwFhqe4AbT+m6O2lK0DxMUdPN27BRAmQqIsBuv2yxKV+bECiBEiUAIkSIFECJEqARAmQKAESJUCiBEjU7/QAc70+3/679JqHp88/W8zCfLsKsCe6c68XY027CHBqeD+dIcRaSge4RnjnzhRiDWW/hFwjvi3Pp0/JALeKQ4R55QLcOgoRZpUKMBWDCHPKBJiOIH39oyoRYJU3v8ocR1L6Z5g9en2+fU/PsLaHp8+/1zo7vgGrbZ1q84wuHiDHFg2w6rapOteIbECiBEhULMDqt7nq843CBiRKgEQJkCgBEiVAogRIlACJEiBRsQCrP5VWfb5R2IBECZCoaIBVb3NV5xqRDUhUPMBq26baPKPzUNLKrvkAz4jiG7C1OlunyhxHUiLA1vJvfvr6R1UmwNZyEYgvp1SArW0fg/iyygXY2nZRiC+vZICtXT8O8dVQ+meYUyRrPqEmvFpKB3iyRojCq2kXAZ58j8j/CRnDrgL8TlxjKPslhGMQIFECJEqARAmQKAESJUCiBEiUAIkSIFEXA3x7ubvZYhDGdKkfG5AoARLVFaDbMHP0dNO9AUXIFL29uAUTNSlAW5AeUzqZvAFFyE+m9rEopvvHj68lf8845i6mRZ8BbUNaW9bBqgHZiMdh+QAAAADsyn86jbw82aQQzgAAAABJRU5ErkJggg==';
const PNG_AFTER = 'iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAYAAAABtjuPAAACXUlEQVR4nO3d0U3jQBSG0WG1RZBKthxoAoqAJqAcKgldsE+ReEniiR3/1+NznsP4Svl0nUSyaA0AAAAAGN3Dkoc9frz9LHkedX0/vy7SzuxDRMecGP/MubD4aG1eBzeVKzzO6d2G3RtQfFzS20dXgOJjip5OZn0GhLkmB2j70WNqL5MCFB+3mNKNWzBRAiTqaoBuv8xxrR8bkCgBEiVAogRIlACJEiBRAiRKgEQJkCgBEvU3PcCtjk8vx2uvOXy+H9aYhdttKsAp0Z17vRhr2kSAveFdOkOItZQOcInwzp0pxBrKfgm5R3xrns80JQNcKw4R5pULcO0oRJhVKsBUDCLMKRNgOoL09feqRIBV3vwqc+xJ6Z9htuj49PKVnmFph8/3f/c6O74Bq22davOMLh4g+xYNsOq2qTrXiGxAogRIVCzA6re56vONwgYkSoBECZAoARIlQKIESJQAiRIgUbEAqz+VVn2+UdiARAmQqGiAVW9zVecakQ1IVDzAatum2jyj81DSwu75AM+I4huwtTpbp8oce1IiwNbyb376+ntVJsDWchGIL6dUgK2tH4P4ssoF2Np6UYgvr2SArd0/DvHVUPpnmFMkSz6hJrxaSgd4skSIwqtpEwGe/I7I/wkZw6YC/E1cYyj7JYR9ECBRAiRKgEQJkCgBEiVAogRIlACJEiBRVwP8fn59WGMQxnStHxuQKAESNSlAt2FuMaWbyRtQhPSY2otbMFFdAdqCTNHTSfcGFCGX9PYxK6bHj7efOX/POG5dTLM+A9qGtDavg0UDshH3w/IBAAAA2JT/uWi7lF/7rwEAAAAASUVORK5CYII=';

const MARKDOWN_BEFORE = '# Export\n\nThe Gantt export writes **one column per day**.\n';
const MARKDOWN_AFTER = [
  '# Export guide',
  '',
  'The Gantt export now follows the **project calendar**: one column per *working* day, weekends shaded.',
  '',
  '## Options',
  '',
  '| Option | Effect |',
  '| --- | --- |',
  '| `--weekends` | Keep the weekends as columns |',
  '| `--holidays` | Shade the public holidays |',
  '',
  '- Works with `.planif` and `.waypoint` files',
  '- Keeps the task colours',
  '',
  '> Large projects are written in a few seconds.',
  '',
  '```rust',
  'let days = project.calendar().working_days(project.span());',
  '```',
].join('\n');
const HTML = '<!doctype html><html><head><style>body{font-family:sans-serif;margin:24px;color:#223} h1{color:#2450d8} .card{border:1px solid #ccd;border-radius:10px;padding:12px 16px;max-width:360px}</style></head>'
  + '<body><h1>Waypoint</h1><div class="card"><strong>Export</strong><p>One column per working day.</p></div><script>document.body.append("script ran")</script></body></html>';

const utf8 = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const version = (data, size) => ({ size: size ?? Math.round(data.length * 0.75), data });

export function fileVersions(file) {
  if (file.endsWith('icon.png')) return { before: version(PNG_AFTER), after: version(PNG_AFTER) };
  if (file.endsWith('banner.png')) return { before: version(PNG_BEFORE), after: null };
  if (/\.png$/.test(file)) return { before: version(PNG_BEFORE), after: version(PNG_AFTER) };
  if (/\.md$/.test(file)) return { before: version(utf8(MARKDOWN_BEFORE)), after: version(utf8(MARKDOWN_AFTER)) };
  if (/\.html?$/.test(file)) return { before: null, after: version(utf8(HTML)) };
  return { before: version(utf8('before\n')), after: version(utf8('after\n')) };
}

// ---------- Search ----------

export function searchCommits(path, { text, scope, matchCase, regex }, limit) {
  const commits = history(path, 100000).rows;
  let test;
  if (regex) {
    let re;
    try { re = new RegExp(text, matchCase ? '' : 'i'); } catch { throw { code: 'invalid_pattern', subject: text, message: 'invalid regex' }; }
    test = (value) => re.test(value);
  } else {
    const wanted = matchCase ? text : text.toLowerCase();
    test = (value) => (matchCase ? value : value.toLowerCase()).includes(wanted);
  }
  const byScope = {
    all: (c) => test(c.summary) || test(c.author) || c.oid.startsWith(text.toLowerCase()),
    message: (c) => test(c.summary),
    author: (c) => test(c.author) || test(c.email),
    sha: (c) => c.oid.startsWith(text.toLowerCase()),
    file: (c, i) => i % 7 === 0 && test('crates/export/src/gantt.rs'),
    code: (c, i) => i % 5 === 0,
  };
  const oids = commits.filter((c, i) => byScope[scope](c, i)).map((c) => c.oid);
  return { oids: oids.slice(0, limit), truncated: oids.length > limit };
}
