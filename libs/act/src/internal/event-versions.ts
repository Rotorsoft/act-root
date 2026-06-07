/**
 * @module event-versions
 * @category Internal
 *
 * Auto-deprecation of legacy event versions via the `_v<digits>` naming
 * convention (ACT-403).
 *
 * Act's schema-evolution pattern keeps the old and new event names alive
 * forever — the old name on the read path (reducers), the new on the write
 * path (emissions). This module reads the convention to identify legacy
 * versions automatically; the framework then enforces "emit only the
 * current version" at build time and warns at runtime for dynamic emits.
 *
 * Convention pin: only `_v<digits>` with digits ≥ 2 counts as a version
 * suffix. `Foo_v1` is just a literal event name (the base `Foo` is
 * implicitly v1). Pinning here keeps the contract surface small.
 *
 * @internal
 */

const VERSION_SUFFIX = /^(.+?)_v(\d+)$/;

type Versioned = { version: number; name: string };

/**
 * Splits an event name into (base, version). Names without a `_v<n≥2>`
 * suffix are returned as (name, 1) — the base is its own implicit v1.
 */
function parse(name: string): { base: string; version: number } {
  const m = name.match(VERSION_SUFFIX);
  if (m) {
    const v = Number.parseInt(m[2], 10);
    if (v >= 2) return { base: m[1], version: v };
  }
  return { base: name, version: 1 };
}

/**
 * Returns the set of event names that are deprecated by virtue of having
 * a higher-numbered sibling in the registry. The highest version in each
 * group is the current version; every lower version is deprecated.
 *
 * Gaps are allowed: `{Foo, Foo_v3}` → `Foo` is deprecated, `Foo_v3` is
 * current. The framework picks the max regardless of contiguity.
 *
 * Single-version groups (no siblings) yield no deprecations.
 *
 * @internal
 */
export function deprecated_event_names(names: Iterable<string>): Set<string> {
  const groups = new Map<string, Versioned[]>();
  for (const name of names) {
    const { base, version } = parse(name);
    const list = groups.get(base);
    if (list) list.push({ version, name });
    else groups.set(base, [{ version, name }]);
  }
  const deprecated = new Set<string>();
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => b.version - a.version); // descending
    // index 0 is current; the rest are deprecated
    for (let i = 1; i < list.length; i++) deprecated.add(list[i].name);
  }
  return deprecated;
}

/**
 * Given a deprecated event name and the full set of event names in its
 * registry, returns the current (highest-version) sibling. Used to build
 * actionable error messages — "use `Foo_v3` instead."
 *
 * Returns `undefined` if the event has no higher-versioned sibling (which
 * means the caller's classification is stale or wrong).
 *
 * @internal
 */
export function current_version_of(
  deprecated_name: string,
  all_names: Iterable<string>
): string | undefined {
  const target = parse(deprecated_name);
  let highest: Versioned | undefined;
  for (const name of all_names) {
    const { base, version } = parse(name);
    if (base !== target.base) continue;
    if (!highest || version > highest.version) highest = { version, name };
  }
  return highest && highest.version > target.version ? highest.name : undefined;
}
