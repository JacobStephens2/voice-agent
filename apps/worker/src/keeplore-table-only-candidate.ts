/**
 * The registered shape of the one CSS rule restricted Codex may append.
 *
 * The trial's authority is the rule itself, not the model's intent: a candidate
 * is accepted only when it leaves the registered stylesheet byte-for-byte and
 * adds a single ordinary rule whose selector names the table-view control and
 * whose declarations are drawn from the registered matching properties. Every
 * other shape — a second rule, an at-rule, a URL, a width — is a widening of
 * scope and is refused before the candidate reaches the Delegated Worktree.
 */

const tableOnlySelector =
  "table#useBy:not(.cards-view) td.get-rid-of button.get-rid-of-btn";
const maximumAdditionBytes = 4_000;

/**
 * Properties that can carry a matching declaration.
 *
 * `white-space` is registered for `nowrap` alone. The table column can compress
 * the control below its label, and a wrapped label is a taller control at the
 * same padding and typography — the mobile height mismatch the trial exists to
 * remove. Holding the label on one line is the only wrapping mode that matches;
 * every other value would change wrapping without matching anything.
 */
const allowedProperties = new Set([
  "background",
  "background-color",
  "border",
  "border-color",
  "border-radius",
  "border-style",
  "border-width",
  "box-shadow",
  "color",
  "font-family",
  "font-size",
  "font-weight",
  "height",
  "letter-spacing",
  "line-height",
  "min-height",
  "padding",
  "padding-bottom",
  "padding-top",
  "text-transform",
  "white-space",
]);
const allowedPropertyValues = new Map([["white-space", new Set(["nowrap"])]]);

export function assertTableOnlyCandidate(
  baselineCss: string,
  candidateCss: string,
): void {
  if (!candidateCss.startsWith(baselineCss)) {
    throw new Error(
      "Keeplore candidate modified existing CSS instead of appending its scoped rule",
    );
  }
  const suffix = candidateCss.slice(baselineCss.length);
  if (suffix.length === 0 || suffix.length > maximumAdditionBytes) {
    throw new Error("Keeplore table-only CSS addition is absent or too large");
  }
  const withoutComments = suffix.replaceAll(/\/\*[\s\S]*?\*\//gu, "").trim();
  const rule = withoutComments.match(/^([^{}]+)\{([^{}]+)\}$/u);
  if (rule === null) {
    throw new Error(
      "Keeplore candidate must append exactly one ordinary CSS rule",
    );
  }
  const selector = rule[1]?.trim().replaceAll(/\s+/gu, " ");
  if (selector !== tableOnlySelector) {
    throw new Error(
      "Keeplore candidate selector is outside the registered table-only control",
    );
  }
  const declarations = rule[2]
    ?.split(";")
    .map((declaration) => declaration.trim())
    .filter(Boolean);
  if (declarations === undefined || declarations.length === 0) {
    throw new Error("Keeplore candidate contains no measurable declarations");
  }
  for (const declaration of declarations) {
    const parsed = declaration.match(/^([a-z-]+)\s*:\s*(.+)$/u);
    const property = parsed?.[1];
    const value = parsed?.[2];
    if (
      property === undefined ||
      value === undefined ||
      !allowedProperties.has(property) ||
      !isRegisteredValue(property, value) ||
      /(?:@|expression\s*\(|url\s*\()/iu.test(value)
    ) {
      throw new Error(
        "Keeplore candidate contains an unregistered CSS declaration",
      );
    }
  }
}

function isRegisteredValue(property: string, value: string): boolean {
  const registered = allowedPropertyValues.get(property);
  return registered === undefined || registered.has(value.trim());
}
