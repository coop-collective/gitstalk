'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReactNode, SubmitEvent } from 'react';

import styles from './account.module.css';

/** A native POST with one request ID and one submission while the email is being sent. */
export function EmailRequestForm({
  action,
  requestId,
  className,
  submitLabel,
  children,
}: {
  readonly action: '/api/auth/email/start' | '/api/auth/email/add';
  readonly requestId: string;
  readonly className: string | undefined;
  readonly submitLabel: string;
  readonly children: ReactNode;
}) {
  const submitted = useRef(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const reset = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      submitted.current = false;
      setPending(false);
    };
    window.addEventListener('pageshow', reset);
    return () => window.removeEventListener('pageshow', reset);
  }, []);

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    if (event.defaultPrevented) return;
    if (submitted.current) {
      event.preventDefault();
      return;
    }
    submitted.current = true;
    setPending(true);
  };

  return (
    <form method="post" action={action} className={className} onSubmit={submit} aria-busy={pending}>
      <input type="hidden" name="request_id" value={requestId} />
      {children}
      <button type="submit" className={styles.secondary} disabled={pending}>
        {pending ? 'Sending code…' : submitLabel}
      </button>
    </form>
  );
}
