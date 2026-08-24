# Register a one-line label so a compressed table column cannot change a control's height

Delegation `cafd2243` produced a candidate that matched Remove exactly on the desktop viewport — same background, box shadow, colour, typography, vertical padding, and a 32px height — passed the registered PHPUnit verification, and left card view byte-identical. It failed on `mobile Keeplore controls differ in height`: at 390px, Get Rid Of measured 43.1875px against Remove's 32px.

Nothing in the candidate caused that. At 390px the `td.get-rid-of` column is compressed to 76.171875px — the exact width of the one-word "Remove" label — and "Get Rid Of" wraps onto a second line. Two lines of text at the registered font size are 32px of content, and the registered 0.35rem vertical padding adds the remaining 11.1875px. The control differs in height precisely because it matches in padding and typography.

The Delegation Brief's constraints made this unreachable. The candidate may append exactly one ordinary rule with no at-rule, so restricted Codex cannot write the `@media` rule a person would reach for, and it may not set `width`, because content-based widths are themselves an acceptance criterion. Every declaration it was allowed to write left the label wrapping.

`white-space` is therefore registered, for the value `nowrap` alone. Holding the label on one line is what the criterion asks for read literally — the two controls then match in height at both verification viewports while each keeps a content-based width, and the column widens to the label instead of the label folding into the column. No other value of the property matches anything; `pre-wrap`, `normal`, and the rest only change wrapping, so the guard admits the property by value rather than by name. Adding `width` or an at-rule was rejected for the same reason it was rejected originally: both are scope, not matching.

The guard moved out of the executor script into `keeplore-table-only-candidate.ts` so the registered rule shape is testable without a Delegation. It was previously reachable only by running the executor end to end against a real worktree, which is why its interaction with the criteria was discovered by a live trial rather than by a test.

## Consequences

The mobile table row is now as wide as the Get Rid Of label demands. That column already compressed below its content at 390px, and the table is horizontally scrollable there with card view offered as the mobile presentation, so the wider column is visible rather than structural.

Restricted Codex is told about the second viewport explicitly. The prompt now names both measurement widths and the compression that causes the wrap, because the model cannot see the rendered page: the trusted runner owns the browser, and a model asked only to "match Remove" will keep producing a candidate that matches everywhere except where the column is narrow.

The criterion itself now names both verification viewports, so a Delegation Brief says what is actually measured. Every Brief accepted before that wording is still readable: the older sentence stays registered beside the current one rather than being migrated away, because the measurement never changed and a stored Brief is a record of what was delegated. A criteria literal that only new Briefs could satisfy would take down every Delegation listing, including the status and Stop turns a live call depends on.

Registering a property by value is a new shape in this guard. Every other registered property is admitted by name with any value that carries no `@`, `url(`, or `expression(`. `white-space` is the first whose safe set is a single keyword, and a later property with the same character should follow it rather than widening the name-only set.
