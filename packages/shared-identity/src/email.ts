/**
 * The outgoing-mail port. Identity code sends through `EmailPort`; a Worker builds one from
 * its Cloudflare Email Service binding (`send_email`, Email Sending: any recipient once the
 * sender domain is onboarded), and tests use the capturing fake in `testing/capturing-email.ts`.
 */

/** One transactional message: always a plain-text and an HTML body. */
export type OutgoingEmail = {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
};

export type EmailPort = {
  send(message: OutgoingEmail): Promise<void>;
};

/** The Email Service binding, as far as this library uses it. */
export type EmailBinding = Pick<SendEmail, 'send'>;

export type Sender = { readonly email: string; readonly name: string };

/** Sign-in mail comes from `Gitstalk <signin@<domain>>`. */
export function signInSender(domain: string): Sender {
  return { email: `signin@${domain}`, name: 'Gitstalk' };
}

/** An `EmailPort` over the Email Service binding. Its errors (with a `code`) propagate. */
export function emailServicePort(binding: EmailBinding, from: Sender): EmailPort {
  return {
    async send(message) {
      await binding.send({ from, ...message });
    },
  };
}
