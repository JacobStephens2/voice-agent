import { APITimeoutError } from "@livekit/agents";
import { describe, expect, test } from "vitest";

import { describeProviderError } from "../src/provider-error-description.ts";

describe("sanitized provider error description", () => {
  test("an Error keeps its type and message", () => {
    expect(
      describeProviderError(
        new APITimeoutError({ message: "Speech synthesis timed out" }),
        "tts",
      ),
    ).toStrictEqual({
      message: "Speech synthesis timed out",
      name: "APITimeoutError",
    });
  });

  test("a status and a code are carried when the provider supplies them", () => {
    const error = Object.assign(new Error("Bad gateway"), {
      code: "upstream_unavailable",
      status: 502,
    });

    expect(describeProviderError(error, "tts")).toStrictEqual({
      code: "upstream_unavailable",
      message: "Bad gateway",
      name: "Error",
      status: 502,
    });
  });

  test("a recognition failure never carries its message, which may echo a transcript", () => {
    const error = Object.assign(
      new Error("could not transcribe: cancel the Bountywell drill"),
      { status: 400 },
    );

    expect(describeProviderError(error, "stt")).toStrictEqual({
      name: "Error",
      status: 400,
    });
  });

  test("an interpretation failure is equally strict, since its prompt holds the transcript", () => {
    expect(
      describeProviderError(
        new Error("bad request: cancel the Bountywell drill"),
        "coordinator",
      ),
    ).toStrictEqual({ name: "Error" });
  });

  test("a session-setup failure keeps its message, which sees no caller speech", () => {
    expect(
      describeProviderError(new Error("room join refused"), "setup"),
    ).toStrictEqual({ message: "room join refused", name: "Error" });
  });

  test("a long message is truncated rather than logged whole", () => {
    const description = describeProviderError(new Error("x".repeat(500)), "tts");

    expect(description.message).toHaveLength(200);
    expect(description.message?.endsWith("…")).toBe(true);
  });

  test("newlines and control characters are collapsed to single spaces", () => {
    expect(
      describeProviderError(new Error("first line\n\tsecond line"), "tts")
        .message,
    ).toBe("first line second line");
  });

  test("a value that is not an Error is described by its type alone", () => {
    expect(describeProviderError("provider exploded", "tts")).toStrictEqual({
      name: "string",
    });
    expect(describeProviderError(undefined, "tts")).toStrictEqual({
      name: "undefined",
    });
    expect(describeProviderError(null, "setup")).toStrictEqual({
      name: "null",
    });
  });

  test("a non-string code or status is dropped rather than coerced", () => {
    const error = Object.assign(new Error("odd"), { code: 7, status: "502" });

    expect(describeProviderError(error, "tts")).toStrictEqual({
      message: "odd",
      name: "Error",
    });
  });
});
