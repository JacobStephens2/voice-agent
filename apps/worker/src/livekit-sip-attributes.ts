import { e164TelephoneNumberSchema } from "@voice-agent/contracts";

export function normalizeTelnyxSipTelephoneNumber(
  value: string | undefined,
): string {
  if (value === undefined) return "malformed";
  if (e164TelephoneNumberSchema.safeParse(value).success) return value;

  const normalized =
    /^\d{10}$/.test(value)
      ? `+1${value}`
      : /^1\d{10}$/.test(value)
        ? `+${value}`
        : "malformed";
  return e164TelephoneNumberSchema.safeParse(normalized).success
    ? normalized
    : "malformed";
}
