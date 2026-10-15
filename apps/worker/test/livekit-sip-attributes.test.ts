import { expect, test } from "vitest";

import { normalizeTelnyxSipTelephoneNumber } from "../src/livekit-sip-attributes.ts";

test("Telnyx SIP numbers preserve E.164 and expand the observed NANP format", () => {
  expect(normalizeTelnyxSipTelephoneNumber("2155550147")).toBe(
    "+12155550147",
  );
  expect(normalizeTelnyxSipTelephoneNumber("12675550188")).toBe(
    "+12675550188",
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
