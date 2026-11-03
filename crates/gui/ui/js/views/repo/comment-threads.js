// The comments of a pull request as discussions: a comment and the replies to it, each with a link
// to answer it. Drawn in the conversation and on the lines of the diff they are about.

import { t } from '../../i18n/i18n.js';
import { h } from '../../lib/dom.js';
import { icon } from '../../lib/icons.js';
import { markdown } from '../../lib/markdown.js';
import { fullDate, relativeTime } from '../../lib/time.js';
import { pullView } from '../../state/pull-view.js';

/** The reply being written: { to: id of the comment answered, text }, kept while other things are drawn. */
let replying = null;

/**
 * The discussions of `comments`, oldest first: { root, replies }, the replies oldest first. A reply
 * whose comment is not among them (deleted) starts a discussion of its own.
 */
export function threadsOf(comments) {
  const byId = new Map(comments.map((c) => [c.id, c]));
  const rootOf = (c) => {
    const seen = new Set();
    let at = c;
    while (at.parent && byId.has(at.parent) && !seen.has(at.parent)) {
      seen.add(at.id);
      at = byId.get(at.parent);
    }
    return at;
  };
  const threads = new Map();
  for (const c of comments) {
    const root = rootOf(c);
    if (!threads.has(root.id)) threads.set(root.id, { root, replies: [] });
    if (root !== c) threads.get(root.id).replies.push(c);
  }
  const time = (c) => c.created ?? 0;
  for (const thread of threads.values()) thread.replies.sort((a, b) => time(a) - time(b));
  return [...threads.values()].sort((a, b) => time(a.root) - time(b.root));
}

function when(seconds) {
  return seconds ? h('time', { title: fullDate(seconds) }, relativeTime(seconds)) : null;
}

function replyBox(comment, root, rerender) {
  const busy = pullView.state.busy === 'reply';
  const area = h('textarea', { class: 'pull-reply', placeholder: t('pr.replyPlaceholder', { author: comment.author }), spellcheck: 'true', disabled: busy });
  area.value = replying.text;
  const cancel = () => {
    replying = null;
    rerender();
  };
  const send = async () => {
    if (!area.value.trim() || pullView.state.busy) return;
    if (await pullView.reply(comment, root, area.value)) replying = null;
    rerender();
  };
  area.addEventListener('input', () => { replying.text = area.value; });
  area.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      send();
    }
    if (event.key === 'Escape') {
      event.stopPropagation();
      cancel();
    }
  });
  setTimeout(() => area.focus(), 0);
  return h('div', { class: 'reply-box' },
    area,
    h('div', { class: 'pull-composer-foot' },
      h('span', { class: 'hint' }, 'Ctrl+Enter'),
      h('button', { type: 'button', class: 'btn small', disabled: busy, onclick: cancel }, t('dialog.cancel')),
      h('button', { type: 'button', class: 'btn small primary', disabled: busy, onclick: send }, busy ? t('pr.sending') : t('pr.reply'))));
}

/**
 * One discussion. `open`: it can be answered (the pull request is open); `chip`: what is drawn at the
 * right of the first comment (where it is in the files); `card`: the class of each comment.
 */
export function renderThread({ root, replies }, { open, rerender, chip = null, card = 'line-comment' }) {
  const one = (c, isRoot) => {
    const answering = replying?.to === c.id;
    return [
      h('article', { class: `${card} thread-comment${isRoot ? '' : ' reply'}`, 'data-comment': c.id },
        h('header', {},
          h('span', { class: 'who' }, icon('user', 12), c.author),
          when(c.created),
          isRoot && chip),
        c.body?.trim() ? markdown(c.body) : h('p', { class: 'muted empty-body' }, '…'),
        open && h('footer', {},
          h('button', {
            type: 'button',
            class: `link-btn${answering ? ' active' : ''}`,
            onclick: () => {
              replying = answering ? null : { to: c.id, text: '' };
              rerender();
            },
          }, icon('reply', 12), t('pr.reply')))),
      open && answering && replyBox(c, root, rerender),
    ];
  };
  return h('div', { class: 'comment-thread', 'data-thread': root.id },
    one(root, true),
    replies.length > 0 && h('div', { class: 'thread-replies' }, replies.map((c) => one(c, false))));
}
