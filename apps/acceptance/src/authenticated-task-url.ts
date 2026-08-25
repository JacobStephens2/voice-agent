/**
 * The authenticated Voice Agent task link both acceptance records attest to.
 *
 * Slice one records it per PSTN run and slice three records it per production
 * verification; one rule keeps an acceptance claim from pointing at a page the
 * owner cannot open under their own session.
 */
export function isAuthenticatedTaskUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.origin === "https://voice.stephens.page" &&
    url.pathname === "/" &&
    url.searchParams.get("task") !== null
  );
}
