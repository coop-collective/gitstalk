// The Automations section's builder: an HTML recreation of the real one (packages/web
// components/automations). The Blank template is picked and filled in field by field: the name
// (then the suggested file name), the Prompt harness and a model from its list, the bean_landed
// trigger with a paths filter (which takes the place of the template's `workflow_dispatch:`), a spending cap (a cap of 0 trips the live check until it is
// 0.25) and the prompt. The YAML beside the form is what the real builder writes at each step,
// byte for byte (its yaml Document edits: the quoted name once it has a space, the paths line
// only when the field loses focus, `|-` until the prompt ends with a newline). Save makes a
// bean, which is checked and lands; then Test run runs the file once by hand, and its steps and
// the agent's tool calls stream in until the run is green.
//
// Every frame is a pure function of the time into the story. Nothing fades: each change appears
// whole; the YAML and the run keep their final size from the start (what has not happened yet
// is hidden with visibility), so on a wide screen the figure never changes height. Reduced motion (and no script) shows the finished frame;
// `?au=<ms>` freezes a moment.

const AU_NAME = 'Billing watcher';
const AU_PATHS = 'src/billing/**';
const AU_PROMPT = [
  'Review the newest landing under src/billing/:',
  "the trigger's commit, or when run by hand,",
  'git log -1 -- src/billing/. Read your memory',
  "first, then the diff and the area's last 20",
  'landings. Write the verdict (fine, drift or',
  'regression) and the evidence to reviews/ in',
  'your memory, and finish with the verdict.',
  '',
].join('\n');
const AU_BLANK_PROMPT = 'Describe the goal here.\n';
const AU_DEFAULT_MODEL = '@cf/moonshotai/kimi-k2.7-code';
const AU_MODEL = '@cf/zai-org/glm-5.3';
const AU_MODEL_INDEX = 4;
/** What the cap field holds after each keystroke, and the number the form writes for it. */
const AU_COST_KEYS = [
  { text: '0', value: '0' },
  { text: '0.', value: '0' },
  { text: '0.2', value: '0.2' },
  { text: '0.25', value: '0.25' },
];

const AU = {
  template: 700,
  nameSelect: 1300,
  nameType: 1600,
  nameChar: 65,
  usePress: 3000,
  fileSwitch: 3200,
  harnessFocus: 3600,
  menuOpen: 4200,
  menuHover: [4200, 4500, 4800],
  menuClose: 5300,
  chip: 5900,
  pathFocus: 6400,
  pathType: 6600,
  pathChar: 55,
  pathBlur: 7800,
  costFocus: 8300,
  costKeys: [8500, 8900, 9300, 9550],
  costBlur: 9900,
  promptSelect: 10200,
  promptType: 10500,
  promptChar: 22,
};
AU.promptDone = AU.promptType + AU_PROMPT.length * AU.promptChar;
AU.save = AU.promptDone + 700;
AU.landed = AU.save + 1600;
AU.test = AU.landed + 1100;
AU.queued = AU.test + 300;
AU.run = AU.test + 900;
/** Each step's start and end, and each log line's arrival, after the run starts (ms). */
const AU_STEPS = [
  [0, 500],
  [500, 1000],
  [1000, 5900],
  [5900, 6300],
];
const AU_LOGS = [800, 1200, 1700, 2100, 2700, 3100, 3700, 4300, 4800, 5100, 5600, 6100];
AU.done = AU.run + 6500;
const AU_END_MS = AU.done + 5500;
const AU_MENU_HOVER = [0, 2, AU_MODEL_INDEX];

const typedCount = (t, start, perChar, length) =>
  t < start ? 0 : Math.min(length, 1 + Math.floor((t - start) / perChar));

/** What the builder holds at `t`. */
function auState(t) {
  const nameTyped = typedCount(t, AU.nameType, AU.nameChar, AU_NAME.length);
  const pathTyped = typedCount(t, AU.pathType, AU.pathChar, AU_PATHS.length);
  const costKey = AU.costKeys.filter((at) => t >= at).length;
  const promptTyped = typedCount(t, AU.promptType, AU.promptChar, AU_PROMPT.length);
  return {
    t,
    template: t >= AU.template,
    name: nameTyped === 0 ? 'New automation' : AU_NAME.slice(0, nameTyped),
    nameSelected: t >= AU.nameSelect && nameTyped === 0,
    nameTyping: nameTyped > 0 && t < AU.usePress,
    fileSwitched: t >= AU.fileSwitch,
    useShown: nameTyped > 0 && t < AU.fileSwitch,
    usePressed: t >= AU.usePress,
    harnessFocus: t >= AU.harnessFocus && t < AU.menuOpen,
    menuOpen: t >= AU.menuOpen && t < AU.menuClose,
    menuHover: AU_MENU_HOVER[AU.menuHover.filter((at) => t >= at).length - 1] ?? 0,
    modelChosen: t >= AU.menuClose,
    chip: t >= AU.chip,
    paths: AU_PATHS.slice(0, pathTyped),
    pathFocus: t >= AU.pathFocus && t < AU.pathBlur,
    pathCommitted: t >= AU.pathBlur,
    cost: costKey === 0 ? null : AU_COST_KEYS[costKey - 1],
    costFocus: t >= AU.costFocus && t < AU.costBlur,
    prompt: promptTyped === 0 ? AU_BLANK_PROMPT : AU_PROMPT.slice(0, promptTyped),
    promptSelected: t >= AU.promptSelect && promptTyped === 0,
    promptTyping: promptTyped > 0 && t < AU.promptDone + 300,
    saved: t >= AU.save,
    landed: t >= AU.landed,
    tested: t >= AU.test,
    queued: t >= AU.queued,
    running: t >= AU.run,
    done: t >= AU.done,
    since: t - AU.run,
  };
}

/** Which field the latest step wrote, for the YAML's highlight (none once saved). */
function latestChange(state) {
  const { t } = state;
  if (state.saved) return null;
  if (t >= AU.promptType) return 'prompt';
  if (t >= AU.costKeys[0]) return 'cost';
  if (t >= AU.pathBlur) return 'paths';
  if (t >= AU.chip) return 'on';
  if (t >= AU.menuClose) return 'model';
  if (t >= AU.nameType) return 'name';
  return 'tpl';
}

/** A YAML double-quoted string, as the yaml package writes a short one. */
const quoted = (text) => `"${text.replace(/["\\]/g, '\\$&')}"`;

/**
 * The file at a state, line by line, as the builder's `setField` leaves it: the blank
 * template's text with each field written in place, and new keys added at the end.
 */
function auYaml(state) {
  if (!state.template) return [{ text: '# Pick a template to start.', tag: '' }];
  // Once the typed name has a space it needs quotes, and the scalar keeps that style.
  const name =
    state.name.includes(' ') && state.name !== 'New automation' ? quoted(state.name) : state.name;
  const lines = [
    { text: `name: ${name}`, tag: 'name' },
    { text: 'on:', tag: 'tpl' },
    // Switching a trigger on drops the manual fallback: Run on its page stays available anyway.
    state.chip
      ? { text: '  bean_landed:', tag: 'on' }
      : { text: '  workflow_dispatch:', tag: 'tpl' },
  ];
  if (state.pathCommitted) lines.push({ text: `    paths: [ ${AU_PATHS} ]`, tag: 'paths' });
  const keepsNewline = state.prompt.endsWith('\n');
  const body = keepsNewline ? state.prompt.slice(0, -1) : state.prompt;
  lines.push(
    { text: `prompt: ${keepsNewline ? '|' : '|-'}`, tag: 'prompt' },
    ...body.split('\n').map((text) => ({ text: `  ${text}`, tag: 'prompt' })),
  );
  if (state.modelChosen) lines.push({ text: `model: ${quoted(AU_MODEL)}`, tag: 'model' });
  if (state.cost !== null)
    lines.push({ text: `max-cost-usd: ${state.cost.value}`, tag: 'cost', bad: isCostBad(state) });
  const fresh = latestChange(state);
  for (const line of lines) line.isNew = fresh === 'tpl' || line.tag === fresh;
  return lines;
}

const isCostBad = (state) => state.cost !== null && state.cost.value === '0';

/** The live check: what the shared validator says about the text. */
function auValidity(state) {
  if (!state.template) return { text: 'empty', tone: 'off' };
  if (isCostBad(state)) return { text: '1 problem', tone: 'bad' };
  return { text: '✓ no problems', tone: 'ok' };
}

/** The run's badge: queued until it starts, in progress, then success. */
function runStateOf(state) {
  if (state.done) return 'ok';
  if (state.running) return 'run';
  return 'queued';
}

/** A step's state at `since` ms into the run. */
function stepState(index, since) {
  const [start, end] = AU_STEPS[index];
  if (since >= end) return 'ok';
  if (since >= start) return 'run';
  return 'wait';
}

function setupAutomationsDemo() {
  const root = document.querySelector('[data-audemo]');
  if (!root) return;
  const $ = (name) => root.querySelector(`[data-au-${name}]`);
  const all = (name) => [...root.querySelectorAll(`[data-au-${name}]`)];
  const el = {
    tpl: $('tpl'),
    name: $('name'),
    namebox: $('namebox'),
    ncaret: $('ncaret'),
    file: $('file'),
    use: $('use'),
    path: $('path'),
    chip: $('chip'),
    filter: $('filter'),
    paths: $('paths'),
    pathbox: $('pathbox'),
    pcaret: $('pcaret'),
    harness: $('harness'),
    model: $('model'),
    menu: $('menu'),
    opts: all('opt'),
    prompt: $('prompt'),
    promptbox: $('promptbox'),
    caret: $('caret'),
    cost: $('cost'),
    costbox: $('costbox'),
    ccaret: $('ccaret'),
    cnote: $('cnote'),
    valid: $('valid'),
    save: $('save'),
    test: $('test'),
    status: $('status'),
    phase: $('phase'),
    saved: $('saved'),
    yaml: $('yaml'),
    idle: $('idle'),
    rbody: $('rbody'),
    rstate: $('rstate'),
    rtime: $('rtime'),
    steps: all('rstep'),
    logs: all('log'),
    out: $('out'),
  };
  let prevYaml = '';

  const drawForm = (state) => {
    el.tpl.classList.toggle('on', state.template);
    el.name.textContent = state.template ? state.name : '';
    el.name.classList.toggle('sel', state.nameSelected);
    el.namebox.classList.toggle('focus', state.nameSelected || state.nameTyping);
    el.ncaret.hidden = !state.nameTyping;
    el.file.textContent = state.fileSwitched ? 'billing-watcher' : 'automation';
    el.use.classList.toggle('gone', !state.useShown);
    el.use.classList.toggle('press', state.usePressed);
    el.path.textContent = `.gitstalk/automations/${state.fileSwitched ? 'billing-watcher' : 'automation'}.yml`;
    el.harness.classList.toggle('on', state.template);
    el.harness.classList.toggle('focus', state.harnessFocus);
    el.model.textContent = state.modelChosen ? AU_MODEL : `${AU_DEFAULT_MODEL} (default)`;
    el.model.classList.toggle('focus', state.menuOpen);
    el.menu.hidden = !state.menuOpen;
    el.opts.forEach((opt, index) => {
      opt.classList.toggle('hover', index === state.menuHover);
      opt.classList.toggle('chosen', index === 0);
    });
    el.chip.classList.toggle('on', state.chip);
    el.filter.hidden = !state.chip;
    const hasPaths = state.paths !== '';
    el.paths.textContent = hasPaths ? state.paths : 'all (globs, comma separated: *, !fix-*)';
    el.pathbox.classList.toggle('ph', !hasPaths);
    el.pathbox.classList.toggle('focus', state.pathFocus);
    el.pcaret.hidden = !state.pathFocus;
    el.cost.textContent = state.cost === null ? '0.50 (default)' : state.cost.text;
    el.costbox.classList.toggle('ph', state.cost === null);
    el.costbox.classList.toggle('focus', state.costFocus && !isCostBad(state));
    el.costbox.classList.toggle('bad', isCostBad(state));
    el.ccaret.hidden = !state.costFocus;
    el.cnote.textContent = isCostBad(state)
      ? 'max-cost-usd: Too small: expected number to be >0'
      : 'at most $5 a run';
    el.cnote.classList.toggle('bad', isCostBad(state));
    el.prompt.textContent = state.template ? state.prompt.replace(/\n$/, '') : '';
    el.prompt.classList.toggle('sel', state.promptSelected);
    el.promptbox.classList.toggle('focus', state.promptSelected || state.promptTyping);
    el.caret.hidden = !state.promptTyping;
    const validity = auValidity(state);
    el.valid.textContent = validity.text;
    el.valid.classList.toggle('off', validity.tone === 'off');
    el.valid.classList.toggle('bad', validity.tone === 'bad');
  };

  const drawSave = (state) => {
    const blocked = auValidity(state).tone !== 'ok';
    el.save.classList.toggle('off', blocked);
    el.test.classList.toggle('off', blocked);
    el.save.classList.toggle('press', state.saved);
    el.test.classList.toggle('press', state.tested);
    el.status.style.visibility = state.saved ? 'visible' : 'hidden';
    el.phase.textContent = state.landed ? 'landed' : 'checking';
    el.phase.classList.toggle('landed', state.landed);
    el.saved.textContent = state.landed
      ? 'as 7c1e4b2. Live when the stalk takes it.'
      : 'pre-land check on the merged tree';
  };

  const drawYaml = (state) => {
    const lines = auYaml(state);
    const key = lines
      .map((line) => `${line.isNew ? '+' : ' '}${line.bad ? '!' : ' '}${line.text}`)
      .join('\n');
    if (key === prevYaml) return;
    prevYaml = key;
    el.yaml.replaceChildren(
      ...lines.map((line) => {
        const span = document.createElement('span');
        span.textContent = line.text;
        if (line.bad) span.className = 'bad';
        else if (line.isNew) span.className = 'new';
        return span;
      }),
    );
  };

  const drawRun = (state) => {
    el.idle.hidden = state.queued;
    el.rbody.classList.toggle('gone', !state.queued);
    const runState = runStateOf(state);
    el.rstate.textContent = { ok: 'Success', run: 'In progress', queued: 'Queued' }[runState];
    el.rstate.classList.toggle('ok', runState === 'ok');
    el.rstate.classList.toggle('run', runState === 'run');
    el.rtime.classList.toggle('gone', !state.done);
    el.steps.forEach((step, index) => {
      const phase = state.running ? stepState(index, state.since) : 'wait';
      step.className = phase;
      step.querySelector('em')?.classList.toggle('gone', phase !== 'ok');
    });
    el.logs.forEach((line, index) => {
      line.classList.toggle('gone', !state.running || state.since < AU_LOGS[index]);
    });
    el.out.classList.toggle('gone', !state.done);
  };

  const draw = (t) => {
    const state = auState(t);
    drawForm(state);
    drawSave(state);
    drawYaml(state);
    drawRun(state);
  };

  const frozen = Number(new URLSearchParams(location.search).get('au'));
  if (Number.isFinite(frozen) && frozen > 0) {
    draw(frozen);
    return;
  }
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let t = 0;
  let last = 0;
  let raf = 0;
  let visible = false;
  const loop = (now) => {
    if (last) t = (t + Math.min(now - last, 100)) % AU_END_MS;
    last = now;
    draw(t);
    raf = requestAnimationFrame(loop);
  };
  const sync = () => {
    const run = visible && !document.hidden && !reduced.matches;
    if (run && !raf) {
      last = 0;
      raf = requestAnimationFrame(loop);
    }
    if (!run && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    if (reduced.matches) draw(AU_END_MS - 1);
  };
  draw(reduced.matches ? AU_END_MS - 1 : 0);
  new IntersectionObserver((entries) => {
    visible = entries.some((entry) => entry.isIntersecting);
    sync();
  }).observe(root);
  document.addEventListener('visibilitychange', sync);
  reduced.addEventListener('change', sync);
}

setupAutomationsDemo();
