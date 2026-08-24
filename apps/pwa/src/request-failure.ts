/**
 * How a failed API request is described to the owner.
 *
 * Most failures are indistinguishable to a browser, so they keep a generic
 * wording. A routine rejection is different: the API answers 4xx with a
 * `reason` and a message the owner can act on — an expired deployment-authority
 * challenge, say — and repeating "could not be completed" over it would hide
 * the one sentence that says what to do next.
 */
export function describeRequestFailure(
  status: number,
  payload: unknown,
  fallback: string,
): string {
  if (
    status >= 400 &&
    status < 500 &&
    payload !== null &&
    typeof payload === "object" &&
    "reason" in payload &&
    "error" in payload &&
    typeof (payload as { readonly error: unknown }).error === "string"
  ) {
    return (payload as { readonly error: string }).error;
  }
  return status === 403 ? "The request failed its origin or CSRF check." : fallback;
}
