import { FileText, FolderOpen } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { EventTable } from "../components/EventTable.js";

type AnyEvent = {
  id: number;
  name: string;
  stream: string;
  version: number;
  created: string;
  data: unknown;
  meta: Record<string, unknown>;
};

const CSV_COLUMNS = [
  "id",
  "name",
  "data",
  "stream",
  "version",
  "created",
  "meta",
] as const;

/**
 * Browse a CSV event dump using the browser's file picker. The file
 * stays on the client — bytes are parsed in-memory and never shipped
 * to the server, so even multi-MB dumps are cheap to scan. Reuses
 * `EventRow` so the table chrome matches the live event log.
 */
export function CsvViewer() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [events, setEvents] = useState<AnyEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [visible, setVisible] = useState(100);
  const scrollRef = useRef<HTMLDivElement>(null);

  const handlePick = () => inputRef.current?.click();

  const handleFile = useCallback(async (file: File) => {
    setLoading(true);
    setError(null);
    setEvents([]);
    setVisible(100);
    setFileName(file.name);
    try {
      const text = await file.text();
      const parsed = parseEventCsv(text);
      setEvents(parsed);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (nearBottom) setVisible((v) => Math.min(v + 100, events.length));
  }, [events.length]);

  const slice = useMemo(() => events.slice(0, visible), [events, visible]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-zinc-800 bg-zinc-925 px-4 py-2">
        <button
          onClick={handlePick}
          className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white transition hover:bg-blue-500"
        >
          <FolderOpen size={12} />
          Open CSV…
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
            // Reset so picking the same file twice re-fires
            e.target.value = "";
          }}
        />
        {fileName && (
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-zinc-400">
            <FileText size={12} className="shrink-0 text-zinc-500" />
            <span className="truncate font-mono text-zinc-200">{fileName}</span>
            {!loading && events.length > 0 && (
              <span className="shrink-0 text-zinc-600">
                · {events.length.toLocaleString()} events
              </span>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="border-b border-red-900/40 bg-red-950/30 px-4 py-2 text-xs text-red-400">
          {error}
        </div>
      )}

      <EventTable
        events={fileName === null ? [] : slice}
        loading={loading}
        loadingMessage="Parsing…"
        emptyMessage={
          fileName === null
            ? 'Click "Open CSV…" to pick a file from your machine.'
            : "No events found."
        }
        scrollRef={scrollRef}
        onScroll={handleScroll}
        footer={
          slice.length > 0 ? (
            visible < events.length ? (
              <div className="py-4 text-center text-xs text-zinc-600">
                Showing {visible.toLocaleString()} of{" "}
                {events.length.toLocaleString()} — scroll for more
              </div>
            ) : (
              <div className="py-4 text-center text-xs text-zinc-700">
                End of file
              </div>
            )
          ) : null
        }
      />
    </div>
  );
}

/**
 * Parse the Act CSV event format on the client. Mirrors the shape of
 * `CsvFile` in `@rotorsoft/act/csv.ts` — same column order, same
 * `"`-escaped quoting — so any CSV that round-trips through the
 * framework is readable here.
 */
function parseEventCsv(text: string): AnyEvent[] {
  const lines = splitLines(text);
  if (lines.length === 0)
    throw new Error("CSV must have a header and at least one row");
  const header = parseCsvLine(lines[0]);
  const expected = CSV_COLUMNS.join(",");
  if (header.join(",") !== expected)
    throw new Error(`Invalid CSV header. Expected: ${expected}`);
  const out: AnyEvent[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const fields = parseCsvLine(line);
    if (fields.length !== CSV_COLUMNS.length)
      throw new Error(
        `Row ${i + 1}: expected ${CSV_COLUMNS.length} fields, got ${fields.length}`
      );
    out.push({
      id: Number.parseInt(fields[0], 10),
      name: fields[1],
      data: JSON.parse(fields[2]),
      stream: fields[3],
      version: Number.parseInt(fields[4], 10),
      created: fields[5],
      meta: JSON.parse(fields[6]) as Record<string, unknown>,
    });
  }
  return out;
}

function splitLines(text: string): string[] {
  // Newlines inside quoted fields are not produced by the framework
  // writer, so a plain split is fine. Strip BOM if present.
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return stripped.split(/\r?\n/);
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      let value = "";
      i++;
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') {
          value += '"';
          i += 2;
        } else if (line[i] === '"') {
          i++;
          break;
        } else {
          value += line[i++];
        }
      }
      fields.push(value);
      if (line[i] === ",") i++;
    } else {
      const next = line.indexOf(",", i);
      if (next === -1) {
        fields.push(line.slice(i));
        i = line.length;
      } else {
        fields.push(line.slice(i, next));
        i = next + 1;
      }
    }
  }
  return fields;
}
