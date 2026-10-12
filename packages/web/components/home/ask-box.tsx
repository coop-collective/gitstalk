'use client';

import { IntentLink as Link } from '../shell/intent-link';
import { useEffect, useRef, useState } from 'react';

import type { PickReceipt } from '@gitstalk/shared-ask/pick/picker';
import styles from './home.module.css';
import { InfoReceipt } from './receipts';

/**
 * The Ask: a command prompt. Completions open on focus (or ⌘K, or `/`) and close on Esc or
 * blur; under the closed box, a few example questions run with one click.
 */
export function AskBox(props: {
  readonly base: string;
  readonly q: string;
  readonly t: number | null;
  /** Questions in the picker's order: the first few are the examples, all are completions. */
  readonly questions: readonly { readonly q: string; readonly href: string }[];
  readonly receipt: PickReceipt | null;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing =
        event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
      if (
        (event.key === 'k' && (event.metaKey || event.ctrlKey)) ||
        (event.key === '/' && !typing)
      ) {
        event.preventDefault();
        input.current?.focus();
        setOpen(true);
      }
      if (event.key === 'Escape') {
        setOpen(false);
        input.current?.blur();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const closeIfOutside = () => {
    window.setTimeout(() => {
      if (!wrap.current?.contains(document.activeElement)) setOpen(false);
    }, 120);
  };
  return (
    <>
      <div
        ref={wrap}
        className={styles.askwrap}
        data-open={open ? '' : undefined}
        onBlur={closeIfOutside}
      >
        <form action={props.base} method="get" className={styles.ask} role="search">
          <span className={styles.q} aria-hidden="true">
            ?
          </span>
          <span className={styles.caret} aria-hidden="true" />
          <label htmlFor="home-ask" className="visually-hidden">
            Ask the beanstalk anything
          </label>
          <input
            ref={input}
            id="home-ask"
            name="q"
            defaultValue={props.q}
            placeholder="Ask the beanstalk anything"
            autoComplete="off"
            onFocus={() => setOpen(true)}
          />
          {props.t === null ? null : <input type="hidden" name="t" value={Math.round(props.t)} />}
          <kbd>⌘K</kbd>
        </form>
        {open ? (
          <div className={styles.completions} role="listbox" aria-label="Questions">
            {props.questions.map((item) => (
              <Link key={item.q} href={item.href} role="option" aria-selected="false">
                {item.q}
              </Link>
            ))}
            {props.receipt === null ? null : <InfoReceipt receipt={props.receipt} />}
          </div>
        ) : null}
      </div>
      {props.q === '' ? (
        <div className={styles.examples}>
          <span>Try</span>
          {props.questions.slice(0, 3).map((item) => (
            <Link key={item.q} href={item.href}>
              {item.q}
            </Link>
          ))}
        </div>
      ) : null}
    </>
  );
}
