/**
 * Reads the head of a `git-receive-pack` request for the git-native flow: the command list,
 * the client's capabilities and its push options (`git push -o`, sent after the commands when
 * the server advertised `push-options`). It hands back the body to forward upstream: the same
 * commands without the `push-options` capability, no options section (Artifacts never sees the
 * options: the gateway advertised them, the gateway consumes them), then the pack, streamed.
 */
import { FLUSH_PKT, concatBytes, pktLine, pktText, readPktLines } from './pkt-line';
import type { PushCommand } from './receive-pack';

/** Longest head accepted: commands and options (a push of a few refs is well under 1 KiB). */
const MAX_HEAD_BYTES = 64 * 1024;
const PUSH_OPTIONS = 'push-options';

export type PushRequest = {
  readonly commands: readonly PushCommand[];
  readonly capabilities: readonly string[];
  /** `git push -o <option>` values, in order. */
  readonly options: readonly string[];
  /** The request body for the upstream receive-pack. */
  readonly upstreamBody: ReadableStream<Uint8Array>;
  /**
   * The pack alone, after the commands and options: what a push that creates a repository
   * forwards under its own commands. Read this or `upstreamBody`, never both.
   */
  readonly pack: ReadableStream<Uint8Array>;
};

export type PushRequestRead =
  | { readonly ok: true; readonly request: PushRequest }
  | { readonly ok: false; readonly reason: string };

type Head = {
  readonly commands: PushCommand[];
  readonly capabilities: string[];
  readonly options: string[];
  /** The command section as forwarded (capabilities rewritten), flush included. */
  readonly forwarded: Uint8Array;
  /** Bytes of the buffer that belong to the pack. */
  readonly packStart: number;
};

/** Reads the request's commands and options, buffering only the head. */
export async function readPushRequest(
  body: ReadableStream<Uint8Array> | null,
): Promise<PushRequestRead> {
  if (body === null) return { ok: false, reason: 'empty push request' };
  const reader = body.getReader();
  let buffered: Uint8Array = new Uint8Array(0);
  for (;;) {
    const head = parseHead(buffered);
    if (typeof head === 'string') return refuse(reader, head);
    if (head !== null) {
      const { commands, capabilities, options, forwarded, packStart } = head;
      const pack = replay(buffered.subarray(packStart), reader);
      const upstreamBody = ahead(forwarded, pack);
      return { ok: true, request: { commands, capabilities, options, upstreamBody, pack } };
    }
    if (buffered.length > MAX_HEAD_BYTES) return refuse(reader, 'push command list too long');
    // oxlint-disable-next-line no-await-in-loop -- a stream is read one chunk at a time
    const { done, value } = await reader.read();
    if (done) return { ok: false, reason: 'push request ended inside its command list' };
    buffered = concatBytes([buffered, value]);
  }
}

/** The parsed head once it is complete, null while more bytes are needed, or an error. */
function parseHead(bytes: Uint8Array): Head | null | string {
  const section = readPktLines(bytes, { stopAtFlush: true });
  if (!section.ok) return section.reason;
  if (section.lines.at(-1)?.kind !== 'flush') return null;
  const commands: PushCommand[] = [];
  const forwarded: Uint8Array[] = [];
  let capabilities: string[] = [];
  for (const line of section.lines) {
    if (line.kind !== 'data') continue;
    const text = new TextDecoder().decode(line.payload);
    const nul = text.indexOf('\0');
    if (nul >= 0)
      capabilities = text
        .slice(nul + 1)
        .trim()
        .split(' ')
        .filter(Boolean);
    const command = pktText(line.payload).split('\0')[0] ?? '';
    if (command.startsWith('push-cert')) return 'signed pushes are not supported';
    if (!command.startsWith('shallow ')) {
      const parsed = parseCommand(command);
      if (parsed === null) return 'malformed push command';
      commands.push(parsed);
    }
    forwarded.push(nul >= 0 ? withoutPushOptions(text, nul) : pktLine(line.payload));
  }
  forwarded.push(FLUSH_PKT);
  if (!capabilities.includes(PUSH_OPTIONS)) {
    return {
      commands,
      capabilities,
      options: [],
      forwarded: concatBytes(forwarded),
      packStart: section.offset,
    };
  }
  const optionSection = readPktLines(bytes, { offset: section.offset, stopAtFlush: true });
  if (!optionSection.ok) return optionSection.reason;
  if (optionSection.lines.at(-1)?.kind !== 'flush') return null;
  const options = optionSection.lines.flatMap((line) =>
    line.kind === 'data' ? [pktText(line.payload)] : [],
  );
  return {
    commands,
    capabilities,
    options,
    forwarded: concatBytes(forwarded),
    packStart: optionSection.offset,
  };
}

function parseCommand(line: string): PushCommand | null {
  const [oldSha, newSha, ref, ...extra] = line.split(' ');
  if (oldSha === undefined || newSha === undefined || ref === undefined || extra.length > 0)
    return null;
  if (!/^[0-9a-f]{40}$/.test(oldSha) || !/^[0-9a-f]{40}$/.test(newSha)) return null;
  return { oldSha, newSha, ref };
}

/** The first command line with `push-options` removed from its capability list. */
function withoutPushOptions(text: string, nul: number): Uint8Array {
  const capabilities = text
    .slice(nul + 1)
    .trim()
    .split(' ')
    .filter((capability) => capability !== '' && capability !== PUSH_OPTIONS);
  return pktLine(`${text.slice(0, nul)}\0${capabilities.join(' ')}\n`);
}

function replay(
  head: Uint8Array,
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (head.length > 0) controller.enqueue(head);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** `head`, then `source`, which is locked only once the stream is read (so `source` stays usable until then). */
function ahead(head: Uint8Array, source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (head.length > 0) controller.enqueue(head);
    },
    async pull(controller) {
      reader ??= source.getReader();
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader === null ? source.cancel(reason) : reader.cancel(reason);
    },
  });
}

async function refuse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: string,
): Promise<PushRequestRead> {
  await reader.cancel(reason);
  return { ok: false, reason };
}
