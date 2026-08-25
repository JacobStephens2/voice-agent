export function parseOptions(arguments_: readonly string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (name === undefined || value === undefined || !name.startsWith("--")) {
      throw new Error("Options must be provided as --name value pairs");
    }
    const key = name.slice(2);
    if (parsed.has(key)) throw new Error(`Duplicate option --${key}`);
    parsed.set(key, value);
  }
  return parsed;
}

export function requireOnlyOptions(
  options: ReadonlyMap<string, string>,
  allowed: readonly string[],
): void {
  for (const name of options.keys()) {
    if (!allowed.includes(name)) throw new Error(`Unknown option --${name}`);
  }
}

export function requiredOption(
  options: ReadonlyMap<string, string>,
  name: string,
): string {
  const value = options.get(name);
  if (value === undefined || value.length === 0) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

export function requiredIntegerOption(
  options: ReadonlyMap<string, string>,
  name: string,
): number {
  const raw = requiredOption(options, name);
  if (!/^\d+$/u.test(raw)) throw new Error(`--${name} must be an integer`);
  return Number(raw);
}

export function requiredBooleanOption(
  options: ReadonlyMap<string, string>,
  name: string,
): boolean {
  const raw = requiredOption(options, name);
  if (raw !== "true" && raw !== "false") {
    throw new Error(`--${name} must be true or false`);
  }
  return raw === "true";
}
