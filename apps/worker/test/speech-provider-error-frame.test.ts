import { describe, expect, test } from "vitest";

import {
  parseSpeechProviderErrorFrame,
  SpeechProviderErrorFrameLog,
} from "../src/speech-provider-error-frame.ts";

describe("speech provider error frame", () => {
  test("a gateway error frame keeps its code, reason and retryable flag", () => {
    expect(
      parseSpeechProviderErrorFrame({
        code: "upstream_error",
        message: "inworld: upstream request timed out",
        retryable: true,
        session_id: "tts-session-001",
        type: "error",
      }),
    ).toStrictEqual({
      code: "upstream_error",
      fault: "upstream",
      reason: "inworld: upstream request timed out",
      retryable: true,
    });
  });

  test("a nested error object is read the same way", () => {
    expect(
      parseSpeechProviderErrorFrame({
        error: {
          code: "unauthenticated",
          reason: "invalid api key",
          retryable: false,
        },
        type: "error",
      }),
    ).toStrictEqual({
      code: "unauthenticated",
      fault: "credential",
      reason: "invalid api key",
      retryable: false,
    });
  });

  test("a frame carrying no reason at all is still a usable fault", () => {
    expect(parseSpeechProviderErrorFrame({ type: "error" })).toStrictEqual({
      fault: "unknown",
    });
  });

  test("an unrecognized shape keeps whatever reason it does carry", () => {
    expect(
      parseSpeechProviderErrorFrame({
        error: "quota exceeded for this project",
        status: 429,
        type: "error",
      }),
    ).toStrictEqual({
      fault: "quota",
      reason: "quota exceeded for this project",
    });
  });

  test("a numeric code is named rather than dropped", () => {
    expect(
      parseSpeechProviderErrorFrame({
        code: 503,
        message: "gateway unavailable",
        type: "error",
      }),
    ).toStrictEqual({
      code: "503",
      fault: "upstream",
      reason: "gateway unavailable",
    });
  });

  test.each([
    ["unauthenticated", "credential"],
    ["invalid_api_key", "credential"],
    ["permission_denied", "entitlement"],
    ["model_not_enabled", "entitlement"],
    ["insufficient_quota", "quota"],
    ["rate_limit_exceeded", "quota"],
    ["upstream_unavailable", "upstream"],
    ["provider_timeout", "upstream"],
    ["something_new", "unknown"],
  ])("%s is reported as a %s fault", (code, fault) => {
    expect(
      parseSpeechProviderErrorFrame({ code, type: "error" })?.fault,
    ).toBe(fault);
  });

  test("a deadline the upstream provider missed is not read as a quota fault", () => {
    // `exceeded` reads as quota anywhere it appears, which would invert the
    // one distinction an operator needs from this line.
    expect(
      parseSpeechProviderErrorFrame({
        message: "context deadline exceeded",
        type: "error",
      })?.fault,
    ).toBe("upstream");
  });

  test("an error frame whose discriminator moved is still read", () => {
    expect(
      parseSpeechProviderErrorFrame({
        error: { message: "upstream refused the request", retryable: true },
        event: "error",
      }),
    ).toStrictEqual({
      fault: "upstream",
      reason: "upstream refused the request",
      retryable: true,
    });
    expect(
      parseSpeechProviderErrorFrame({
        error: { code: "insufficient_quota", reason: "monthly quota spent" },
      }),
    ).toStrictEqual({
      code: "insufficient_quota",
      fault: "quota",
      reason: "monthly quota spent",
    });
  });

  test("a frame that is not an error frame is ignored", () => {
    expect(
      parseSpeechProviderErrorFrame({ session_id: "x", type: "session.created" }),
    ).toBeUndefined();
    expect(parseSpeechProviderErrorFrame("error")).toBeUndefined();
    expect(parseSpeechProviderErrorFrame(null)).toBeUndefined();
    // A transcript frame carries no error and names no failure, whatever
    // discriminator the gateway gives it.
    expect(
      parseSpeechProviderErrorFrame({
        transcript: "restart the Bountywell API",
      }),
    ).toBeUndefined();
  });

  test("nothing the gateway echoes back from the call is carried", () => {
    expect(
      parseSpeechProviderErrorFrame({
        audio: "AAAABBBB",
        code: "upstream_error",
        input_transcript: "restart the Bountywell API",
        message: "upstream refused the request",
        transcript: "restart the Bountywell API",
        type: "error",
      }),
    ).toStrictEqual({
      code: "upstream_error",
      fault: "upstream",
      reason: "upstream refused the request",
    });
  });

  test("a reason is bounded and collapsed to one log line", () => {
    const frame = parseSpeechProviderErrorFrame({
      message: `first line\n\tsecond line ${"x".repeat(500)}`,
      type: "error",
    });

    expect(frame?.reason).toHaveLength(200);
    expect(frame?.reason?.startsWith("first line second line")).toBe(true);
  });

  test("a code that is not a bounded token is dropped rather than logged", () => {
    expect(
      parseSpeechProviderErrorFrame({
        code: "restart the Bountywell API, said the caller",
        type: "error",
      }),
    ).toStrictEqual({ fault: "unknown" });
  });
});

describe("speech provider error frame log", () => {
  test("a raw websocket message is parsed and taken once", () => {
    const log = new SpeechProviderErrorFrameLog();

    log.observe(
      Buffer.from(
        JSON.stringify({
          code: "upstream_error",
          message: "upstream stalled",
          retryable: true,
          type: "error",
        }),
      ),
    );

    expect(log.takeErrorFrame()).toStrictEqual({
      code: "upstream_error",
      fault: "upstream",
      reason: "upstream stalled",
      retryable: true,
    });
    expect(log.takeErrorFrame()).toBeUndefined();
  });

  test("a message that is not JSON, or not an error, is ignored without throwing", () => {
    const log = new SpeechProviderErrorFrameLog();

    log.observe(Buffer.from("<not json>"));
    log.observe(Buffer.from(JSON.stringify({ type: "output_audio" })));
    log.observe(undefined);

    expect(log.takeErrorFrame()).toBeUndefined();
  });

  test("a frame older than the staleness window is not attributed to a later fault", () => {
    let now = 1_787_000_000_000;
    const log = new SpeechProviderErrorFrameLog({ now: () => now });

    log.observe(Buffer.from(JSON.stringify({ code: "upstream_error", type: "error" })));
    now += 61_000;

    expect(log.takeErrorFrame()).toBeUndefined();
  });
});
