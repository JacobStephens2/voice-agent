export function normalizeOwnerTelephoneInput(value: string): string {
  const trimmed = value.trim();
  const hasLeadingPlus =
    trimmed.startsWith("+") || trimmed.startsWith("＋");
  const digits = trimmed.replace(/\D+/gu, "");
  if (digits.length === 0) return hasLeadingPlus ? "+" : "";
  return hasLeadingPlus || digits.length >= 10 ? `+${digits}` : digits;
}
