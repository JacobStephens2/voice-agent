import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Acceptance records are edited by an operator between attended runs, so every
 * write takes a lock and lands atomically: a half-written record would be an
 * acceptance claim nobody could read back.
 */
export async function withRecordLock(
  recordPath: string,
  action: () => Promise<void>,
): Promise<void> {
  await mkdir(dirname(recordPath), { recursive: true });
  const lockPath = `${recordPath}.lock`;
  const lock = await open(lockPath, "wx", 0o600);
  try {
    await action();
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

export function serializeRecord(record: unknown): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

export async function createRecordFile(
  recordPath: string,
  record: unknown,
): Promise<void> {
  await withRecordLock(recordPath, async () => {
    await mkdir(dirname(recordPath), { recursive: true });
    await writeFile(recordPath, serializeRecord(record), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
  });
}

export async function readRecordFile<Record>(
  recordPath: string,
  parse: (input: unknown) => Record,
): Promise<Record> {
  return parse(JSON.parse(await readFile(recordPath, "utf8")));
}

export async function updateRecordFile<Record>(
  recordPath: string,
  parse: (input: unknown) => Record,
  update: (record: Record) => Record,
): Promise<void> {
  await withRecordLock(recordPath, async () => {
    const updated = update(await readRecordFile(recordPath, parse));
    const candidatePath = `${recordPath}.${process.pid}.tmp`;
    try {
      await writeFile(candidatePath, serializeRecord(updated), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o644,
      });
      await rename(candidatePath, recordPath);
    } catch (error) {
      await unlink(candidatePath).catch(() => undefined);
      throw error;
    }
  });
}
