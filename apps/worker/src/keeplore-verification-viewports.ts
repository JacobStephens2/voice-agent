/**
 * The viewports authenticated Keeplore visual verification measures.
 *
 * The trusted runner owns the browser, so restricted Codex never sees the
 * rendered page and is told these widths in its prompt instead. They are named
 * once here so the widths the model is given cannot drift from the widths its
 * candidate is judged at.
 */
export const keeploreVerificationViewports = [
  { height: 900, name: "desktop", width: 1440 },
  { height: 844, name: "mobile", width: 390 },
] as const;

export function describeKeeploreVerificationWidths(): string {
  return keeploreVerificationViewports
    .map((viewport) => `${viewport.width}px ${viewport.name}`)
    .join(" and ");
}
