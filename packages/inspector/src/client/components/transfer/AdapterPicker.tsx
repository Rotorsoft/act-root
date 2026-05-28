import {
  TRANSFER_DEFAULTS,
  type TransferConfig,
} from "./types.js";

/**
 * Adapter-config form for one end of a transfer (ACT-1128 + #788).
 *
 * Renders a radio group across PG / SQLite / CSV plus the fields
 * for the currently-selected adapter. Stateless — the parent owns
 * the `TransferConfig` and pushes updates via `onChange`. That
 * keeps the source/target halves of the transfer dialog
 * symmetrical and makes the deep-equal "same store" guard a
 * straightforward comparison on the two configs.
 */
export function AdapterPicker({
  label,
  config,
  onChange,
  disabled,
}: {
  label: string;
  config: TransferConfig;
  onChange: (next: TransferConfig) => void;
  disabled: boolean;
}) {
  const swapKind = (kind: TransferConfig["adapter"]) => {
    if (kind === config.adapter) return;
    onChange(TRANSFER_DEFAULTS[kind]);
  };

  return (
    <div className="rounded-md border border-zinc-800 p-3">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
        {label}
      </h4>
      <div className="mt-2 flex gap-3 text-xs text-zinc-300">
        {(["pg", "sqlite", "csv"] as const).map((kind) => (
          <label
            key={kind}
            className="flex cursor-pointer items-center gap-1"
          >
            <input
              type="radio"
              name={`${label}-kind`}
              checked={config.adapter === kind}
              onChange={() => swapKind(kind)}
              disabled={disabled}
              className="h-3 w-3"
            />
            <span>{labelFor(kind)}</span>
          </label>
        ))}
      </div>
      <div className="mt-3 space-y-2">
        {config.adapter === "pg" && (
          <PgFields config={config} onChange={onChange} disabled={disabled} />
        )}
        {config.adapter === "sqlite" && (
          <SqliteFields
            config={config}
            onChange={onChange}
            disabled={disabled}
          />
        )}
        {config.adapter === "csv" && (
          <CsvFields config={config} onChange={onChange} disabled={disabled} />
        )}
      </div>
    </div>
  );
}

const labelFor = (kind: TransferConfig["adapter"]) =>
  kind === "pg" ? "Postgres" : kind === "sqlite" ? "SQLite" : "CSV";

function PgFields({
  config,
  onChange,
  disabled,
}: {
  config: Extract<TransferConfig, { adapter: "pg" }>;
  onChange: (next: TransferConfig) => void;
  disabled: boolean;
}) {
  // Tiny field-update helpers keep the JSX readable. We pass
  // whole-config replacements (not partial deltas) because the
  // parent's `onChange` expects a fully-typed `TransferConfig`.
  const patch = (delta: Partial<typeof config>) =>
    onChange({ ...config, ...delta });
  return (
    <>
      <Row>
        <Field
          label="Host"
          value={config.host}
          onChange={(v) => patch({ host: v })}
          disabled={disabled}
        />
        <Field
          label="Port"
          value={String(config.port)}
          onChange={(v) =>
            patch({ port: Number.parseInt(v, 10) || config.port })
          }
          disabled={disabled}
          inputClass="w-16"
        />
      </Row>
      <Field
        label="Database"
        value={config.database}
        onChange={(v) => patch({ database: v })}
        disabled={disabled}
      />
      <Row>
        <Field
          label="User"
          value={config.user}
          onChange={(v) => patch({ user: v })}
          disabled={disabled}
        />
        <Field
          label="Password"
          value={config.password}
          onChange={(v) => patch({ password: v })}
          disabled={disabled}
          type="password"
        />
      </Row>
      <Row>
        <Field
          label="Schema"
          value={config.schema}
          onChange={(v) => patch({ schema: v })}
          disabled={disabled}
        />
        <Field
          label="Table"
          value={config.table}
          onChange={(v) => patch({ table: v })}
          disabled={disabled}
        />
      </Row>
    </>
  );
}

function SqliteFields({
  config,
  onChange,
  disabled,
}: {
  config: Extract<TransferConfig, { adapter: "sqlite" }>;
  onChange: (next: TransferConfig) => void;
  disabled: boolean;
}) {
  return (
    <Field
      label="File"
      value={config.file}
      onChange={(v) => onChange({ ...config, file: v })}
      disabled={disabled}
      placeholder="/path/to/store.sqlite"
    />
  );
}

function CsvFields({
  config,
  onChange,
  disabled,
}: {
  config: Extract<TransferConfig, { adapter: "csv" }>;
  onChange: (next: TransferConfig) => void;
  disabled: boolean;
}) {
  return (
    <Field
      label="File"
      value={config.file}
      onChange={(v) => onChange({ ...config, file: v })}
      disabled={disabled}
      placeholder="/path/to/events.csv"
    />
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex gap-2">{children}</div>;
}

function Field({
  label,
  value,
  onChange,
  disabled,
  type = "text",
  placeholder,
  inputClass,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  type?: string;
  placeholder?: string;
  inputClass?: string;
}) {
  return (
    <label className="flex flex-1 flex-col gap-0.5 text-xs">
      <span className="text-zinc-500">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={`rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-200 placeholder-zinc-600 focus:border-blue-500 focus:outline-none disabled:opacity-50 ${inputClass ?? ""}`}
      />
    </label>
  );
}
