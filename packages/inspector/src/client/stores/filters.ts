import { useSyncExternalStore } from "react";

export type Filters = {
  stream?: string;
  names?: string[];
  created_after?: string;
  created_before?: string;
  correlation?: string;
  backward: boolean;
  limit: number;
  before?: number;
};

const defaultFilters: Filters = {
  backward: true,
  limit: 50,
};

let filters: Filters = loadFromUrl();
let listeners: Array<() => void> = [];

function notify() {
  for (const l of listeners) l();
}

function loadFromUrl(): Filters {
  if (typeof window === "undefined") return { ...defaultFilters };
  const params = new URLSearchParams(window.location.search);
  return {
    stream: params.get("stream") || undefined,
    names: params.get("names")?.split(",").filter(Boolean) || undefined,
    created_after: params.get("created_after") || undefined,
    created_before: params.get("created_before") || undefined,
    correlation: params.get("correlation") || undefined,
    backward: params.get("backward") !== "false",
    limit: Number(params.get("limit")) || 50,
    before: params.has("before") ? Number(params.get("before")) : undefined,
  };
}

function syncToUrl(f: Filters) {
  const params = new URLSearchParams();
  if (f.stream) params.set("stream", f.stream);
  if (f.names?.length) params.set("names", f.names.join(","));
  if (f.created_after) params.set("created_after", f.created_after);
  if (f.created_before) params.set("created_before", f.created_before);
  if (f.correlation) params.set("correlation", f.correlation);
  if (!f.backward) params.set("backward", "false");
  if (f.limit !== 50) params.set("limit", String(f.limit));
  const search = params.toString();
  const url = search ? `?${search}` : window.location.pathname;
  window.history.replaceState(null, "", url);
}

export function setFilters(update: Partial<Filters>) {
  // Reset cursor when filters change (except when paging)
  const resetCursor = !("before" in update);
  filters = {
    ...filters,
    ...update,
    ...(resetCursor ? { before: undefined } : {}),
  };
  syncToUrl(filters);
  notify();
}

export function clearFilters() {
  filters = { ...defaultFilters };
  syncToUrl(filters);
  notify();
}

export function getFilters(): Filters {
  return filters;
}

function subscribe(listener: () => void) {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

export function useFilterStore(): [
  Filters,
  typeof setFilters,
  typeof clearFilters,
] {
  const snapshot = useSyncExternalStore(subscribe, getFilters);
  return [snapshot, setFilters, clearFilters];
}
