'use client';

import { useEffect, useRef, useState } from 'react';

import styles from './repository.module.css';

type CopyState = 'idle' | 'copied' | 'selected';

/**
 * Copies `text` to the clipboard and says so for two seconds, announced through a status
 * region. Where the clipboard is refused (an insecure origin, a denied permission) it selects
 * the text beside it (the row's input or code) so the person can copy it themselves.
 */
export function CopyButton(props: {
  readonly text: string;
  readonly label?: string;
  readonly className?: string | undefined;
}) {
  const [state, setState] = useState<CopyState>('idle');
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (state === 'idle') return undefined;
    const timer = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(timer);
  }, [state]);
  const fallBack = (): void => {
    if (selectBeside(buttonRef.current)) setState('selected');
  };
  const copy = (): void => {
    if (typeof navigator.clipboard?.writeText !== 'function') {
      fallBack();
      return;
    }
    navigator.clipboard.writeText(props.text).then(() => setState('copied'), fallBack);
  };
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`${styles.copyButton} ${props.className ?? ''}`}
        onClick={copy}
        data-copied={state === 'copied' ? '' : undefined}
        aria-label={`Copy ${props.label ?? 'to clipboard'}`}
      >
        {state === 'copied' ? 'Copied' : 'Copy'}
      </button>
      <span role="status" className="visually-hidden">
        {statusText(state)}
      </span>
    </>
  );
}

function statusText(state: CopyState): string {
  switch (state) {
    case 'copied':
      return 'Copied';
    case 'selected':
      return 'Selected: press Ctrl+C or ⌘C to copy';
    case 'idle':
      return '';
    default:
      return assertNever(state);
  }
}

/** Selects the input or code element in the button's row; whether there was one. */
function selectBeside(button: HTMLButtonElement | null): boolean {
  const target = button?.parentElement?.querySelector('input, textarea, code, q') ?? null;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    target.focus();
    target.select();
    return true;
  }
  if (target === null) return false;
  const range = document.createRange();
  range.selectNodeContents(target);
  const selection = getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return true;
}

function assertNever(value: never): never {
  throw new Error(`unexpected copy state: ${String(value)}`);
}
