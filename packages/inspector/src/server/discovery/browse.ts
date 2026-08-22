/**
 * Directory browsing for the SQLite scan dialog.
 *
 * The SQLite probe takes a directory and globs it for Act stores, and until
 * now the only way to supply one was to type an absolute path. A browser file
 * picker cannot help here: it hands back sandboxed names, never a real path,
 * and the probe runs server-side against Node's `readdir`. So picking a
 * directory means listing directories on the server and letting the UI walk
 * them.
 *
 * This grants no access the inspector did not already have — the scan input
 * has always accepted an arbitrary path and `readdir`'d it, and the server
 * binds to loopback by default. Browsing makes that reachable without knowing
 * the path in advance; it does not widen what is reachable.
 */
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { DEFAULT_FILE_PATTERN, expandTilde } from "./sqlite-probe.js";

/** One navigable subdirectory. */
export type BrowseEntry = {
  readonly name: string;
  readonly path: string;
};

export type BrowseResult = {
  /** The resolved absolute directory being listed. */
  readonly path: string;
  /** Parent directory, or `null` at the filesystem root. */
  readonly parent: string | null;
  /** Subdirectories, alphabetical, unreadable ones omitted. */
  readonly dirs: ReadonlyArray<BrowseEntry>;
  /**
   * How many files here look like SQLite databases.
   *
   * The point of the whole dialog is finding a directory worth scanning, and
   * a bare list of folder names does not tell you that. This does, without
   * opening anything — it is a name match, not a probe, so a non-Act database
   * still counts. Scanning is what separates those.
   */
  readonly matches: number;
};

/**
 * List the subdirectories of `dir`, plus how many database-looking files it
 * holds.
 *
 * Unreadable entries are skipped rather than failing the listing: a directory
 * with one permission-denied child is still worth showing, and the operator
 * cannot act on a stat error for a folder they were only passing through.
 *
 * @param dir - Directory to list. `~` expands, relative paths resolve against
 *   the server's working directory, and an empty value means that directory.
 */
export async function browseDirectory(dir?: string): Promise<BrowseResult> {
  const target = path.resolve(expandTilde(dir?.trim() || process.cwd()));

  let entries: string[];
  try {
    entries = await readdir(target);
  } catch {
    // Missing, unreadable, or not a directory. Fall back to the home
    // directory rather than erroring: the dialog stays usable, and a typo in
    // a typed path should not strand the operator with no way back.
    const home = homedir();
    if (target === home)
      return { path: home, parent: null, dirs: [], matches: 0 };
    return browseDirectory(home);
  }

  const dirs: BrowseEntry[] = [];
  let matches = 0;
  await Promise.all(
    entries.map(async (name) => {
      const full = path.join(target, name);
      try {
        const info = await stat(full);
        if (info.isDirectory()) dirs.push({ name, path: full });
        else if (DEFAULT_FILE_PATTERN.test(name)) matches++;
      } catch {
        // Broken symlink or permission denied — not navigable, so not listed.
      }
    })
  );

  dirs.sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(target);
  return {
    path: target,
    // `path.dirname` of a root returns the root itself, which would render a
    // "go up" control that goes nowhere.
    parent: parent === target ? null : parent,
    dirs,
    matches,
  };
}
