import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

/**
 * Validates the whole Release before the standalone acceptance CLI opens the
 * production evidence store. Symlinks are inspected but never traversed.
 */
export async function activeReleaseTreeIsOwnedAndImmutable(
  releaseRoot: string,
  expectedOwnerUid: number,
): Promise<boolean> {
  if (!isAbsolute(releaseRoot)) return false;
  const canonicalRoot = await realpath(releaseRoot);
  if (canonicalRoot !== releaseRoot) return false;
  const pending = [canonicalRoot];
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined) return false;
    const metadata = await lstat(path);
    if (metadata.uid !== expectedOwnerUid) return false;
    if (metadata.isSymbolicLink()) {
      const target = await realpath(path);
      if (!pathIsWithin(canonicalRoot, target)) return false;
      continue;
    }
    if ((metadata.mode & 0o222) !== 0) return false;
    if (metadata.isDirectory()) {
      const entries = await readdir(path);
      pending.push(...entries.map((entry) => join(path, entry)));
    } else if (!metadata.isFile()) {
      return false;
    }
  }
  return true;
}

function pathIsWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!isAbsolute(pathFromRoot) &&
      pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`))
  );
}
