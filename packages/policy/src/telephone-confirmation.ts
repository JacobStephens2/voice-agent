/**
 * How one sanitized telephone turn answers a pending Task Confirmation.
 *
 * `ambiguous` is a first-class outcome rather than an implicit decline: the
 * pending Task Confirmation survives speech the classifier cannot read, so an
 * unrecognized turn never silently consumes the owner's decision.
 */
export type ConfirmationSpeech = "affirmative" | "ambiguous" | "negative";

/**
 * Words that reverse the meaning of any affirmative fragment in the same turn.
 * Explicit negation is checked before affirmation so that mixed speech such as
 * "yes — no, don't" declines rather than confirms.
 */
const negativeTokens = new Set([
  "abort",
  "cancel",
  "decline",
  "dont",
  "halt",
  "incorrect",
  "nah",
  "negative",
  "never",
  "no",
  "nope",
  "not",
  "nothing",
  "stop",
  "wrong",
]);

/**
 * Words that qualify an affirmative into a conditional or counter-proposal.
 * A qualified answer is a decline: the readback the owner heard is not the task
 * they are willing to accept, so it must be requested again rather than taken.
 */
const qualifierTokens = new Set([
  "although",
  "but",
  "except",
  "however",
  "if",
  "instead",
  "provided",
  "though",
  "unless",
  "whereas",
]);

/**
 * Discourse filler that carries no decision. It is skipped between affirmative
 * fragments so that ordinary speech such as "well, okay then" reads as the
 * plain affirmative it is.
 */
const fillerTokens = new Set([
  "ah",
  "alright",
  "and",
  "er",
  "hmm",
  "just",
  "mhm",
  "now",
  "oh",
  "please",
  "so",
  "sorry",
  "then",
  "uh",
  "um",
  "well",
]);

/**
 * Fragments that decide by themselves, longest first. Real callers combine them
 * freely ("I confirm — yes", "yes, I confirm", "yes yes"), so the classifier
 * consumes fragments repeatedly instead of matching one canonical phrase.
 */
const decisiveAffirmativePhrases = [
  "that is exactly right",
  "that sounds correct",
  "that is correct",
  "that is right",
  "that is it",
  "i do confirm",
  "i can confirm",
  "sounds good",
  "go ahead",
  "carry on",
  "i confirm",
  "of course",
  "will do",
  "do it",
  "confirmed",
  "confirm",
  "absolutely",
  "definitely",
  "certainly",
  "affirmative",
  "correct",
  "proceed",
  "agreed",
  "approved",
  "yes",
  "yeah",
  "yep",
  "yup",
  "yah",
  "ya",
  "aye",
] as const;

/**
 * Acknowledgments that answer a direct question but also open a thought aloud.
 * On their own they confirm; beside discourse filler ("okay, so…", "right,
 * then…") the turn is someone thinking, not deciding, so it stays ambiguous.
 */
const weakAffirmativePhrases = [
  "okay",
  "ok",
  "sure",
  "right",
  "fine",
] as const;

const decisiveWordSequences = decisiveAffirmativePhrases.map((phrase) =>
  phrase.split(" "),
);
const weakWordSequences = weakAffirmativePhrases.map((phrase) =>
  phrase.split(" "),
);

/**
 * Classify how a sanitized finalized telephone turn answers a pending Task
 * Confirmation.
 *
 * Explicit negation and qualification win over any affirmative fragment. A turn
 * carrying a decisive fragment confirms; a bare acknowledgment confirms only
 * when nothing else was said. Everything else is ambiguous, which leaves the
 * pending Task Confirmation untouched.
 */
export function classifyConfirmationSpeech(text: string): ConfirmationSpeech {
  const words = normalizeConfirmationSpeech(text);
  if (words.length === 0) return "ambiguous";
  if (
    words.some((word) => negativeTokens.has(word) || qualifierTokens.has(word))
  ) {
    return "negative";
  }
  let index = 0;
  let decisive = 0;
  let weak = 0;
  let filler = 0;
  while (index < words.length) {
    const decisiveSequence = decisiveWordSequences.find((candidate) =>
      candidate.every((word, offset) => words[index + offset] === word),
    );
    if (decisiveSequence !== undefined) {
      index += decisiveSequence.length;
      decisive += 1;
      continue;
    }
    const weakSequence = weakWordSequences.find((candidate) =>
      candidate.every((word, offset) => words[index + offset] === word),
    );
    if (weakSequence !== undefined) {
      index += weakSequence.length;
      weak += 1;
      continue;
    }
    const word = words[index];
    if (word === undefined || !fillerTokens.has(word)) return "ambiguous";
    filler += 1;
    index += 1;
  }
  if (decisive > 0) return "affirmative";
  return weak > 0 && filler === 0 ? "affirmative" : "ambiguous";
}

/**
 * Reduce a sanitized transcript to comparable words. Dashes and apostrophes are
 * separators or noise rather than meaning, so "I confirm—yes", "that's correct"
 * and "don't" reach the classifier as the words a listener would hear.
 */
function normalizeConfirmationSpeech(text: string): readonly string[] {
  return text
    .toLocaleLowerCase("en-US")
    .replace(/[‘’]/gu, "'")
    .replace(/\bthat's\b/gu, "that is")
    .replace(/'/gu, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .split(" ")
    .filter((word) => word.length > 0);
}
