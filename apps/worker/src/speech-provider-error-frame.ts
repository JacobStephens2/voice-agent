import { inference } from "@livekit/agents";

import { sanitizeErrorMessage } from "./error-description.ts";

// A code is an enumerated token from the gateway. Bounding its shape is what
// keeps a free-text field from carrying anything of the call into the journal.
const codeToken = /^[\w.:-]+$/u;
const maximumCodeLength = 64;
const maximumReasonLength = 200;
/**
 * How long an observed frame may wait for the failure it explains.
 *
 * The gateway reports its error immediately before the framework gives up on
 * the stream, so the fault that follows is the one this frame belongs to. A
 * frame nothing claimed within the window is dropped rather than attributed to
 * an unrelated failure much later in the call.
 */
const stalenessWindowMs = 60_000;

/**
 * What kind of fault a speech provider reported, in the terms an operator acts
 * on: an upstream provider outage is waited out, and the other three are
 * misconfigurations of this system's own account.
 */
const speechProviderFaultClasses = [
  "credential",
  "entitlement",
  "quota",
  "unknown",
  "upstream",
] as const;
export type SpeechProviderFaultClass =
  (typeof speechProviderFaultClasses)[number];

/**
 * A speech gateway's own account of why it failed.
 *
 * The agents framework's error schema keeps only an optional message, so the
 * code, the reason, and the retryable flag the gateway sends are discarded
 * during parsing. This is that account, read off the raw frame before the
 * framework narrows it.
 */
export interface SpeechProviderErrorFrame {
  readonly code?: string;
  readonly fault: SpeechProviderFaultClass;
  readonly reason?: string;
  readonly retryable?: boolean;
}

/**
 * Read a gateway error frame, whatever shape it arrives in.
 *
 * The gateway is free to move its fields, and a frame this cannot recognize is
 * still the only account of the fault that exists: a shape that is not
 * understood yields whatever reason it does carry rather than nothing, and no
 * shape at all raises.
 */
export function parseSpeechProviderErrorFrame(
  raw: unknown,
): SpeechProviderErrorFrame | undefined {
  if (!isRecord(raw) || !isErrorFrame(raw)) return undefined;
  const nested = isRecord(raw.error) ? raw.error : {};
  const code = readCode(raw.code ?? raw.error_code ?? nested.code);
  const reason = readReason(raw, nested);
  const retryable = readRetryable(raw.retryable ?? nested.retryable);
  return {
    ...(code === undefined ? {} : { code }),
    fault: classifySpeechProviderFault(code, reason),
    ...(reason === undefined ? {} : { reason }),
    ...(retryable === undefined ? {} : { retryable }),
  };
}

/**
 * Name the fault class a code and reason describe.
 *
 * The distinction an operator needs from the journal is whether the provider
 * behind the gateway failed or this system's account with it is wrong, since
 * only the second one is worth waking up for.
 */
function classifySpeechProviderFault(
  code: string | undefined,
  reason: string | undefined,
): SpeechProviderFaultClass {
  const text = `${code ?? ""} ${reason ?? ""}`.toLowerCase();
  if (
    /unauthenticated|unauthorized|invalid[_ -]?(api[_ -]?key|token|credential)|bad[_ -]?credential|signature|expired[_ -]?token/u.test(
      text,
    )
  ) {
    return "credential";
  }
  if (
    /forbidden|permission|entitle|not[_ -]?enabled|not[_ -]?allowed|access[_ -]?denied|unsupported[_ -]?model|model[_ -]?not[_ -]?(found|available)/u.test(
      text,
    )
  ) {
    return "entitlement";
  }
  if (
    /quota|rate[_ -]?limit|too[_ -]?many|insufficient[_ -]?(credit|balance|funds)|billing|payment|budget/u.test(
      text,
    )
  ) {
    return "quota";
  }
  if (
    /upstream|provider|gateway|timeout|timed[_ -]?out|deadline|unavailable|overloaded|stall|connection|internal|5\d\d/u.test(
      text,
    )
  ) {
    return "upstream";
  }
  return "unknown";
}

/**
 * The frames one speech gateway connection reported, held for the fault that
 * follows them.
 */
export class SpeechProviderErrorFrameLog {
  readonly #now: () => number;
  #frame: SpeechProviderErrorFrame | undefined;
  #observedAtMs = 0;

  constructor(options: { readonly now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  /** Observe one raw websocket message; anything unreadable is ignored. */
  observe(data: unknown): void {
    let frame: SpeechProviderErrorFrame | undefined;
    try {
      frame = parseSpeechProviderErrorFrame(JSON.parse(String(data)));
    } catch {
      return;
    }
    if (frame === undefined) return;
    this.#frame = frame;
    this.#observedAtMs = this.#now();
  }

  /** The frame observed since the last take, if one is still fresh. */
  takeErrorFrame(): SpeechProviderErrorFrame | undefined {
    const frame = this.#frame;
    this.#frame = undefined;
    if (frame === undefined) return undefined;
    return this.#now() - this.#observedAtMs > stalenessWindowMs
      ? undefined
      : frame;
  }
}

/**
 * The synthesis provider this worker speaks through, keeping the gateway's own
 * account of any failure it reports.
 *
 * The framework parses each frame into a schema that drops the code, the
 * reason, and the retryable flag, so this reads the raw message alongside it.
 */
export class ObservedSpeechProviderTTS<
  TModel extends inference.TTSModels,
> extends inference.TTS<TModel> {
  readonly errorFrames = new SpeechProviderErrorFrameLog();

  override async connectWs(timeout: number) {
    const socket = await super.connectWs(timeout);
    observeErrorFrames(socket, this.errorFrames);
    return socket;
  }
}

/**
 * The recognition provider, observed the same way. Its frames name the same
 * faults, and a credential or quota fault is as diagnosable here as it is for
 * synthesis.
 */
export class ObservedSpeechProviderSTT<
  TModel extends inference.STTModels,
> extends inference.STT<TModel> {
  readonly errorFrames = new SpeechProviderErrorFrameLog();

  override async connectWs(timeout: number) {
    const socket = await super.connectWs(timeout);
    observeErrorFrames(socket, this.errorFrames);
    return socket;
  }
}

/** Read every frame the gateway sends beside the framework's own parse. */
function observeErrorFrames(
  socket: {
    readonly on: (
      event: "message",
      listener: (data: unknown) => void,
    ) => unknown;
  },
  frames: SpeechProviderErrorFrameLog,
): void {
  socket.on("message", (data) => {
    frames.observe(data);
  });
}

/** The frames a stage's provider kept, if it is one that keeps them. */
export function speechProviderErrorFrames(
  provider: unknown,
): SpeechProviderErrorFrameLog | undefined {
  const frames = isRecord(provider) ? provider.errorFrames : undefined;
  return frames instanceof SpeechProviderErrorFrameLog ? frames : undefined;
}

/**
 * Whether this frame is the gateway reporting a failure.
 *
 * The gateway is free to rename its discriminator, so a frame that carries an
 * error of its own and nothing this recognizes as another kind of frame is
 * read as one rather than dropped with its reason.
 */
function isErrorFrame(frame: Record<string, unknown>): boolean {
  const discriminator = frame.type ?? frame.event ?? frame.kind;
  if (typeof discriminator === "string") {
    return (
      discriminator === "error" ||
      discriminator.endsWith(".error") ||
      discriminator.endsWith("_error")
    );
  }
  return (
    discriminator === undefined &&
    (typeof frame.error === "string" || isRecord(frame.error))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCode(value: unknown): string | undefined {
  const code =
    typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : typeof value === "string"
        ? value.trim()
        : undefined;
  if (code === undefined || code === "") return undefined;
  return code.length <= maximumCodeLength && codeToken.test(code)
    ? code
    : undefined;
}

/**
 * Only the fields the gateway writes about itself are read. Whatever else the
 * frame echoes — a transcript it was handed, an audio payload, a caller
 * identity — is never looked at, so it cannot reach the journal.
 */
function readReason(
  frame: Record<string, unknown>,
  nested: Record<string, unknown>,
): string | undefined {
  const candidates = [
    frame.reason,
    frame.message,
    frame.detail,
    frame.description,
    nested.reason,
    nested.message,
    nested.detail,
    typeof frame.error === "string" ? frame.error : undefined,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const reason = sanitizeErrorMessage(candidate, maximumReasonLength);
    if (reason !== undefined) return reason;
  }
  return undefined;
}

function readRetryable(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}
