/**
 * A fake `EmailPort` that keeps every message instead of sending it, for tests. Never
 * imported by a Worker.
 */
import type { EmailPort, OutgoingEmail } from '../email';

export type CapturingEmail = EmailPort & {
  readonly sent: readonly OutgoingEmail[];
  /** The six-digit code in the newest message to `to`; throws when there is none. */
  latestCode(to: string): string;
};

export function capturingEmailPort(): CapturingEmail {
  const sent: OutgoingEmail[] = [];
  return {
    sent,
    async send(message) {
      sent.push(message);
    },
    latestCode(to) {
      const message = sent.findLast((candidate) => candidate.to === to);
      const code = /\b(\d{6})\b/.exec(message?.text ?? '')?.[1];
      if (code === undefined) throw new Error(`no code was sent to ${to}`);
      return code;
    },
  };
}
