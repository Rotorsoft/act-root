import { TRANSFER_DEFAULTS, type TransferEndpoint } from "./types.js";

/**
 * One side of a transfer (ACT-1128 / #788). Picks the endpoint
 * adapter kind then renders the matching field set. The two-tier
 * mental model is enforced visually: "Connected store" is a
 * one-line summary; "Upload" / "Download" have no fields;
 * everything else looks like the inspector's connect form so
 * muscle memory carries over.
 *
 * Stateless: parent owns the `TransferEndpoint` and pushes updates
 * via `onChange`. The `disabledKinds` map lets the parent express
 * which kinds aren't valid for the current selection on the
 * opposite slot (e.g. `current` on the target when `current` is
 * already the source), and the picker greys out the radio inline
 * with a per-kind tooltip explaining why.
 */
export function AdapterPicker({
  role,
  config,
  onChange,
  disabled,
  connectedSummary,
  disabledKinds,
}: {
  role: "source" | "target";
  config: TransferEndpoint;
  onChange: (next: TransferEndpoint) => void;
  disabled: boolean;
  connectedSummary: string;
  /**
   * Per-kind disable + tooltip. Keys are adapter discriminators;
   * values are the human-facing reason shown on hover. Kinds not
   * present in the map render enabled.
   */
  disabledKinds?: Partial<Record<TransferEndpoint["adapter"], string>>;
}) {
  // Kinds visible per slot. `upload` is source-only, `download` is
  // target-only — the slot-restricted kinds are filtered out of the
  // off-slot picker to prevent invalid selections at the source.
  const kinds: TransferEndpoint["adapter"][] =
    role === "source"
      ? ["current", "upload", "csv", "pg", "sqlite"]
      : ["current", "download", "csv", "pg", "sqlite"];

  const swapKind = (kind: TransferEndpoint["adapter"]) => {
    if (kind === config.adapter) return;
    if (disabledKinds?.[kind]) return;
    onChange(TRANSFER_DEFAULTS[kind]);
  };

  return (
    <div className="rounded-md border border-zinc-800 p-3">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
        {role === "source" ? "From" : "To"}
      </h4>
      <div className="mt-2 space-y-1">
        {kinds.map((kind) => {
          const disableReason = disabledKinds?.[kind];
          const kindDisabled = disabled || !!disableReason;
          return (
            <label
              key={kind}
              title={disableReason}
              className={`flex items-start gap-2 rounded p-1 text-xs ${
                kindDisabled
                  ? "cursor-not-allowed opacity-40"
                  : "cursor-pointer text-zinc-300 hover:bg-zinc-800/40"
              }`}
            >
              <input
                type="radio"
                name={`${role}-kind`}
                checked={config.adapter === kind}
                onChange={() => swapKind(kind)}
                disabled={kindDisabled}
                className="mt-0.5 h-3 w-3"
              />
              <div className="flex-1">
                <div className="font-medium text-zinc-200">
                  {labelFor(kind)}
                </div>
                <div className="mt-0.5 text-[11px] text-zinc-500">
                  {disableReason ?? descriptionFor(kind, connectedSummary)}
                </div>
              </div>
            </label>
          );
        })}
      </div>

      {/* Fields show up under the selected option. */}
      {config.adapter === "csv" && (
        <FieldsCsv
          config={config}
          onChange={onChange}
          disabled={disabled}
          placeholder="/path/to/events.csv on the server"
        />
      )}
      {config.adapter === "upload" && (
        <FieldsUpload config={config} onChange={onChange} disabled={disabled} />
      )}
      {config.adapter === "pg" && (
        <FieldsPg config={config} onChange={onChange} disabled={disabled} />
      )}
      {config.adapter === "sqlite" && (
        <FieldsSqlite config={config} onChange={onChange} disabled={disabled} />
      )}
    </div>
  );
}

const labelFor = (kind: TransferEndpoint["adapter"]): string => {
  switch (kind) {
    case "current":
      return "Connected store";
    case "upload":
      return "Uploaded CSV file";
    case "download":
      return "Download CSV";
    case "csv":
      return "CSV file on server";
    case "pg":
      return "PostgreSQL";
    case "sqlite":
      return "SQLite";
  }
};

const descriptionFor = (
  kind: TransferEndpoint["adapter"],
  connectedSummary: string
): string => {
  switch (kind) {
    case "current":
      return connectedSummary || "Not connected";
    case "upload":
      return "Read events from a CSV file on your computer";
    case "download":
      return "Save the result CSV to your computer";
    case "csv":
      return "Read or write a CSV file on the inspector server";
    case "pg":
      return "Connect to a different PostgreSQL database for this transfer only";
    case "sqlite":
      return "Open a different SQLite file for this transfer only";
  }
};

function FieldsCsv({
  config,
  onChange,
  disabled,
  placeholder,
}: {
  config: Extract<TransferEndpoint, { adapter: "csv" }>;
  onChange: (next: TransferEndpoint) => void;
  disabled: boolean;
  placeholder: string;
}) {
  return (
    <div className="mt-2">
      <Field
        label="File"
        value={config.file}
        placeholder={placeholder}
        onChange={(v) => onChange({ ...config, file: v })}
        disabled={disabled}
      />
    </div>
  );
}

function FieldsUpload({
  config,
  onChange,
  disabled,
}: {
  config: Extract<TransferEndpoint, { adapter: "upload" }>;
  onChange: (next: TransferEndpoint) => void;
  disabled: boolean;
}) {
  return (
    <div className="mt-2">
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-zinc-500">CSV file (from your computer)</span>
        <input
          type="file"
          accept=".csv"
          disabled={disabled}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () =>
              onChange({ ...config, csv: reader.result as string });
            reader.readAsText(file);
          }}
          className="text-xs text-zinc-300 file:mr-2 file:rounded file:border file:border-zinc-700 file:bg-zinc-950 file:px-2 file:py-1 file:text-xs file:text-zinc-300 file:hover:bg-zinc-800 disabled:opacity-50"
        />
        {config.csv && (
          <span className="font-mono text-[11px] text-zinc-500">
            {Math.round(config.csv.length / 1024).toLocaleString()} KB loaded
          </span>
        )}
      </label>
    </div>
  );
}

function FieldsPg({
  config,
  onChange,
  disabled,
}: {
  config: Extract<TransferEndpoint, { adapter: "pg" }>;
  onChange: (next: TransferEndpoint) => void;
  disabled: boolean;
}) {
  const patch = (delta: Partial<typeof config>) =>
    onChange({ ...config, ...delta });
  return (
    <div className="mt-2 space-y-2">
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
    </div>
  );
}

function FieldsSqlite({
  config,
  onChange,
  disabled,
}: {
  config: Extract<TransferEndpoint, { adapter: "sqlite" }>;
  onChange: (next: TransferEndpoint) => void;
  disabled: boolean;
}) {
  return (
    <div className="mt-2">
      <Field
        label="File"
        value={config.file}
        placeholder="/path/to/store.sqlite"
        onChange={(v) => onChange({ ...config, file: v })}
        disabled={disabled}
      />
    </div>
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
