import { useState } from "react";

type JsonViewerProps = {
  data: unknown;
  collapsed?: boolean;
  label?: string;
};

export function JsonViewer({
  data,
  collapsed = false,
  label,
}: JsonViewerProps) {
  return (
    <div className="font-mono text-xs leading-relaxed">
      {label && <span className="mr-2 text-zinc-500">{label}:</span>}
      <JsonNode data={data} depth={0} defaultCollapsed={collapsed} />
    </div>
  );
}

function JsonNode({
  data,
  depth,
  defaultCollapsed,
}: {
  data: unknown;
  depth: number;
  defaultCollapsed: boolean;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed && depth > 0);

  if (data === null) return <span className="json-null">null</span>;
  if (data === undefined) return <span className="json-null">undefined</span>;

  if (typeof data === "string")
    return <span className="json-string">&quot;{data}&quot;</span>;
  if (typeof data === "number")
    return <span className="json-number">{data}</span>;
  if (typeof data === "boolean")
    return <span className="json-boolean">{String(data)}</span>;

  if (Array.isArray(data)) {
    if (data.length === 0) return <span className="text-zinc-500">[]</span>;
    if (collapsed)
      return (
        <span
          onClick={() => setCollapsed(false)}
          className="cursor-pointer text-zinc-500 hover:text-zinc-300"
        >
          [{data.length} items]
        </span>
      );
    return (
      <span>
        <span
          onClick={() => setCollapsed(true)}
          className="cursor-pointer text-zinc-500 hover:text-zinc-300"
        >
          [
        </span>
        <div style={{ paddingLeft: 16 }}>
          {data.map((item, i) => (
            <div key={i}>
              <JsonNode
                data={item}
                depth={depth + 1}
                defaultCollapsed={defaultCollapsed}
              />
              {i < data.length - 1 && <span className="text-zinc-600">,</span>}
            </div>
          ))}
        </div>
        <span className="text-zinc-500">]</span>
      </span>
    );
  }

  if (typeof data === "object") {
    const entries = Object.entries(data as Record<string, unknown>);
    if (entries.length === 0)
      return <span className="text-zinc-500">{"{}"}</span>;
    if (collapsed)
      return (
        <span
          onClick={() => setCollapsed(false)}
          className="cursor-pointer text-zinc-500 hover:text-zinc-300"
        >
          {"{"}
          {entries.length} fields{"}"}
        </span>
      );
    return (
      <span>
        <span
          onClick={() => setCollapsed(true)}
          className="cursor-pointer text-zinc-500 hover:text-zinc-300"
        >
          {"{"}
        </span>
        <div style={{ paddingLeft: 16 }}>
          {entries.map(([key, value], i) => (
            <div key={key}>
              <span className="json-key">{key}</span>
              <span className="text-zinc-600">: </span>
              <JsonNode
                data={value}
                depth={depth + 1}
                defaultCollapsed={defaultCollapsed}
              />
              {i < entries.length - 1 && (
                <span className="text-zinc-600">,</span>
              )}
            </div>
          ))}
        </div>
        <span className="text-zinc-500">{"}"}</span>
      </span>
    );
  }

  return <span className="text-zinc-400">{JSON.stringify(data)}</span>;
}
