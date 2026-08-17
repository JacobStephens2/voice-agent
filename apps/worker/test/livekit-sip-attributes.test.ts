import { expect, test } from "vitest";

import { normalizeTelnyxSipTelephoneNumber } from "../src/livekit-sip-attributes.ts";

test("Telnyx SIP numbers preserve E.164 and expand the observed NANP format", () => {
  expect(normalizeTelnyxSipTelephoneNumber("4843567773")).toBe(
    "+14843567773",
  );
  expect(normalizeTelnyxSipTelephoneNumber("17325062244")).toBe(
    "+17325062244",
  );
  expect(normalizeTelnyxSipTelephoneNumber("+12155550123")).toBe(
    "+12155550123",
  );
  expect(normalizeTelnyxSipTelephoneNumber("+442071838750")).toBe(
    "+442071838750",
  );
});

test("missing, malformed, or bare non-US SIP numbers remain untrusted", () => {
  expect(normalizeTelnyxSipTelephoneNumber(undefined)).toBe("malformed");
  expect(normalizeTelnyxSipTelephoneNumber("not-a-number")).toBe("malformed");
  expect(normalizeTelnyxSipTelephoneNumber("212555012")).toBe("malformed");
  expect(normalizeTelnyxSipTelephoneNumber("442071838750")).toBe("malformed");
});
