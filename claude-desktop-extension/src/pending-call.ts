// Copyright (c) Fan Pier Labs. Use of this software is governed by the LICENSE file in the project root.

/**
 * Parks a tool call that outruns Claude Desktop's request timeout, so its
 * result can be collected by id with `check_pending_call`.
 *
 * The timeout is undocumented. The one measurement on record is in Claude
 * Desktop's client log (~/Library/Logs/Claude/mcp.log): a `notifications/
 * cancelled` with "MCP error -32001: Request timed out" 197 s after the
 * request (June 2026 build, on `initialize`); four minutes is the figure
 * usually quoted. The desktop deadline sits under both and above the scrapers'
 * 2-minute per-request deadline (scrapers/http.ts).
 *
 * HTTP mode uses a shorter deadline. A proxy in front of the container often
 * closes a response around 100 seconds. A call that finished in that gap used
 * to take the direct-return branch and never enter this map, and a collection
 * that waited the full desktop deadline could discard a result onto a
 * connection the proxy had already closed. One minute is inside that window
 * for both the park note and a collection wait. A disconnect before that
 * minute is the same hole, so an aborted wait parks instead of returning.
 * A finished HTTP result stays reserved until that response has ended, and
 * abandoning the call while its request is still waiting returns a discard
 * note instead of the payload. Desktop is unchanged.
 *
 * Calls are not serialized — the same log shows Claude Desktop issuing a
 * second call 5.5 s after an unanswered first — so several may park. On
 * stdio a parked call refuses a repeat of itself with the same arguments,
 * the retry that would send a message twice. HTTP reserves that key before
 * its first await, and a second request joins the call already in flight,
 * because a proxy retry can start while the first request is still open.
 * switch_proxy_target also refuses while a parked read on the account is
 * still running (`unsettledCallOnAccount`): MyChart's active patient is
 * server-side state, and switching under a running read hands it the wrong
 * chart.
 *
 * Abandoning a call only stops waiting for it. Nothing in the scraper core
 * takes an abort signal, so the work runs on and a write already sent lands.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** Set by the HTTP server for the request it is answering. A dropped response aborts it. Stdio never sets it. */
const lostResponse = new AsyncLocalStorage<AbortSignal>();
/**
 * Set by the HTTP server so a finished result is forgotten only once that response has ended.
 * Stdio never sets it, and forgets as soon as the handler returns.
 */
const responseDelivery = new AsyncLocalStorage<(cb: (wrote: boolean) => void) => void>();
/** The HTTP reservation whose handler is running. It is already in `parked`, and is not a second call. */
const executingCall = new AsyncLocalStorage<string>();

export function withLostResponse<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  return lostResponse.run(signal, fn);
}

export function withResponseDelivery<T>(notify: (cb: (wrote: boolean) => void) => void, fn: () => Promise<T>): Promise<T> {
  return responseDelivery.run(notify, fn);
}

export const CHECK_TOOL = 'check_pending_call';
const DESKTOP_DEADLINE_MS = 150_000;
const DESKTOP_DEADLINE_LABEL = '2.5 minutes';
/** Under the ~100s proxy cutoff in front of the container. See the file comment. */
const HTTP_DEADLINE_MS = 60_000;
const HTTP_DEADLINE_LABEL = '1 minute';

let parkDeadlineMs = DESKTOP_DEADLINE_MS;
let parkDeadlineLabel = DESKTOP_DEADLINE_LABEL;

/** What the parking note and `check_pending_call`'s description currently say. Read at registration, so call it when registering, not at import. */
export function currentParkDeadlineLabel(): string {
  return parkDeadlineLabel;
}

/** `--http` only. Stdio keeps the desktop deadline. `ms` is the test seam; production passes none. */
export function useHttpParkDeadline(ms = HTTP_DEADLINE_MS): void {
  parkDeadlineMs = ms;
  parkDeadlineLabel = HTTP_DEADLINE_LABEL;
}

export function useDesktopParkDeadline(): void {
  parkDeadlineMs = DESKTOP_DEADLINE_MS;
  parkDeadlineLabel = DESKTOP_DEADLINE_LABEL;
}
/** From a call's start, after which it is dropped: result given up on, chart lock released. Also how long an unread result is kept. */
export const MAX_RUN_MS = 10 * 60_000;

interface Parked {
  id: string;
  tool: string;
  key: string;
  account: string | null;
  startedAt: number;
  promise: Promise<CallToolResult>;
  result?: CallToolResult;
  settledAt?: number;
  /** A connected caller already received this result. A disconnected owner must not park it again. */
  delivered?: boolean;
  /** The caller stopped waiting, so the result is no longer theirs. The entry stays until the scrape settles, or the cap, so the proxy guard still sees it. */
  abandoned?: boolean;
}

const parked = new Map<string, Parked>();
/** Collections blocked inside the wait. The disconnect test waits until this is non-zero. */
let waitingCollections = 0;
/** Tool calls and HTTP joiners blocked inside their wait. The disconnect test waits until this is non-zero. */
let waitingGuards = 0;

export function collectionWaitsInFlight(): number {
  return waitingCollections;
}

export function guardedWaitsInFlight(): number {
  return waitingGuards;
}

/**
 * Why a call that is no longer parked went away, kept for the last few, so a
 * stale id gets an answer instead of one message covering "you collected it",
 * "you abandoned it" and "it ran too long" alike. Live testing could not tell
 * those apart, and they call for different next moves.
 */
const gone = new Map<string, string>();
const GONE_KEEP = 50;

/** Drop a parked call, remembering what became of it. */
function forget(p: Parked, why: string): void {
  parked.delete(p.id);
  gone.set(p.id, `${p.tool} was ${why}`);
  if (gone.size > GONE_KEEP) gone.delete(gone.keys().next().value!);
}

const ABANDON_MEANS =
  'Abandoning only stops waiting: the work runs on in the background until it finishes, and a message or request it already sent still lands.';

function text(message: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: message }], ...(isError ? { isError: true } : {}) };
}

/**
 * The id a "still running" note carries as data, for code that waits a call
 * out (the setup widget) rather than reading the sentence the model gets.
 */
export interface PendingCallNote {
  pending_call: { id: string };
}

function stillRunning(message: string, id: string): CallToolResult {
  const note: PendingCallNote = { pending_call: { id } };
  return { ...text(message), structuredContent: { ...note } };
}

function elapsed(startedAt: number, now: number): string {
  const secs = Math.max(0, Math.round((now - startedAt) / 1000));
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

/**
 * Sorted keys at every level, so argument order cannot make two calls differ.
 * Not a `JSON.stringify` replacer array: that is an allowlist applied at every
 * depth, so a nested object's keys are dropped and it serialises as `{}`.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The result if it arrives within `ms`, else undefined. An aborted signal ends the wait and is not a result. Never rejects. */
function settleWithin(promise: Promise<CallToolResult>, ms: number, signal?: AbortSignal): Promise<CallToolResult | undefined> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve(undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
    if (!signal) return;
    onAbort = () => resolve(undefined);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  });
}

/** `notifications/cancelled` and a dropped HTTP response are both "the caller did not get this". */
function linkSignals(explicit: AbortSignal | undefined, transport: AbortSignal | undefined): { signal: AbortSignal | undefined; stop: () => void } {
  if (!explicit) return { signal: transport, stop: () => {} };
  if (!transport) return { signal: explicit, stop: () => {} };
  const linked = new AbortController();
  const onAbort = (): void => linked.abort();
  if (explicit.aborted || transport.aborted) linked.abort();
  else {
    explicit.addEventListener('abort', onAbort);
    transport.addEventListener('abort', onAbort);
  }
  return {
    signal: linked.signal,
    stop: () => {
      explicit.removeEventListener('abort', onAbort);
      transport.removeEventListener('abort', onAbort);
    },
  };
}

function sweep(now: number): void {
  for (const p of parked.values()) {
    if (p.settledAt === undefined) {
      // Past the cap the result is given up on, and the chart lock with it.
      // A scrape can fail to settle at all, and an entry kept for one would
      // block switch_proxy_target for the life of the process with no call
      // able to clear it.
      if (now - p.startedAt >= MAX_RUN_MS) forget(p, 'given up on after running 10 minutes');
    } else if (p.abandoned) {
      forget(p, 'abandoned, and its result discarded when it finished');
    } else if (now - p.settledAt >= MAX_RUN_MS) {
      forget(p, 'left uncollected for 10 minutes after it finished, and dropped');
    }
  }
}

function describe(p: Parked, now: number): string {
  const state =
    p.settledAt !== undefined ? 'finished, result unread'
      : p.abandoned ? `abandoned, but still reading after ${elapsed(p.startedAt, now)}`
        : `running for ${elapsed(p.startedAt, now)}`;
  return `${p.tool} (id "${p.id}", ${state}${p.account ? `, on ${p.account}` : ''})`;
}

/** Every parked call, oldest first — what blocks a repeat or a proxy switch. */
function listing(now: number): string {
  const all = [...parked.values()].sort((a, b) => a.startedAt - b.startedAt);
  return all.length ? all.map((p) => describe(p, now)).join('; ') : 'nothing is pending';
}

function parkNote(tool: string, id: string): string {
  return (
    `${tool} (id "${id}") is still running after ${parkDeadlineLabel} and keeps running in the background for up ` +
    `to 10 minutes. Call ${CHECK_TOOL} with that id to wait for and read its result. An identical retry joins ` +
    'this same call instead of starting another, so a tool that sends something is not sent twice. Other tools are unaffected.'
  );
}

/** The result was abandoned while a caller was still waiting. They get the discard note, not the payload. */
function discardFinished(entry: Parked): CallToolResult {
  forget(entry, 'abandoned, and its result discarded when it finished');
  const freed = entry.account ? ` switch_proxy_target on ${entry.account} is free again.` : '';
  return text(`${entry.tool} has finished, and its result was discarded because the call was abandoned.${freed}`);
}

/**
 * Forget a result a caller is about to receive. On HTTP that waits until the response has ended:
 * the handler returning is not the client having the bytes, and a socket that closes first must
 * leave the result parked so a retry does not run the tool again.
 */
function releaseIfWritten(entry: Parked, why: string): void {
  const forgetWritten = (wrote: boolean): void => {
    if (!wrote || !parked.has(entry.id)) return;
    if (entry.abandoned) {
      forget(entry, 'abandoned, and its result discarded when it finished');
      return;
    }
    entry.delivered = true;
    forget(entry, why);
  };
  const notify = responseDelivery.getStore();
  if (!notify) {
    forgetWritten(true);
    return;
  }
  notify(forgetWritten);
}

/** A second HTTP request for a call that is already running. One execution, shared result. */
async function joinParked(entry: Parked, deadlineMs: number, signal?: AbortSignal): Promise<CallToolResult> {
  const linked = linkSignals(signal, lostResponse.getStore());
  const stop = linked.signal;
  let result = entry.result;
  waitingGuards += 1;
  try {
    if (result === undefined && !stop?.aborted) result = await settleWithin(entry.promise, deadlineMs, stop);
  } finally {
    waitingGuards -= 1;
    linked.stop();
  }
  if (stop?.aborted || !result) return stillRunning(parkNote(entry.tool, entry.id), entry.id);
  if (entry.abandoned) return discardFinished(entry);
  releaseIfWritten(entry, 'collected');
  return result;
}

/** Run a tool's handler under the deadline. `deadlineMs` is the test seam. */
export async function runGuarded(
  tool: string,
  args: Record<string, unknown>,
  fn: () => CallToolResult | Promise<CallToolResult>,
  deadlineMs = parkDeadlineMs,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  const now = Date.now();
  sweep(now);
  const key = `${tool} ${canonical(args)}`;
  const same = [...parked.values()].find((p) => p.key === key && !p.abandoned);
  if (same) {
    // HTTP retries join the call already in flight so a write cannot run twice.
    // Stdio keeps the old behavior: a second call inside the deadline runs,
    // and only a call that has already parked is refused.
    if (lostResponse.getStore()) return joinParked(same, deadlineMs, signal);
    const state = same.settledAt === undefined ? `running (started ${elapsed(same.startedAt, now)} ago)` : 'finished, with its result unread';
    return text(`This exact call is already ${state}. Call ${CHECK_TOOL} with id "${same.id}" instead of running it again.`, true);
  }

  const account = typeof args.account === 'string' ? args.account.trim().toLowerCase() : null;
  // Reserve the key before the first await. Two HTTP requests can otherwise
  // both pass the check above and both run the tool. The handler runs inside
  // executingCall so a switch does not treat this reservation as another read.
  const reservedId = lostResponse.getStore() ? randomUUID() : undefined;
  const promise = Promise.resolve()
    .then(() => (reservedId ? executingCall.run(reservedId, fn) : fn()))
    .catch((err: unknown) => text(`Error: ${(err as Error).message}`, true));
  const reserved: Parked | undefined = reservedId
    ? { id: reservedId, tool, key, account, startedAt: now, promise }
    : undefined;
  if (reserved) {
    parked.set(reserved.id, reserved);
    void promise.then((r) => {
      reserved.result = r;
      reserved.settledAt = Date.now();
    });
  }
  const linked = linkSignals(signal, lostResponse.getStore());
  const stop = linked.signal;
  let result: CallToolResult | undefined;
  waitingGuards += 1;
  try {
    result = await settleWithin(promise, deadlineMs, stop);
  } finally {
    waitingGuards -= 1;
    linked.stop();
  }
  // A disconnect during this wait must not take the direct return. The bytes
  // would go nowhere, the call would not be parked, and a retry could send twice.
  if (result && !stop?.aborted) {
    if (reserved?.abandoned) return discardFinished(reserved);
    if (reserved) {
      reserved.result = result;
      reserved.settledAt ??= Date.now();
      releaseIfWritten(reserved, 'collected');
    }
    return result;
  }
  if (reserved?.delivered) return result ?? reserved.result ?? stillRunning(parkNote(tool, reserved.id), reserved.id);
  if (reserved) {
    if (!parked.has(reserved.id)) parked.set(reserved.id, reserved);
    return stillRunning(parkNote(tool, reserved.id), reserved.id);
  }

  const entry: Parked = { id: randomUUID(), tool, key, account, startedAt: now, promise };
  parked.set(entry.id, entry);
  void promise.then((r) => {
    entry.result = r;
    entry.settledAt = Date.now();
  });
  return stillRunning(
    `${tool} (id "${entry.id}") is still running after ${parkDeadlineLabel} and keeps running in the background for up ` +
      `to 10 minutes. Call ${CHECK_TOOL} with that id to wait for and read its result. Do NOT call ${tool} again ` +
      'with the same arguments; it would be refused. Other tools are unaffected.',
    entry.id,
  );
}

/** The parked call still reading this account's chart, abandoned or not. Skips the call asking. */
export function unsettledCallOnAccount(account: string): { tool: string; id: string } | undefined {
  sweep(Date.now());
  const wanted = account.trim().toLowerCase();
  const self = executingCall.getStore();
  return [...parked.values()].find((p) => p.id !== self && p.settledAt === undefined && p.account === wanted);
}

/**
 * The `check_pending_call` handler. `deadlineMs` is the test seam.
 * `signal` is the MCP request's cancel signal. A dropped HTTP response is
 * noticed through `withLostResponse` and treated the same way: the result
 * stays parked, because this return never reached the client.
 */
export async function checkPendingCall(
  { id, wait, abandon }: { id?: string; wait?: boolean; abandon?: boolean },
  deadlineMs = parkDeadlineMs,
  signal?: AbortSignal,
): Promise<CallToolResult> {
  const now = Date.now();
  sweep(now);
  // The listing is read through the same sweep as every guard, so what it says
  // is pending is exactly what can be blocking a repeat or a proxy switch.
  if (id === undefined) return text(`Pending calls: ${listing(now)}.`);
  const p = parked.get(id);
  if (!p) {
    const why = gone.get(id) ?? 'no call with that id was parked here';
    return text(`No pending call has id "${id}": ${why}, and it is holding nothing. Pending calls: ${listing(now)}.`, true);
  }

  if (abandon) {
    if (p.settledAt !== undefined) {
      forget(p, 'abandoned, and its finished result discarded unread');
      return text(`Abandoned ${p.tool}: its finished result was discarded unread.`);
    }
    p.abandoned = true;
    const guard = p.account
      ? ` switch_proxy_target on ${p.account} refuses until the read finishes; call ${CHECK_TOOL} with this id again to wait for that.`
      : '';
    return text(`Abandoned ${p.tool}. ${ABANDON_MEANS}${guard}`);
  }

  // An abandoned call's result is not the caller's any more, but its scrape is
  // still reading the chart, so waiting here is how they see the account come
  // free — which is exactly what switch_proxy_target's refusal tells them to
  // do. Short-circuiting here instead left that instruction unfollowable.
  const linked = linkSignals(signal, lostResponse.getStore());
  const stop = linked.signal;

  try {
    // A wait that would run past the cap is cut to the cap, and running that
    // out means the cap is reached even if the test clock never moved.
    const remaining = MAX_RUN_MS - (now - p.startedAt);
    const clipped = remaining <= deadlineMs;
    let result = p.result;
    if (result === undefined && wait !== false && !stop?.aborted) {
      waitingCollections += 1;
      try {
        result = await settleWithin(p.promise, clipped ? remaining : deadlineMs, stop);
      } finally {
        waitingCollections -= 1;
      }
    }
    // Checked before forget. The result may have landed during the wait, on a
    // connection that is already gone; removing it here is what made a retry
    // report the call as collected.
    if (stop?.aborted) {
      const how = `Call ${CHECK_TOOL} again to keep waiting, or with abandon: true to stop waiting. ${ABANDON_MEANS}`;
      return stillRunning(`${p.tool} (id "${id}") is still running (${elapsed(p.startedAt, Date.now())} so far, of at most 10 minutes). ${how}`, id);
    }
    if (result) {
      // Read after the wait. Abandon can land while this collection is blocked,
      // and the flag from before the wait would still hand over the payload.
      if (p.abandoned) return discardFinished(p);
      releaseIfWritten(p, 'collected');
      return result;
    }
    if (wait !== false && clipped) {
      forget(p, 'given up on after running 10 minutes');
      return text(`Gave up on ${p.tool} after 10 minutes. Its result is discarded and this account is no longer held. ${ABANDON_MEANS}`, true);
    }
    const how = p.abandoned
      ? `Its result will be discarded, because it was abandoned. Call ${CHECK_TOOL} again to wait for the account to come free.`
      : `Call ${CHECK_TOOL} again to keep waiting, or with abandon: true to stop waiting. ${ABANDON_MEANS}`;
    return stillRunning(`${p.tool} (id "${id}") is still running (${elapsed(p.startedAt, Date.now())} so far, of at most 10 minutes). ${how}`, id);
  } finally {
    linked.stop();
  }
}

/** Test seam. */
export function resetPendingCalls(): void {
  parked.clear();
  gone.clear();
  waitingCollections = 0;
  waitingGuards = 0;
}
