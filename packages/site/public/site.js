// Gitstalk marketing site: theme toggle, the sign-up choice, the install picker with its copy
// button, the lifecycle stalk, the parallel checks and the race tally. The hero's app replay
// lives in app-demo.js. No framework.

// ---------------------------------------------------------------------------
// Install commands (the same ones the web app's /signup/agent prints, packages/web/src/setup/
// agent-installs.ts). The plugin comes from its own public repository; its .mcp.json
// names the hosted MCP server with no auth header, so each client runs its own OAuth sign-in.
// When the plugin moves to another organisation, change PLUGIN_REPO here and in
// packages/shared-race/src/plugin.ts (PLUGIN_MARKETPLACE).
// ---------------------------------------------------------------------------
const PLUGIN_REPO = 'coop-collective/gitstalk-plugin';
const PLUGIN = 'gitstalk';
const MARKETPLACE = 'gitstalk';
const MCP_URL = 'https://mcp.gitstalk.io/mcp';
const CLAUDE_SERVER = `plugin:${PLUGIN}:${PLUGIN}`;

const INSTALLS = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    where: 'paste in your terminal',
    kind: 'shell',
    verified: true,
    code: `claude plugin marketplace add ${PLUGIN_REPO} && claude plugin install ${PLUGIN}@${MARKETPLACE} && claude mcp login ${CLAUDE_SERVER}`,
  },
  {
    id: 'codex',
    name: 'Codex',
    where: 'paste in your terminal',
    kind: 'shell',
    verified: true,
    code: `codex plugin marketplace add ${PLUGIN_REPO} && codex plugin add ${PLUGIN}@${MARKETPLACE} && codex mcp login ${PLUGIN}`,
  },
  {
    id: 'cursor',
    name: 'Cursor',
    where: 'add to ~/.cursor/mcp.json, then run in your terminal',
    kind: 'shell',
    verified: false,
    code: `{ "mcpServers": { "${PLUGIN}": { "url": "${MCP_URL}" } } }\ncursor-agent mcp login ${PLUGIN}`,
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    where: 'paste in your terminal, then in Gemini',
    kind: 'shell',
    verified: false,
    code: `gemini mcp add --transport http ${PLUGIN} ${MCP_URL}\n/mcp auth ${PLUGIN}`,
  },
  {
    id: 'mcp',
    name: 'Other MCP',
    where: 'add as a remote (HTTP) MCP server',
    kind: 'url',
    verified: false,
    code: MCP_URL,
  },
];

// ---------------------------------------------------------------------------
// Theme: follows the system until the toggle is used, then remembers the choice.
// The inline script in <head> sets the first value so the page never flashes.
// ---------------------------------------------------------------------------
const THEME_KEY = 'beanstalk-theme';
const root = document.documentElement;
const systemDark = matchMedia('(prefers-color-scheme: dark)');

function readStoredTheme() {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}

function storeTheme(theme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage refused (private window): the choice lasts for this page only.
  }
}

function applyTheme(theme) {
  root.dataset.theme = theme;
  for (const btn of document.querySelectorAll('[data-theme-toggle]')) {
    const next = theme === 'dark' ? 'day' : 'night';
    btn.setAttribute('aria-label', `Switch to ${next} mode`);
    btn.title = `Switch to ${next} mode`;
  }
}

function setupTheme() {
  applyTheme(root.dataset.theme === 'light' ? 'light' : 'dark');
  for (const btn of document.querySelectorAll('[data-theme-toggle]')) {
    btn.addEventListener('click', () => {
      const theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
      storeTheme(theme);
      applyTheme(theme);
    });
  }
  systemDark.addEventListener('change', (event) => {
    if (!readStoredTheme()) applyTheme(event.matches ? 'dark' : 'light');
  });
}

// ---------------------------------------------------------------------------
// Sign-up choice: every [data-signup] link opens it (without JS the link goes to the agent page).
// ---------------------------------------------------------------------------
const CHOOSE_HTML = `
<dialog class="choose" id="choose" aria-labelledby="choose-title">
  <div class="inner">
    <button type="button" class="close" data-close aria-label="Close">×</button>
    <h2 id="choose-title">Sign up for Gitstalk</h2>
    <p class="sub">Gitstalk is built for agents. Most people sign up from the agent they already use.</p>
    <div class="options">
      <a class="option agent" href="/agent" autofocus>
        <span class="rec">recommended</span>
        <b>Sign up with Agent</b>
        <span>Paste one command into Claude Code, Codex, Cursor, Gemini CLI or another MCP client. It installs the plugin and signs you in.</span>
      </a>
      <a class="option" href="/human">
        <b>Sign up as Human</b>
        <span>Pick a handle and save a passkey in your browser. No password, no email.</span>
      </a>
    </div>
  </div>
</dialog>`;

function setupSignup() {
  const triggers = document.querySelectorAll('[data-signup]');
  if (triggers.length === 0) return;
  document.body.insertAdjacentHTML('beforeend', CHOOSE_HTML);
  const dialog = document.getElementById('choose');
  if (!(dialog instanceof HTMLDialogElement) || typeof dialog.showModal !== 'function') return;
  for (const trigger of triggers) {
    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      dialog.showModal();
    });
  }
  dialog.querySelector('[data-close]')?.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  // A shareable link straight to the choice: /#signup
  if (location.hash === '#signup') dialog.showModal();
}

// ---------------------------------------------------------------------------
// Install picker: a horizontal list of agents; the selected one's command shows below
// with one copy button. A hash such as /agent#codex preselects an agent.
// ---------------------------------------------------------------------------
function escapeHtml(text) {
  return text.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );
}

function renderInstallPanel(host, item) {
  const panel = host.querySelector('[role="tabpanel"]');
  if (!panel) return;
  panel.setAttribute('aria-labelledby', `${host.id}-tab-${item.id}`);
  panel.innerHTML = `
    <header><span>${item.name}: ${item.where}</span>${item.verified ? '' : '<span class="chip soon">untested</span>'}
      <button type="button" class="btn small copy" data-copy="#${host.id}-code">Copy</button></header>
    <pre class="${item.kind}" id="${host.id}-code" tabindex="0"><code>${escapeHtml(item.code)}</code></pre>
    <p class="copyhint" hidden role="status"></p>`;
}

function selectInstall(host, id, focus) {
  const item = INSTALLS.find((i) => i.id === id) ?? INSTALLS[0];
  for (const tab of host.querySelectorAll('[role="tab"]')) {
    const on = tab instanceof HTMLElement && tab.dataset.agent === item.id;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    if (on && focus && tab instanceof HTMLElement) tab.focus();
  }
  renderInstallPanel(host, item);
}

function setupInstalls() {
  const fromHash = location.hash.slice(1);
  for (const host of document.querySelectorAll('[data-install]')) {
    host.innerHTML = `
      <div class="picker" role="tablist" aria-label="Choose your agent">
        ${INSTALLS.map(
          (item) =>
            `<button type="button" role="tab" id="${host.id}-tab-${item.id}" data-agent="${item.id}" aria-controls="${host.id}-panel">${item.name}</button>`,
        ).join('')}
      </div>
      <div class="cmd" role="tabpanel" id="${host.id}-panel"></div>`;
    const ids = INSTALLS.map((i) => i.id);
    selectInstall(host, ids.includes(fromHash) ? fromHash : ids[0], false);
    host.querySelector('.picker')?.addEventListener('click', (event) => {
      const tab = event.target instanceof Element ? event.target.closest('[role="tab"]') : null;
      if (tab instanceof HTMLElement && tab.dataset.agent)
        selectInstall(host, tab.dataset.agent, false);
    });
    host.querySelector('.picker')?.addEventListener('keydown', (event) => {
      const current = ids.findIndex((id) =>
        host.querySelector(`[data-agent="${id}"][aria-selected="true"]`),
      );
      const moves = { ArrowRight: 1, ArrowLeft: -1, Home: -current, End: ids.length - 1 - current };
      const step = moves[event.key];
      if (step === undefined) return;
      event.preventDefault();
      selectInstall(host, ids[(current + step + ids.length) % ids.length], true);
    });
  }
}

// ---------------------------------------------------------------------------
// Copy buttons, with a fallback when the clipboard is refused.
// ---------------------------------------------------------------------------
function selectText(element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function showCopyState(button, state, label) {
  button.dataset.state = state;
  button.textContent = label;
  const hint = button.closest('.cmd')?.querySelector('.copyhint');
  if (hint) {
    hint.hidden = state !== 'manual';
    hint.textContent =
      state === 'manual'
        ? 'Copying was blocked. The command is selected: press Ctrl+C (⌘C on a Mac).'
        : '';
  }
  if (state === 'done') {
    setTimeout(() => {
      button.dataset.state = '';
      button.textContent = 'Copy';
    }, 2000);
  }
}

async function copyFrom(button) {
  const target = document.querySelector(button.dataset.copy);
  if (!target) return;
  const text = target.textContent.trim();
  try {
    if (!navigator.clipboard) throw new Error('Clipboard API unavailable');
    await navigator.clipboard.writeText(text);
    showCopyState(button, 'done', 'Copied');
  } catch {
    // Clipboard refused (permissions, insecure origin, file://): select the text instead.
    target.focus();
    selectText(target);
    showCopyState(button, 'manual', 'Press Ctrl+C');
  }
}

function setupCopy() {
  document.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-copy]') : null;
    if (button instanceof HTMLElement) void copyFrom(button);
  });
}

// ---------------------------------------------------------------------------
// Shared: run a tick while the element is on screen, the tab is visible and motion is allowed.
// ---------------------------------------------------------------------------
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

function whileVisible(element, intervalMs, tick) {
  let timer = 0;
  let visible = false;
  const sync = () => {
    const run = visible && !document.hidden && !reducedMotion.matches;
    if (run && !timer) timer = setInterval(() => tick(), intervalMs);
    if (!run && timer) {
      clearInterval(timer);
      timer = 0;
    }
  };
  new IntersectionObserver((entries) => {
    visible = entries.some((e) => e.isIntersecting);
    sync();
  }).observe(element);
  document.addEventListener('visibilitychange', sync);
  reducedMotion.addEventListener('change', sync);
}

// ---------------------------------------------------------------------------
// The lifecycle stalk. Beans are checked alone and land on the sprout. Meanwhile the stalk
// check runs continuously: it tests every sprout that landed since the last check, together.
// When it passes, that batch matures into the stalk at once and the next check starts right
// away on the sprouts that collected meanwhile. Now and then a check goes red: only the
// culprit is pulled out and sent back; the rest of its batch still matures.
// ---------------------------------------------------------------------------
const TITLES = [
  'Expired coupons are still accepted at checkout',
  'Cap the discount a percentage coupon gives',
  'Carts accept more units than are in stock',
  'Make product filtering a pure function',
  'Customers want a plain-text copy of their receipt',
  'Stock reservations should be all or nothing',
  'Free standard shipping on orders over $75',
  'Invoices should show federal and regional tax',
  'Fixed-amount coupons can push a total below zero',
  'Finance needs a list of overdue invoices',
  'Support refunding a single invoice line',
  'A failed checkout leaves stock reserved',
  'Send a receipt when an invoice is paid',
  'Reject weak passwords at registration',
  'Let customers reorder a previous order',
  'Shipping emails should include the tracking link',
];

/** Steps a stalk check takes (about a minute in our races). */
const CHECK_STEPS = 4;

function createStalkModel() {
  let titleIx = 0;
  let agentIx = 0;
  let minutes = 12 * 60 + 22;
  const nextTitle = () => TITLES[titleIx++ % TITLES.length];
  const nextAgent = () => `a${agentIx++ % 12}`;
  const clock = () => `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;

  const stalk = [];
  for (let n = 24; n > 17; n--) {
    stalk.push({ n, title: nextTitle(), time: clock() });
    minutes -= 2 + (n % 3);
  }
  minutes = 12 * 60 + 31;
  const model = {
    stalk,
    /** The batch the running stalk check is testing, together. */
    batch: [
      { n: 26, title: nextTitle(), time: clock() },
      { n: 25, title: nextTitle(), time: clock() },
    ],
    /** Sprouts that landed since that check began: the next batch. */
    collecting: [{ n: 27, title: nextTitle(), time: clock() }],
    beans: [
      { agent: '', title: nextTitle(), status: 'queued' },
      { agent: nextAgent(), title: nextTitle(), status: 'writing' },
      { agent: nextAgent(), title: nextTitle(), status: 'checking' },
      { agent: nextAgent(), title: nextTitle(), status: 'checking' },
    ],
    checkStep: 1,
    checks: 0,
    nextN: 28,
    /** What the last finished check did: matured n leaves, or pulled out a culprit. */
    result: null,
    clock,
    step() {
      minutes += 1;
      model.result = null;
      for (const bean of model.beans) if (bean.status === 'reworking') bean.status = 'writing';
      // A bean passes its own check and lands on the sprout (alone, every other step).
      const ready = model.beans.findLastIndex((b) => b.status === 'checking');
      if (ready >= 0 && minutes % 2 === 0) {
        const [bean] = model.beans.splice(ready, 1);
        model.collecting.unshift({
          n: model.nextN++,
          title: bean.title,
          time: clock(),
          enter: true,
        });
        const queued = model.beans.find((b) => b.status === 'queued');
        if (queued) {
          queued.status = 'writing';
          queued.agent = nextAgent();
        }
        model.beans.unshift({ agent: '', title: nextTitle(), status: 'queued', enter: true });
      } else {
        const writer = model.beans.findLast((b) => b.status === 'writing');
        if (writer) writer.status = 'checking';
      }
      // The stalk check runs on; when it finishes, the next starts at once on what collected.
      model.checkStep += 1;
      if (model.checkStep < CHECK_STEPS) return false;
      model.checks += 1;
      let batch = model.batch;
      if (model.checks % 3 === 0 && batch.length > 1) {
        // Red: only the culprit is pulled out and sent back to its author.
        const culprit = batch[0];
        batch = batch.slice(1);
        model.beans.splice(1, 0, { agent: nextAgent(), title: culprit.title, status: 'reworking' });
        model.result = { culprit: culprit.n };
      }
      for (const leaf of batch) leaf.promoted = true;
      model.stalk.unshift(...batch);
      model.stalk.length = Math.min(model.stalk.length, 8);
      model.result = { ...model.result, matured: batch.length, time: clock() };
      model.batch = model.collecting;
      model.collecting = [];
      model.checkStep = 0;
      return true;
    },
  };
  return model;
}

const STATUS_SHORT = {
  queued: 'queued',
  writing: 'write',
  checking: 'check',
  reworking: 'sent back',
};

function leafRow(leaf, cls) {
  const classes = [
    'srow',
    cls,
    leaf.n % 2 ? 'l' : '',
    leaf.enter ? 'enter' : '',
    leaf.promoted ? 'promoted' : '',
  ].join(' ');
  return `<div class="${classes}">
      <span class="tm">${leaf.time}</span><span class="stem"><i class="lf"></i></span>
      <span class="tt">${escapeHtml(leaf.title)}</span><span class="ix">#${leaf.n}</span></div>`;
}

function beanRow(bean) {
  return `<div class="srow bean ${bean.status}${bean.enter ? ' enter' : ''}">
      <span class="ag">${bean.agent}</span><span class="stem"><i class="beanmark"></i></span>
      <span class="tt">${escapeHtml(bean.title)}</span><span class="st">${STATUS_SHORT[bean.status]}</span></div>`;
}

function renderStalk(model, rowsEl, headEl) {
  const range = (leaves) => {
    const ns = leaves.map((leaf) => leaf.n);
    return ns.length > 1 ? `#${Math.min(...ns)}–#${Math.max(...ns)}` : `#${ns[0] ?? ''}`;
  };
  const rows = model.beans.map(beanRow);
  rows.push(...model.collecting.map((leaf) => leafRow(leaf, 'sprout')));
  rows.push(...model.batch.map((leaf) => leafRow(leaf, 'sprout inbatch')));
  const r = model.result;
  if (r?.matured) {
    rows.push(
      `<div class="matured-row"><span></span><span class="stem"></span><span>validated at ${r.time} · ${r.matured} matured</span></div>`,
    );
  }
  rows.push(...model.stalk.map((leaf) => leafRow(leaf, 'stalk')));
  rowsEl.innerHTML = rows.join('');
  const growing = model.beans.filter((b) => b.status !== 'queued').length;
  const check = model.batch.length ? ` · stalk check on ${range(model.batch)}` : '';
  headEl.textContent = `${growing} growing${check}`;
  for (const item of [...model.beans, ...model.collecting, ...model.batch, ...model.stalk]) {
    item.enter = false;
    item.promoted = false;
  }
}

function setupStalk() {
  const host = document.querySelector('[data-stalkdemo]');
  const rowsEl = host?.querySelector('.rows');
  const headEl = host?.querySelector('[data-stalkhead]');
  if (!host || !rowsEl || !headEl) return;
  const model = createStalkModel();
  // `?stalk=<steps>` freezes the graphic after that many steps (for screenshots).
  const frozen = Number(new URLSearchParams(location.search).get('stalk'));
  if (Number.isFinite(frozen) && frozen > 0) {
    let matured = false;
    for (let i = 0; i < frozen; i++) matured = model.step();
    renderStalk(model, rowsEl, headEl);
    rowsEl.classList.toggle('validating', matured);
    return;
  }
  renderStalk(model, rowsEl, headEl);
  whileVisible(host, 1500, () => {
    const matured = model.step();
    renderStalk(model, rowsEl, headEl);
    rowsEl.classList.toggle('validating', matured);
  });
}

// ---------------------------------------------------------------------------
// Parallel checks: twelve lanes, each bean checked on its own exact tree, all at once.
// ---------------------------------------------------------------------------
const LANE_TITLES = [
  'Finance needs a list of overdue invoices',
  'Support refunding a single invoice line',
  'The order total leaves out shipping',
  'Tax on multi-line invoices is a cent off',
  'Fixed-amount coupons go below zero',
  'Retired products are still visible by id',
  'A failed checkout leaves stock reserved',
  'Reject weak passwords at registration',
  'Customers cannot list their invoices',
  'Send a receipt when an invoice is paid',
  'Invoice numbers restart every year',
  'Require a signature for big deliveries',
];

function setupLanes() {
  const host = document.querySelector('[data-lanes]');
  const lanesEl = host?.querySelector('.lanes');
  const headEl = host?.querySelector('[data-lanes-head]');
  if (!host || !lanesEl || !headEl) return;
  const lanes = LANE_TITLES.map((title, i) => ({
    agent: `a${i}`,
    title,
    period: 34 + ((i * 7) % 23),
    offset: (i * 13) % 40,
    landed: 30 + i,
  }));
  let t = 31;
  const render = () => {
    let checking = 0;
    lanesEl.innerHTML = lanes
      .map((lane) => {
        const phase = ((t + lane.offset) % lane.period) / lane.period;
        const done = phase > 0.82;
        if (!done) checking += 1;
        const pct = Math.round(Math.min(phase / 0.82, 1) * 100);
        const cycles = Math.floor((t + lane.offset) / lane.period);
        const tree = `sprout #${30 + (cycles % 6)} + t0${String(10 + lanes.indexOf(lane)).padStart(2, '0')}`;
        return `<div class="lane${done ? ' landed' : ''}">
          <span class="a">${lane.agent}</span>
          <span class="t">${escapeHtml(lane.title)}<small>on ${tree}</small></span>
          <span class="bar"><i style="width:${pct}%"></i></span>
          <span class="s">${done ? 'landed' : `checking ${pct}%`}</span></div>`;
      })
      .join('');
    headEl.textContent = `${checking} checking now, ${12 - checking} just landed`;
  };
  render();
  whileVisible(host, 250, () => {
    t += 1;
    render();
  });
}

// ---------------------------------------------------------------------------
// The race tally: at least 39 shipped of 40 (39–40 across three seeds at 30 agents, research/race/runs/cf-demo2-*).
// ---------------------------------------------------------------------------
function renderTally() {
  for (const host of document.querySelectorAll('[data-tally]')) {
    host.innerHTML = Array.from({ length: 40 }, (_, i) =>
      i < 39 ? '<i></i>' : '<i class="miss"></i>',
    ).join('');
  }
}

setupTheme();
setupSignup();
setupInstalls();
setupCopy();
setupStalk();
setupLanes();
renderTally();
