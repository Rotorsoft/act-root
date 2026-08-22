import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { browseDirectory } from "../../src/server/discovery/browse.js";

/**
 * Directory browsing for the SQLite scan dialog.
 *
 * A browser file picker cannot supply this — it hands back sandboxed names
 * rather than real paths, and the scan runs server-side — so the server lists
 * directories and the UI walks them.
 */
describe("browseDirectory", () => {
  const fixture = async () => {
    const root = await mkdtemp(path.join(tmpdir(), "act-browse-"));
    await mkdir(path.join(root, "beta"));
    await mkdir(path.join(root, "alpha"));
    await writeFile(path.join(root, "one.db"), "");
    await writeFile(path.join(root, "two.sqlite3"), "");
    await writeFile(path.join(root, "notes.txt"), "");
    return root;
  };

  it("lists subdirectories alphabetically and counts database files", async () => {
    const root = await fixture();
    const result = await browseDirectory(root);

    expect(result.dirs.map((d) => d.name)).toEqual(["alpha", "beta"]);
    // The number that tells an operator whether this folder is worth
    // scanning at all. `notes.txt` is not a database name, so it does not
    // count; neither directory does.
    expect(result.matches).toBe(2);
    expect(result.path).toBe(path.resolve(root));
  });

  it("returns each subdirectory's full path, so the UI can navigate", async () => {
    const root = await fixture();
    const result = await browseDirectory(root);
    expect(result.dirs[0].path).toBe(path.join(path.resolve(root), "alpha"));
  });

  it("exposes a parent to go up, and none at the filesystem root", async () => {
    const root = await fixture();
    expect(await browseDirectory(root)).toHaveProperty(
      "parent",
      path.dirname(path.resolve(root))
    );
    // `path.dirname` of a root is the root itself, which would render a "go
    // up" control that goes nowhere.
    expect((await browseDirectory("/")).parent).toBeNull();
  });

  it("defaults to the working directory when given nothing", async () => {
    expect((await browseDirectory()).path).toBe(path.resolve(process.cwd()));
    expect((await browseDirectory("   ")).path).toBe(
      path.resolve(process.cwd())
    );
  });

  it("expands a leading tilde, which operators type reflexively", async () => {
    expect((await browseDirectory("~")).path).toBe(path.resolve(homedir()));
  });

  it("falls back home rather than erroring on a path that does not exist", async () => {
    // A typo in a typed path must not strand the operator with no way back,
    // so the dialog lands somewhere navigable instead of throwing.
    const result = await browseDirectory(
      path.join(tmpdir(), "act-browse-does-not-exist-xyz")
    );
    expect(result.path).toBe(path.resolve(homedir()));
  });

  it("returns an empty listing when even the home directory is unreadable", async () => {
    // The recursion's base case. Reached by pointing at home when home
    // itself cannot be read — rare in practice, but it must terminate.
    const root = await mkdtemp(path.join(tmpdir(), "act-browse-locked-"));
    const locked = path.join(root, "locked");
    await mkdir(locked);
    await chmod(locked, 0o000);
    const original = process.env.HOME;
    process.env.HOME = locked;
    try {
      const result = await browseDirectory(locked);
      expect(result).toEqual({
        path: locked,
        parent: null,
        dirs: [],
        matches: 0,
      });
    } finally {
      process.env.HOME = original;
      await chmod(locked, 0o755);
    }
  });

  it("skips entries it cannot stat rather than failing the listing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "act-browse-broken-"));
    await mkdir(path.join(root, "real"));
    const { symlink } = await import("node:fs/promises");
    await symlink(path.join(root, "missing"), path.join(root, "dangling"));

    // A directory with one broken child is still worth showing — the
    // operator was only passing through.
    const result = await browseDirectory(root);
    expect(result.dirs.map((d) => d.name)).toEqual(["real"]);
  });
});
