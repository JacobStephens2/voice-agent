import {
  APIStatusError,
  APITimeoutError,
  UnexpectedModelBehavior,
} from "@livekit/agents";
import { TelephoneSessionFault } from "@voice-agent/runtime";
import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  describeProviderError,
  ProviderReportedError,
} from "../src/provider-error-description.ts";

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

  test("a recognition provider's message is withheld, since it may echo a transcript", () => {
    const error = new APIStatusError({
      message: "could not transcribe: cancel the Bountywell drill",
      options: { statusCode: 400 },
    });

    expect(describeProviderError(error, "stt")).toStrictEqual({
      name: "APIStatusError",
      status: 400,
    });
  });

  test("an interpretation provider is equally strict, since its prompt holds the transcript", () => {
    expect(
      describeProviderError(
        new APIStatusError({
          message: "bad request: cancel the Bountywell drill",
        }),
        "coordinator",
      ),
    ).toStrictEqual({ name: "APIStatusError" });
  });

  test("a framework report of unexpected model behaviour is withheld too", () => {
    expect(
      describeProviderError(
        new UnexpectedModelBehavior("the model replied: cancel the drill"),
        "coordinator",
      ),
    ).toStrictEqual({ name: "UnexpectedModelBehavior" });
  });

  test("a validation failure is withheld, since it names the value that failed", () => {
    const error = z
      .object({ intent: z.enum(["stop", "unrelated"]) })
      .safeParse({ intent: "cancel the Bountywell drill" }).error;

    expect(describeProviderError(error, "coordinator")).toStrictEqual({
      name: "ZodError",
    });
  });

  test("an ordinary error at a caller-speech stage keeps its message", () => {
    // The fault that prompted this rule arrived here: a plain Error raised by
    // code in this repository, withheld because the stage it escaped through
    // is handed the caller's words.
    const error = Object.assign(new Error("evidence append failed"), {
      status: 500,
    });

    expect(describeProviderError(error, "coordinator")).toStrictEqual({
      message: "evidence append failed",
      name: "Error",
      status: 500,
    });
  });

  test("a fault raised in this system's own turn pipeline keeps its message", () => {
    expect(
      describeProviderError(
        new TelephoneSessionFault("Telephone audio output is unavailable"),
        "agent",
      ),
    ).toStrictEqual({
      message: "Telephone audio output is unavailable",
      name: "TelephoneSessionFault",
    });
  });

  test("an error the framework reported for a provider is withheld whatever its class", () => {
    // The session error event names the failing provider, so a plain Error
    // arriving that way is still the provider's account of itself.
    const error = new ProviderReportedError(
      Object.assign(new Error("could not transcribe: cancel the drill"), {
        status: 500,
      }),
    );

    expect(describeProviderError(error, "stt")).toStrictEqual({
      name: "Error",
      status: 500,
    });
  });

  test("a reported synthesis failure still keeps its message, which is the agent's own text", () => {
    expect(
      describeProviderError(
        new ProviderReportedError(new Error("voice unavailable")),
        "tts",
      ),
    ).toStrictEqual({ message: "voice unavailable", name: "Error" });
  });

  test("a session-setup failure keeps its message, which sees no caller speech", () => {
    expect(
      describeProviderError(new Error("room join refused"), "setup"),
    ).toStrictEqual({ message: "room join refused", name: "Error" });
  });

  test("a fault this codebase raised keeps its message at every stage", () => {
    // These messages are fixed strings written here, so no stage can leak a
    // caller's words through one.
    expect(
      describeProviderError(
        new TelephoneSessionFault(
          "Telephone coordinator returned an invalid typed intent",
        ),
        "coordinator",
      ),
    ).toStrictEqual({
      message: "Telephone coordinator returned an invalid typed intent",
      name: "TelephoneSessionFault",
    });
    expect(
      describeProviderError(
        new TelephoneSessionFault("Completed telephone turn identity is unavailable"),
        "stt",
      ),
    ).toStrictEqual({
      message: "Completed telephone turn identity is unavailable",
      name: "TelephoneSessionFault",
    });
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

  test("a provider SDK status stands in for a status field it does not carry", () => {
    expect(
      describeProviderError(
        new APIStatusError({
          message: "voice unavailable",
          options: { statusCode: 503 },
        }),
        "tts",
      ),
    ).toStrictEqual({
      message: "voice unavailable",
      name: "APIStatusError",
      status: 503,
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
