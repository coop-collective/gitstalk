'use client';

/**
 * The builder's form (doc 25 §7.13): every section reads the draft's fields and writes one
 * field back into the YAML text per change, so the YAML pane and the form never disagree.
 * Problems from the shared validator show under the field they name.
 */
import type { GitstalkEvent } from '@gitstalk/shared-race/actions';
import { GITSTALK_EVENTS, isPathFilteredEvent } from '@gitstalk/shared-race/actions';

import type { DraftForm, EventFilter, FieldPath } from '../../src/automations/automation-draft';
import { NO_FILTER } from '../../src/automations/automation-draft';
import styles from './builder.module.css';
import { ScheduleEditor } from './schedule-editor';

export type FieldProblems = ReadonlyMap<string, readonly string[]>;

export type FormActions = {
  readonly set: (path: FieldPath, value: unknown) => void;
  readonly setEvent: (event: GitstalkEvent, isOn: boolean) => void;
  readonly setFilter: (event: GitstalkEvent, filter: EventFilter) => void;
  readonly setCrons: (crons: readonly string[]) => void;
};

const EVENT_WORDS: Readonly<Record<GitstalkEvent, string>> = {
  bean_opened: 'a bean is pushed',
  bean_landed: 'a bean lands',
  bean_red: 'a bean goes red',
  bean_parked: 'a bean is parked',
  bean_dropped: 'a bean is dropped',
  bean_reverted: 'a bean is reverted',
  stalk_moved: 'the stalk moves',
  stalk_reset: 'the stalk resets',
  validation_red: 'validation goes red',
  decision_opened: 'a decision card opens',
  decision_decided: 'a decision is made',
};

/**
 * What the builder calls each harness (the owner's labels, 2026-10-14). The file keeps
 * `harness: agent` and `harness: shell`, so files written before the rename still read.
 */
const HARNESS_LABELS: Readonly<Record<DraftForm['harness'], string>> = {
  agent: 'Prompt',
  shell: 'Shell',
};

export function BuilderForm(props: {
  readonly form: DraftForm;
  readonly problems: FieldProblems;
  readonly actions: FormActions;
  readonly secretNames: readonly string[];
  readonly models: readonly string[];
  readonly defaultModel: string;
  readonly maxTimeoutMinutes: number;
  readonly nowMs: number;
  readonly fileField: React.ReactNode;
}) {
  const { form, actions, problems } = props;
  return (
    <div className={styles.form}>
      <Section title="Name" problems={problems.get('name')}>
        <input
          className={styles.input}
          aria-label="Name"
          value={form.name}
          maxLength={200}
          onChange={(event) => actions.set(['name'], event.target.value || undefined)}
        />
        {props.fileField}
      </Section>
      <Triggers form={form} actions={actions} problems={problems} nowMs={props.nowMs} />
      <Harness {...props} />
      <Section
        title="Permissions"
        problems={problems.get('permissions')}
        hint="A bean the automation pushes goes through the pre-land check like anyone's; it never moves the stalk."
      >
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={form.beansWrite}
            onChange={(event) =>
              actions.set(['permissions', 'beans'], event.target.checked ? 'write' : undefined)
            }
          />
          <span>
            May push beans <code>beans: write</code>
          </span>
        </label>
      </Section>
      <Secrets form={form} actions={actions} problems={problems} names={props.secretNames} />
      <Limits form={form} actions={actions} problems={problems} max={props.maxTimeoutMinutes} />
      <Section
        title="Memory"
        problems={problems.get('memory')}
        hint="Notes the agent keeps between runs, in git at refs/automations/<id>/memory."
      >
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={form.memory}
            onChange={(event) => actions.set(['memory'], event.target.checked ? undefined : false)}
          />
          <span>Keep memory between runs</span>
        </label>
      </Section>
    </div>
  );
}

function Triggers(props: {
  readonly form: DraftForm;
  readonly actions: FormActions;
  readonly problems: FieldProblems;
  readonly nowMs: number;
}) {
  const { form, actions } = props;
  const chosen = GITSTALK_EVENTS.filter((event) => form.events[event] !== undefined);
  return (
    <Section title="Triggers" problems={props.problems.get('on')}>
      <p className={styles.sub}>When</p>
      <div className={styles.chips} role="group" aria-label="Gitstalk events">
        {GITSTALK_EVENTS.map((event) => (
          <button
            key={event}
            type="button"
            className={styles.chip}
            aria-pressed={form.events[event] !== undefined}
            title={EVENT_WORDS[event]}
            onClick={() => actions.setEvent(event, form.events[event] === undefined)}
          >
            {event}
          </button>
        ))}
      </div>
      {chosen.map((event) => (
        <EventFilters
          key={event}
          event={event}
          filter={form.events[event] ?? NO_FILTER}
          onChange={(filter) => actions.setFilter(event, filter)}
        />
      ))}
      <ScheduleEditor crons={form.crons} onChange={actions.setCrons} nowMs={props.nowMs} />
      <p className={styles.manual}>
        <span aria-hidden="true">▸</span> Manual: always available (Run on the automation&rsquo;s
        page).
      </p>
    </Section>
  );
}

function EventFilters(props: {
  readonly event: GitstalkEvent;
  readonly filter: EventFilter;
  readonly onChange: (filter: EventFilter) => void;
}) {
  const { event, filter } = props;
  return (
    <div className={styles.filter}>
      <p>
        <code>{event}</code>: when {EVENT_WORDS[event]}
      </p>
      <label className={styles.inline}>
        <span>Beans</span>
        <GlobInput
          key={filter.beans.join(',')}
          label={`${event} bean filter`}
          globs={filter.beans}
          onChange={(beans) => props.onChange({ ...filter, beans })}
        />
      </label>
      <label className={styles.inline}>
        <span>Authors</span>
        <GlobInput
          key={filter.authors.join(',')}
          label={`${event} author filter`}
          globs={filter.authors}
          onChange={(authors) => props.onChange({ ...filter, authors })}
        />
      </label>
      {isPathFilteredEvent(event) ? (
        <label className={styles.inline}>
          <span>Paths</span>
          <GlobInput
            key={filter.paths.join(',')}
            label={`${event} changed-file filter`}
            globs={filter.paths}
            onChange={(paths) => props.onChange({ ...filter, paths })}
          />
        </label>
      ) : null}
    </div>
  );
}

/** Comma-separated globs (`*`, `!fix-*`); empty matches everything. */
function GlobInput(props: {
  readonly label: string;
  readonly globs: readonly string[];
  readonly onChange: (globs: readonly string[]) => void;
}) {
  return (
    <input
      className={styles.input}
      aria-label={props.label}
      placeholder="all (globs, comma separated: *, !fix-*)"
      defaultValue={props.globs.join(', ')}
      onBlur={(event) =>
        props.onChange(
          event.target.value
            .split(',')
            .map((glob) => glob.trim())
            .filter((glob) => glob !== ''),
        )
      }
    />
  );
}

function Harness(props: {
  readonly form: DraftForm;
  readonly actions: FormActions;
  readonly problems: FieldProblems;
  readonly models: readonly string[];
  readonly defaultModel: string;
}) {
  const { form, actions, problems } = props;
  return (
    <>
      <Section
        title="Harness"
        problems={[...(problems.get('harness') ?? []), ...(problems.get('model') ?? [])]}
      >
        <div className={styles.segments} role="radiogroup" aria-label="Harness">
          {(['agent', 'shell'] as const).map((harness) => (
            <button
              key={harness}
              type="button"
              role="radio"
              aria-checked={form.harness === harness}
              onClick={() => actions.set(['harness'], harness === 'agent' ? undefined : 'shell')}
            >
              {HARNESS_LABELS[harness]}
            </button>
          ))}
        </div>
        {form.harness === 'agent' ? (
          <label className={styles.inline}>
            <span>Model</span>
            <select
              className={styles.input}
              value={form.model === '' ? props.defaultModel : form.model}
              onChange={(event) =>
                actions.set(
                  ['model'],
                  event.target.value === props.defaultModel ? undefined : event.target.value,
                )
              }
            >
              {props.models.map((model) => (
                <option key={model} value={model}>
                  {model}
                  {model === props.defaultModel ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className={styles.hint}>
            A script with the same workspace, memory and bean push, and no model.
          </p>
        )}
      </Section>
      {form.harness === 'agent' ? (
        <Section
          title="Prompt"
          problems={problems.get('prompt')}
          hint="The goal. The event arrives as data beside it, never as instructions."
        >
          <textarea
            className={`${styles.input} ${styles.prompt}`}
            aria-label="Prompt"
            value={form.prompt}
            rows={10}
            onChange={(event) => actions.set(['prompt'], event.target.value || undefined)}
          />
        </Section>
      ) : (
        <Section
          title="Script"
          problems={problems.get('run')}
          hint="Runs with bash in the job container."
        >
          <textarea
            className={`${styles.input} ${styles.prompt}`}
            aria-label="Script"
            value={form.run}
            rows={8}
            onChange={(event) => actions.set(['run'], event.target.value || undefined)}
          />
        </Section>
      )}
    </>
  );
}

function Secrets(props: {
  readonly form: DraftForm;
  readonly actions: FormActions;
  readonly problems: FieldProblems;
  readonly names: readonly string[];
}) {
  const { form, actions } = props;
  const all = [...new Set([...props.names, ...form.secrets])].toSorted();
  const unknown = form.secrets.filter((name) => !props.names.includes(name));
  const toggle = (name: string) => {
    const next = form.secrets.includes(name)
      ? form.secrets.filter((secret) => secret !== name)
      : [...form.secrets, name];
    actions.set(['secrets'], next.length === 0 ? undefined : next);
  };
  return (
    <Section title="Secrets" problems={props.problems.get('secrets')}>
      {all.length === 0 ? (
        <p className={styles.hint}>
          No repository or org secrets yet. Add them in Settings → Actions; the file names them,
          never their values.
        </p>
      ) : (
        <div className={styles.chips} role="group" aria-label="Secrets">
          {all.map((name) => (
            <button
              key={name}
              type="button"
              className={styles.chip}
              aria-pressed={form.secrets.includes(name)}
              onClick={() => toggle(name)}
            >
              {name}
            </button>
          ))}
        </div>
      )}
      {unknown.length === 0 ? null : (
        <p className={styles.warn}>
          No secret is named {unknown.join(', ')} yet: the run gets an empty value until one is
          added.
        </p>
      )}
      <p className={styles.note}>
        <b>Event-triggered runs</b> get only the secrets marked &ldquo;available to pre-land
        checks&rdquo;: the event carries data other people wrote. Schedule and manual runs get every
        secret named here. Model calls never need a secret.
      </p>
    </Section>
  );
}

function Limits(props: {
  readonly form: DraftForm;
  readonly actions: FormActions;
  readonly problems: FieldProblems;
  readonly max: number;
}) {
  const { form, actions, problems } = props;
  const problemsHere = [
    ...(problems.get('timeout-minutes') ?? []),
    ...(problems.get('max-turns') ?? []),
    ...(problems.get('max-cost-usd') ?? []),
  ];
  return (
    <Section title="Limits" problems={problemsHere}>
      <div className={styles.limits}>
        <NumberField
          label="Timeout (minutes)"
          value={form.timeoutMinutes}
          placeholder="30"
          step={1}
          note={`capped at ${props.max}`}
          onChange={(value) => actions.set(['timeout-minutes'], value)}
        />
        {form.harness === 'agent' ? (
          <>
            <NumberField
              label="Max turns"
              value={form.maxTurns}
              placeholder="40"
              step={1}
              onChange={(value) => actions.set(['max-turns'], value)}
            />
            <NumberField
              label="Max cost (USD)"
              value={form.maxCostUsd}
              placeholder="0.50"
              step={0.05}
              note="at most $5 a run"
              onChange={(value) => actions.set(['max-cost-usd'], value)}
            />
          </>
        ) : null}
      </div>
    </Section>
  );
}

function NumberField(props: {
  readonly label: string;
  readonly value: number | null;
  readonly placeholder: string;
  readonly step: number;
  readonly note?: string;
  readonly onChange: (value: number | undefined) => void;
}) {
  return (
    <label className={styles.numberField}>
      <span>{props.label}</span>
      <input
        className={styles.input}
        type="number"
        inputMode="decimal"
        min={0}
        step={props.step}
        placeholder={`${props.placeholder} (default)`}
        value={props.value ?? ''}
        onChange={(event) => {
          const parsed = Number.parseFloat(event.target.value);
          props.onChange(Number.isFinite(parsed) ? parsed : undefined);
        }}
      />
      {props.note === undefined ? null : <small>{props.note}</small>}
    </label>
  );
}

function Section(props: {
  readonly title: string;
  readonly hint?: string;
  readonly problems: readonly string[] | undefined;
  readonly children: React.ReactNode;
}) {
  const problems = props.problems ?? [];
  return (
    <fieldset className={styles.section} data-invalid={problems.length > 0 ? 'true' : undefined}>
      <legend>{props.title}</legend>
      {props.hint === undefined ? null : <p className={styles.hint}>{props.hint}</p>}
      {props.children}
      {problems.map((problem) => (
        <p key={problem} className={styles.problem} role="alert">
          {problem}
        </p>
      ))}
    </fieldset>
  );
}
