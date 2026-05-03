# [@rotorsoft/act-pino-v0.3.1](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pino-v0.3.0...@rotorsoft/act-pino-v0.3.1) (2026-05-03)

# [@rotorsoft/act-pino-v0.3.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pino-v0.2.0...@rotorsoft/act-pino-v0.3.0) (2026-05-02)


* fix(deps)!: declare @rotorsoft/act as peer dep in adapters ([785b7b7](https://github.com/rotorsoft/act-root/commit/785b7b71ad223e0ca10944a0cc514ecd59a714ac)), closes [#632](https://github.com/rotorsoft/act-root/issues/632) [#632](https://github.com/rotorsoft/act-root/issues/632)


### BREAKING CHANGES

* consumers of @rotorsoft/act-pg, @rotorsoft/act-sqlite,
and @rotorsoft/act-pino must explicitly declare @rotorsoft/act as a
direct dependency. In practice every consumer that uses an adapter
already imports from @rotorsoft/act directly, so this formalizes
existing reality. After upgrading to the new adapter versions a single
time, future bumps to @rotorsoft/act alone are sufficient — adapters
follow automatically via the wide peer range.

# [@rotorsoft/act-pino-v0.2.0](https://github.com/rotorsoft/act-root/compare/@rotorsoft/act-pino-v0.1.0...@rotorsoft/act-pino-v0.2.0) (2026-03-25)


### Features

* **act-pino:** add README, semantic-release config, and CI publish ([5806edb](https://github.com/rotorsoft/act-root/commit/5806edbd97f157fd4ec24f5d36f3d5671c571414))
