/**
 * A real repository's engine, recorded on a staging stack (2026-10-07): `coop/greeter` from
 * the TypeScript starter, then three pushed beans, `add-truncate` (landed and validated),
 * `shout` (red: its own test fails on the merged tree) and `slugify` (landed and validated).
 * Test support only.
 */
import { parseRaceEvents } from '@gitstalk/shared-ask/race/race-events';
import type { RaceEvent } from '@gitstalk/shared-ask/race/race-events';
import type { PushedBean } from '../pushed-beans';
import events from './greeter-events.json' with { type: 'json' };

export const GREETER_EVENTS: readonly RaceEvent[] = parseRaceEvents(events).events;

export const ROOT = '577b7d69cf1236a4bdd5833b7ecfe8bafaa99534';
export const TRUNCATE_LANDED = '941e14665c3606724aadf5e0ee9d23357780f492';
export const SLUGIFY_LANDED = '8dadcc966ed0800517bffd0fe9b3a9643990824d';

export const GREETER_PUSHED: readonly PushedBean[] = [
  {
    bean: 'add-truncate',
    title: 'Add truncate for long titles',
    task: null,
    actor: 'coop',
    head: 'b99e3e04a59867cb06146d926cc2c17302c3fce9',
    pushes: 1,
    phase: 'green',
    reason: 'validated; on the stalk at 941e146',
    landed_sha: TRUNCATE_LANDED,
    verdict: ['LANDED: add-truncate passed its pre-land check and is on the sprout as 941e146'],
    hold: null,
    approvals: [],
  },
  {
    bean: 'shout',
    title: 'Shout greetings in capitals',
    task: null,
    actor: 'coop',
    head: 'a8c8ab782a7c7281f05cb47a8b1722610ccb60d4',
    pushes: 1,
    phase: 'red',
    reason: '1 failing test(s) on the merged tree',
    landed_sha: null,
    verdict: ['RED: shout was not landed. Merged onto the sprout, these tests failed:'],
    hold: null,
    approvals: [],
  },
  {
    bean: 'slugify',
    title: 'Add slugify for bean names',
    task: null,
    actor: 'coop',
    head: '7e289ff2c415b58ff185d1891d3e59d9dd34c0f3',
    pushes: 1,
    phase: 'green',
    reason: 'validated; on the stalk at 8dadcc9',
    landed_sha: SLUGIFY_LANDED,
    verdict: ['LANDED: slugify passed its pre-land check and is on the sprout as 8dadcc9'],
    hold: null,
    approvals: [],
  },
];
