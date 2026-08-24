/**
 * A broken invariant inside the Telephone Session, raised by this codebase
 * rather than reported by a speech or interpretation provider.
 *
 * The distinction is what makes a fault safe to describe in the operator's
 * journal. A provider error may quote what it was given — the caller's audio
 * at recognition, the transcript in the interpretation prompt — so those
 * messages are withheld from the stages that see the caller's words. Every
 * message raised as this fault is a fixed string written here, carries nothing
 * from the call, and is therefore logged at every stage. Keep it that way:
 * never interpolate a transcript, a spoken response, or a caller identity into
 * one of these messages.
 */
export class TelephoneSessionFault extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelephoneSessionFault";
  }
}
