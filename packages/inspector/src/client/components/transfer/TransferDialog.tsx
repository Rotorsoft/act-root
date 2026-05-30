import { useEffect, useState } from "react";
import { queryClient, trpc } from "../../trpc.js";
import { AdapterPicker } from "./AdapterPicker.js";
import { CompactionToggles } from "./CompactionToggles.js";
import { PreviewPanel } from "./PreviewPanel.js";
import { ProgressBar } from "./ProgressBar.js";
import { TransferSummary } from "./TransferSummary.js";
import { STEPS, WizardHeader, type WizardStep } from "./WizardSteps.js";
import {
  type ScanResult,
  TRANSFER_DEFAULTS,
  type TransferEndpoint,
} from "./types.js";

/**
 * The one transfer dialog (ACT-1128 / #788), now structured as a
 * four-step wizard: Source → Target → Options → Summary. The single
 * crowded panel was hard to scan; splitting it lets each step focus
 * on one decision and validates in order.
 *
 * Default selection is `current → download` (the common backup
 * case). Operators swap as needed.
 *
 * The Summary step's Run-live button label adapts to the selection
 * so it reads as "Save backup" / "Restore" / "Transfer" without
 * three separate dialogs.
 */
export function TransferDialog({ onClose }: { onClose: () => void }) {
  const { data: status } = trpc.status.useQuery();
  const connectedSummary = status?.connected
    ? `${status.adapter}: ${status.target}`
    : "Not connected";

  const [step, setStep] = useState<WizardStep["key"]>("source");
  const [source, setSource] = useState<TransferEndpoint>(
    TRANSFER_DEFAULTS.current
  );
  const [target, setTarget] = useState<TransferEndpoint>(
    TRANSFER_DEFAULTS.download
  );
  const [dropSnapshots, setDropSnapshots] = useState(false);
  const [dropClosedStreams, setDropClosedStreams] = useState(false);
  const [batchSize, setBatchSize] = useState(500);
  // Migration overlay (ACT-1126). Stream rename is an ordered list —
  // each rule fires in turn against the running output, so independent
  // renames and chained refinements both work. Empty list = no
  // renames; we ship `undefined` so scan skips the overlay entirely.
  const [streamRenameRules, setStreamRenameRules] = useState<
    Array<{ pattern: string; replacement: string }>
  >([]);
  const [eventMigrationsPath, setEventMigrationsPath] = useState("");
  const [preview, setPreview] = useState<{
    result: ScanResult;
    // biome-ignore lint/suspicious/noExplicitAny: server-shaped events
    sample: any[];
  } | null>(null);
  const [summary, setSummary] = useState<{
    result: ScanResult;
    targetTouchedConnected: boolean;
  } | null>(null);

  const transferMutation = trpc.transfer.useMutation({
    onSuccess(data) {
      setSummary({
        result: data.result,
        targetTouchedConnected: target.adapter === "current",
      });
      if (target.adapter === "download" && data.csv) {
        const blob = new Blob([data.csv], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        a.download = `act-events-${ts}.csv`;
        a.click();
        URL.revokeObjectURL(url);
      }
      void queryClient.invalidateQueries();
    },
  });
  const previewMutation = trpc.transfer.useMutation({
    onSuccess(data) {
      setPreview({ result: data.result, sample: data.sample ?? [] });
    },
    onError() {
      setPreview(null);
    },
  });

  // Reactive progress — same SSE subscription as everything else
  // that calls `Act.restore` server-side.
  const [processed, setProcessed] = useState(0);
  const [currentId, setCurrentId] = useState<number | undefined>();
  const [maxId, setMaxId] = useState<number | undefined>();
  const anyMutationPending =
    transferMutation.isPending || previewMutation.isPending;
  trpc.restoreProgress.useSubscription(undefined, {
    enabled: anyMutationPending,
    onData: (event) => {
      setProcessed(event.processed);
      setCurrentId(event.id);
      setMaxId(event.max_id);
    },
  });

  // Invalidate the preview if any input changes — the counts
  // assumed the old shape.
  useEffect(() => {
    setPreview(null);
  }, [
    source,
    target,
    dropSnapshots,
    dropClosedStreams,
    streamRenameRules,
    eventMigrationsPath,
  ]);

  const inFlight = transferMutation.isPending;
  const sameStore = endpointsEqual(source, target);
  const sourceReady = endpointReady(source);
  const targetReady = endpointReady(target);
  const connectedNeededButMissing =
    (source.adapter === "current" || target.adapter === "current") &&
    !status?.connected;
  const canRun =
    !inFlight &&
    !sameStore &&
    sourceReady &&
    targetReady &&
    !connectedNeededButMissing;

  // biome-ignore lint/suspicious/noExplicitAny: per-slot narrowing happens server-side
  const wireSource = source as any;
  // biome-ignore lint/suspicious/noExplicitAny: per-slot narrowing happens server-side
  const wireTarget = target as any;

  // Strip empty-pattern rows on the way to the server (they're just
  // placeholders the operator left blank); ship `undefined` if nothing
  // is left so the server skips the overlay entirely.
  const migrationPayload = () => {
    const rules = streamRenameRules.filter((r) => r.pattern.trim().length > 0);
    return {
      stream_rename: rules.length > 0 ? rules : undefined,
      event_migrations_path: eventMigrationsPath || undefined,
    };
  };

  const handlePreview = () => {
    setPreview(null);
    setProcessed(0);
    setCurrentId(undefined);
    setMaxId(undefined);
    previewMutation.mutate({
      source: wireSource,
      target: wireTarget,
      dry_run: true,
      drop_snapshots: dropSnapshots,
      drop_closed_streams: dropClosedStreams,
      ...migrationPayload(),
    });
  };

  const handleRun = () => {
    setProcessed(0);
    setCurrentId(undefined);
    setMaxId(undefined);
    transferMutation.mutate({
      source: wireSource,
      target: wireTarget,
      drop_snapshots: dropSnapshots,
      drop_closed_streams: dropClosedStreams,
      batch_size: batchSize,
      ...migrationPayload(),
    });
  };

  const safeClose = () => {
    if (inFlight) return;
    transferMutation.reset();
    previewMutation.reset();
    onClose();
  };

  const runLabel = inFlight
    ? "Transferring…"
    : target.adapter === "download"
      ? "Save backup"
      : source.adapter === "upload"
        ? "Restore"
        : "Transfer";

  const stepIdx = STEPS.findIndex((s) => s.key === step);
  const stepCanAdvance = (() => {
    switch (step) {
      case "source":
        return sourceReady;
      case "target":
        return (
          targetReady && !sameStore && !connectedNeededButMissing && sourceReady
        );
      case "options":
        return true;
      case "summary":
        return false;
    }
  })();

  const goNext = () => {
    if (!stepCanAdvance) return;
    const next = STEPS[stepIdx + 1];
    if (next) setStep(next.key);
  };
  const goBack = () => {
    const prev = STEPS[stepIdx - 1];
    if (prev) setStep(prev.key);
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/60" onClick={safeClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="w-[36rem] max-h-[90vh] overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 p-6 shadow-xl">
          {summary ? (
            <TransferSummary
              result={summary.result}
              onClose={safeClose}
              targetTouchedConnected={summary.targetTouchedConnected}
            />
          ) : (
            <>
              <h3 className="text-sm font-semibold text-zinc-200">
                Restore
              </h3>
              <p className="mt-1 text-xs text-zinc-500">
                Pick a source and a target, tune options, then run.
              </p>

              <div className="mt-4">
                <WizardHeader active={step} />
              </div>

              {step === "source" && (
                <SourceStep
                  source={source}
                  onChange={setSource}
                  disabled={inFlight}
                  connectedSummary={connectedSummary}
                  disabledKinds={sourceDisabledKinds(
                    target,
                    status?.connected === true
                  )}
                />
              )}

              {step === "target" && (
                <TargetStep
                  target={target}
                  onChange={setTarget}
                  disabled={inFlight}
                  connectedSummary={connectedSummary}
                  disabledKinds={targetDisabledKinds(
                    source,
                    status?.connected === true
                  )}
                  sameStore={sameStore}
                  connectedNeededButMissing={connectedNeededButMissing}
                />
              )}

              {step === "options" && (
                <OptionsStep
                  dropSnapshots={dropSnapshots}
                  onChangeDropSnapshots={setDropSnapshots}
                  dropClosedStreams={dropClosedStreams}
                  onChangeDropClosedStreams={setDropClosedStreams}
                  batchSize={batchSize}
                  onChangeBatchSize={setBatchSize}
                  streamRenameRules={streamRenameRules}
                  onChangeStreamRenameRules={setStreamRenameRules}
                  eventMigrationsPath={eventMigrationsPath}
                  onChangeEventMigrationsPath={setEventMigrationsPath}
                  disabled={inFlight}
                />
              )}

              {step === "summary" && (
                <SummaryStep
                  source={source}
                  target={target}
                  dropSnapshots={dropSnapshots}
                  dropClosedStreams={dropClosedStreams}
                  batchSize={batchSize}
                  streamRenameRules={streamRenameRules}
                  eventMigrationsPath={eventMigrationsPath}
                  canRun={canRun}
                  inFlight={inFlight}
                  previewPending={previewMutation.isPending}
                  previewError={
                    previewMutation.isError
                      ? previewMutation.error.message
                      : null
                  }
                  transferError={
                    transferMutation.isError
                      ? transferMutation.error.message
                      : null
                  }
                  processed={processed}
                  currentId={currentId}
                  maxId={maxId}
                  onPreview={handlePreview}
                />
              )}

              <div className="mt-6 flex items-center justify-between gap-2">
                <button
                  onClick={safeClose}
                  disabled={inFlight}
                  className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 transition hover:bg-zinc-800 disabled:opacity-50"
                >
                  Cancel
                </button>
                <div className="flex gap-2">
                  <button
                    onClick={goBack}
                    disabled={stepIdx === 0 || inFlight}
                    className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-40"
                  >
                    Back
                  </button>
                  {step !== "summary" ? (
                    <button
                      onClick={goNext}
                      disabled={!stepCanAdvance}
                      className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Next
                    </button>
                  ) : (
                    <button
                      onClick={handleRun}
                      disabled={!canRun}
                      className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {runLabel}
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
      {preview && (
        <PreviewPanel
          result={preview.result}
          sample={preview.sample}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}

function SourceStep({
  source,
  onChange,
  disabled,
  connectedSummary,
  disabledKinds,
}: {
  source: TransferEndpoint;
  onChange: (e: TransferEndpoint) => void;
  disabled: boolean;
  connectedSummary: string;
  disabledKinds: Partial<Record<TransferEndpoint["adapter"], string>>;
}) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-500">
        Where the events come from — the connected store, a CSV file, an
        upload, or per-call PostgreSQL / SQLite credentials.
      </p>
      <AdapterPicker
        role="source"
        config={source}
        onChange={onChange}
        disabled={disabled}
        connectedSummary={connectedSummary}
        disabledKinds={disabledKinds}
      />
    </div>
  );
}

function TargetStep({
  target,
  onChange,
  disabled,
  connectedSummary,
  disabledKinds,
  sameStore,
  connectedNeededButMissing,
}: {
  target: TransferEndpoint;
  onChange: (e: TransferEndpoint) => void;
  disabled: boolean;
  connectedSummary: string;
  disabledKinds: Partial<Record<TransferEndpoint["adapter"], string>>;
  sameStore: boolean;
  connectedNeededButMissing: boolean;
}) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-500">
        Where the events go — the connected store (replaces its contents),
        a download, or per-call credentials.
      </p>
      <AdapterPicker
        role="target"
        config={target}
        onChange={onChange}
        disabled={disabled}
        connectedSummary={connectedSummary}
        disabledKinds={disabledKinds}
      />
      {sameStore && (
        <p className="text-xs text-amber-400">
          Source and target refer to the same store — change one to enable
          the transfer.
        </p>
      )}
      {connectedNeededButMissing && (
        <p className="text-xs text-amber-400">
          "Connected store" is selected, but no store is connected. Open the
          connect form first.
        </p>
      )}
    </div>
  );
}

type RenameRule = { pattern: string; replacement: string };

function OptionsStep({
  dropSnapshots,
  onChangeDropSnapshots,
  dropClosedStreams,
  onChangeDropClosedStreams,
  batchSize,
  onChangeBatchSize,
  streamRenameRules,
  onChangeStreamRenameRules,
  eventMigrationsPath,
  onChangeEventMigrationsPath,
  disabled,
}: {
  dropSnapshots: boolean;
  onChangeDropSnapshots: (v: boolean) => void;
  dropClosedStreams: boolean;
  onChangeDropClosedStreams: (v: boolean) => void;
  batchSize: number;
  onChangeBatchSize: (v: number) => void;
  streamRenameRules: RenameRule[];
  onChangeStreamRenameRules: (rules: RenameRule[]) => void;
  eventMigrationsPath: string;
  onChangeEventMigrationsPath: (v: string) => void;
  disabled: boolean;
}) {
  const updateRule = (index: number, patch: Partial<RenameRule>) => {
    onChangeStreamRenameRules(
      streamRenameRules.map((r, i) => (i === index ? { ...r, ...patch } : r))
    );
  };
  const addRule = () =>
    onChangeStreamRenameRules([
      ...streamRenameRules,
      { pattern: "", replacement: "" },
    ]);
  const removeRule = (index: number) =>
    onChangeStreamRenameRules(
      streamRenameRules.filter((_, i) => i !== index)
    );
  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-500">
        Tune what gets transferred. All options are optional — leave
        everything off for a verbatim copy.
      </p>
      <div className="grid grid-cols-[1fr_auto] gap-3">
        <CompactionToggles
          dropSnapshots={dropSnapshots}
          onChangeDropSnapshots={onChangeDropSnapshots}
          dropClosedStreams={dropClosedStreams}
          onChangeDropClosedStreams={onChangeDropClosedStreams}
          disabled={disabled}
        />
        <div className="rounded-md border border-zinc-800 p-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
            Batch size
          </h4>
          <input
            type="number"
            min={50}
            max={10_000}
            step={50}
            value={batchSize}
            disabled={disabled}
            onChange={(e) => {
              const v = Number.parseInt(e.target.value, 10);
              if (!Number.isNaN(v)) onChangeBatchSize(v);
            }}
            className="mt-2 w-24 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-right font-mono text-xs text-zinc-200 focus:border-blue-500 focus:outline-none disabled:opacity-50"
          />
        </div>
      </div>

      <div className="rounded-md border border-zinc-800 p-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
          Migration
        </h4>
        <div className="mt-3 space-y-3">
          <div>
            <div className="text-xs font-medium text-zinc-300">
              Stream rename
            </div>
            <div className="mt-0.5 text-[11px] text-zinc-500">
              Regex find/replace applied per event's stream (e.g.{" "}
              <code>^tenant-old-</code> → <code>tenant-new-</code>). Rules
              run in order, each one seeing the previous rule's output —
              good for both independent renames and chained refinement.
            </div>
            <div className="mt-2 space-y-2">
              {streamRenameRules.map((rule, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: row identity is positional
                <div key={i} className="flex items-center gap-2">
                  <span className="w-4 shrink-0 text-center font-mono text-[10px] text-zinc-600">
                    {i + 1}
                  </span>
                  <input
                    type="text"
                    placeholder="pattern (regex)"
                    value={rule.pattern}
                    disabled={disabled}
                    onChange={(e) =>
                      updateRule(i, { pattern: e.target.value })
                    }
                    className="flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-blue-500 focus:outline-none disabled:opacity-50"
                  />
                  <input
                    type="text"
                    placeholder="replacement"
                    value={rule.replacement}
                    disabled={disabled}
                    onChange={(e) =>
                      updateRule(i, { replacement: e.target.value })
                    }
                    className="flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-blue-500 focus:outline-none disabled:opacity-50"
                  />
                  <button
                    type="button"
                    onClick={() => removeRule(i)}
                    disabled={disabled}
                    aria-label={`Remove rule ${i + 1}`}
                    className="shrink-0 rounded border border-zinc-800 px-2 py-1 text-xs text-zinc-500 transition hover:border-red-900/60 hover:bg-red-950/30 hover:text-red-300 disabled:opacity-40"
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={addRule}
                disabled={disabled}
                className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-40"
              >
                + Add rule
              </button>
            </div>
          </div>
          <div>
            <div className="text-xs font-medium text-zinc-300">
              Event migrations
            </div>
            <div className="mt-0.5 text-[11px] text-zinc-500">
              Path (relative to the inspector cwd) to a module exporting{" "}
              <code>Record&lt;string, EventMigration&gt;</code> as default.
              Migrations validate source + target schemas; any mismatch
              aborts the transfer.
            </div>
            <input
              type="text"
              placeholder="migrations/2026-05-rename.ts"
              value={eventMigrationsPath}
              disabled={disabled}
              onChange={(e) => onChangeEventMigrationsPath(e.target.value)}
              className="mt-2 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-blue-500 focus:outline-none disabled:opacity-50"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function SummaryStep({
  source,
  target,
  dropSnapshots,
  dropClosedStreams,
  batchSize,
  streamRenameRules,
  eventMigrationsPath,
  canRun,
  inFlight,
  previewPending,
  previewError,
  transferError,
  processed,
  currentId,
  maxId,
  onPreview,
}: {
  source: TransferEndpoint;
  target: TransferEndpoint;
  dropSnapshots: boolean;
  dropClosedStreams: boolean;
  batchSize: number;
  streamRenameRules: RenameRule[];
  eventMigrationsPath: string;
  canRun: boolean;
  inFlight: boolean;
  previewPending: boolean;
  previewError: string | null;
  transferError: string | null;
  processed: number;
  currentId: number | undefined;
  maxId: number | undefined;
  onPreview: () => void;
}) {
  const opts: Array<[string, string]> = [];
  if (dropSnapshots) opts.push(["Drop snapshots", "yes"]);
  if (dropClosedStreams) opts.push(["Drop closed streams", "yes"]);
  opts.push(["Batch size", String(batchSize)]);
  const activeRules = streamRenameRules.filter((r) => r.pattern.trim());
  if (activeRules.length === 1) {
    const r = activeRules[0];
    opts.push([
      "Stream rename",
      `${r.pattern} → ${r.replacement || "(empty)"}`,
    ]);
  } else if (activeRules.length > 1) {
    opts.push(["Stream rename", `${activeRules.length} rules`]);
  }
  if (eventMigrationsPath) opts.push(["Event migrations", eventMigrationsPath]);

  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-500">
        Review the transfer. Run a dry-run to see what would change, or
        commit live.
      </p>
      <div className="rounded-md border border-zinc-800 p-3 text-xs text-zinc-300">
        <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1">
          <span className="truncate text-zinc-500">Source</span>
          <span
            className="truncate font-mono text-zinc-200"
            title={endpointLabel(source)}
          >
            {endpointLabel(source)}
          </span>
          <span className="truncate text-zinc-500">Target</span>
          <span
            className="truncate font-mono text-zinc-200"
            title={endpointLabel(target)}
          >
            {endpointLabel(target)}
          </span>
          {opts.map(([k, v]) => (
            <div key={k} className="contents">
              <span className="truncate text-zinc-500" title={k}>
                {k}
              </span>
              <span className="truncate font-mono text-zinc-200" title={v}>
                {v}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <button
          onClick={onPreview}
          disabled={!canRun || previewPending}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-50"
        >
          {previewPending ? "Previewing…" : "Preview (dry-run)"}
        </button>
      </div>

      {previewError && (
        <p className="text-xs text-red-400">{previewError}</p>
      )}
      {transferError && (
        <p className="text-xs text-red-400">{transferError}</p>
      )}
      {(inFlight || previewPending) && (
        <ProgressBar processed={processed} id={currentId} max_id={maxId} />
      )}
    </div>
  );
}

function endpointLabel(e: TransferEndpoint): string {
  switch (e.adapter) {
    case "current":
      return "connected store";
    case "download":
      return "download (CSV)";
    case "upload":
      return "uploaded CSV";
    case "csv":
      return `csv: ${e.file || "(not set)"}`;
    case "sqlite":
      return `sqlite: ${e.file || "(not set)"}`;
    case "pg":
      return `pg: ${e.user || "?"}@${e.host || "?"}/${e.database || "?"}.${e.schema || "?"}.${e.table || "?"}`;
  }
}

function sourceDisabledKinds(
  target: TransferEndpoint,
  connected: boolean
): Partial<Record<TransferEndpoint["adapter"], string>> {
  const out: Partial<Record<TransferEndpoint["adapter"], string>> = {};
  if (target.adapter === "current")
    out.current = "Already chosen as the target — pick a different source";
  else if (!connected)
    out.current = "Not connected to a store — open the connect form first";
  return out;
}

function targetDisabledKinds(
  source: TransferEndpoint,
  connected: boolean
): Partial<Record<TransferEndpoint["adapter"], string>> {
  const out: Partial<Record<TransferEndpoint["adapter"], string>> = {};
  if (source.adapter === "current")
    out.current = "Already chosen as the source — pick a different target";
  else if (!connected)
    out.current = "Not connected to a store — open the connect form first";
  return out;
}

function endpointsEqual(a: TransferEndpoint, b: TransferEndpoint): boolean {
  if (a.adapter !== b.adapter) return false;
  if (a.adapter === "current") return true;
  if (a.adapter === "pg" && b.adapter === "pg")
    return (
      a.host === b.host &&
      a.port === b.port &&
      a.database === b.database &&
      a.schema === b.schema &&
      a.table === b.table
    );
  if (a.adapter === "sqlite" && b.adapter === "sqlite")
    return a.file === b.file;
  if (a.adapter === "csv" && b.adapter === "csv") return a.file === b.file;
  return false;
}

function endpointReady(c: TransferEndpoint): boolean {
  switch (c.adapter) {
    case "current":
    case "download":
      return true;
    case "upload":
      return c.csv.length > 0;
    case "csv":
    case "sqlite":
      return c.file.trim().length > 0;
    case "pg":
      return (
        c.host.trim().length > 0 &&
        c.database.trim().length > 0 &&
        c.user.trim().length > 0 &&
        c.schema.trim().length > 0 &&
        c.table.trim().length > 0
      );
  }
}
