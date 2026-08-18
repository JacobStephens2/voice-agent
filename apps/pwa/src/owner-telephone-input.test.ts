import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeOwnerTelephoneInput } from "./owner-telephone-input.ts";

test("keeps a pasted formatted owner telephone editable as E.164", () => {
  assert.equal(normalizeOwnerTelephoneInput("+1 555 010 1234"), "+15550101234");
  assert.equal(normalizeOwnerTelephoneInput("1 (555) 010-1234"), "+15550101234");
  assert.equal(normalizeOwnerTelephoneInput("+"), "+");
  assert.equal(normalizeOwnerTelephoneInput("267"), "267");
});
