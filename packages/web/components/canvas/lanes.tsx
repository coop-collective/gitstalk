'use client';

import { useId } from 'react';

import type { Bean, Lane, RaceState } from '@gitstalk/shared-ask/race/race-state';
import { formatSpan } from '../../src/race/race-format';
import styles from './canvas.module.css';

/** What a lane is doing, in words, with a glyph that does not rely on colour. */
type LaneStatus = {
  readonly glyph: 'busy' | 'blocked' | 'idle' | 'human';
  readonly text: string;
  readonly bean: Bean | undefined;
};

/**
 * One row per agent slot: a swimlane of its time (writing, waiting on a check, idle), what
 * it is doing now and for how long.
 */
export function Lanes(props: {
  readonly state: RaceState;
  readonly now: number;
  readonly titles: Readonly<Record<string, string>>;
}) {
  const start = props.state.meta?.startedAt ?? 0;
  const span = Math.max(1, props.now - start);
  const hatch = `hatch-${useId().replace(/:/g, '')}`;
  return (
    <ul className={styles.lanes} aria-label="Agent lanes">
      <svg width="0" height="0" aria-hidden="true" className={styles.defs}>
        <defs>
          <pattern
            id={hatch}
            width="5"
            height="5"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect width="5" height="5" fill="var(--warn-wash)" />
            <line x1="0" y1="0" x2="0" y2="5" stroke="var(--warn-fill)" strokeWidth="2" />
          </pattern>
        </defs>
      </svg>
      {props.state.lanes.map((lane) => {
        const status = laneStatus(lane, props.state);
        return (
          <li key={lane.slot} className={styles.lane}>
            <span className={styles.slot}>{lane.slot}</span>
            <span className={styles.laneState}>
              <Glyph kind={status.glyph} />
              <span className={styles.laneText}>
                {status.text}
                {status.bean === undefined ? null : (
                  <span className={styles.laneTitle}> {props.titles[status.bean.id] ?? ''}</span>
                )}
              </span>
            </span>
            <span className={styles.swimCell} aria-hidden="true">
              <Swimlane lane={lane} start={start} span={span} now={props.now} hatch={hatch} />
            </span>
            <span className={styles.laneTime}>
              {lane.activity === 'idle' && lane.bean === null
                ? ''
                : formatSpan(props.now - lane.since)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function laneStatus(lane: Lane, state: RaceState): LaneStatus {
  const bean = lane.bean === null ? undefined : state.beans[lane.bean];
  if (lane.invocation !== null) {
    const task = lane.invocation.task ?? lane.bean ?? '';
    const reworking = lane.invocation.kind !== 'initial';
    return { glyph: 'busy', text: reworking ? `reworking ${task}` : `working on ${task}`, bean };
  }
  if (bean === undefined) return { glyph: 'idle', text: 'idle', bean: undefined };
  switch (bean.phase) {
    case 'checking':
      return { glyph: 'blocked', text: `pre-land checking ${bean.id}`, bean };
    case 'deciding':
      return {
        glyph: 'human',
        text: `waiting on decision ${bean.card ?? ''} for ${bean.id}`,
        bean,
      };
    case 'queued':
    case 'testing':
      return { glyph: 'blocked', text: `waiting in the queue with ${bean.id}`, bean };
    case 'rework':
      return { glyph: 'blocked', text: `about to rework ${bean.id}`, bean };
    case 'pending':
    case 'working':
    case 'landed':
    case 'green':
    case 'dropped':
      return { glyph: 'blocked', text: `holding ${bean.id}`, bean };
    case 'parked':
      return { glyph: 'human', text: `${bean.id} needs a person`, bean };
    case 'held':
      return { glyph: 'human', text: `${bean.id} waits for a person's approval`, bean };
    default:
      return assertNever(bean.phase);
  }
}

function assertNever(value: never): never {
  throw new Error(`unexpected bean phase ${String(value)}`);
}

function Glyph({ kind }: { readonly kind: LaneStatus['glyph'] }) {
  const className = {
    busy: styles.glyphBusy,
    blocked: styles.glyphBlocked,
    idle: styles.glyphIdle,
    human: styles.glyphHuman,
  }[kind];
  const shapes = {
    busy: <path d="M2 6.5 6 2l4 4.5-4 4.5Z" fill="currentColor" />,
    blocked: <path d="M3 3h6v6H3Z" fill="none" stroke="currentColor" strokeWidth="1.8" />,
    idle: <circle cx="6" cy="6.5" r="3" fill="none" stroke="currentColor" strokeWidth="1.4" />,
    human: <path d="M6 1.8 10.5 10H1.5Z" fill="currentColor" />,
  };
  return (
    <svg width="12" height="13" viewBox="0 0 12 13" className={className} aria-hidden="true">
      {shapes[kind]}
    </svg>
  );
}

const SEGMENT_CLASS = {
  busy: styles.segBusy,
  blocked: styles.segBlocked,
  idle: styles.segIdle,
} as const;

function Swimlane(props: {
  readonly lane: Lane;
  readonly start: number;
  readonly span: number;
  readonly now: number;
  readonly hatch: string;
}) {
  const x = (t: number) => ((t - props.start) / props.span) * 100;
  const open = { from: props.lane.since, to: props.now, activity: props.lane.activity };
  return (
    <svg className={styles.swim} viewBox="0 0 100 14" preserveAspectRatio="none">
      {[...props.lane.segments, open].map((segment) =>
        segment.to <= segment.from || segment.activity === 'idle' ? null : (
          <rect
            key={`${segment.from}-${segment.activity}`}
            x={x(segment.from)}
            width={Math.max(0.3, x(segment.to) - x(segment.from))}
            y="2"
            height="10"
            rx="1"
            className={SEGMENT_CLASS[segment.activity]}
            fill={segment.activity === 'blocked' ? `url(#${props.hatch})` : undefined}
          />
        ),
      )}
    </svg>
  );
}
