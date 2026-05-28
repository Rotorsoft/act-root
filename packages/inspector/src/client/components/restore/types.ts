/**
 * Wire-shape mirror of `ScanResult` from `@rotorsoft/act`, kept local
 * to the restore UI components. The inspector client doesn't import
 * the framework types directly — tRPC erases generics through its
 * input/output schema, and inlining the shape here keeps the
 * component package free of a framework dependency.
 */
export type ScanResult = {
  kept: number;
  duration_ms: number;
  dropped: {
    closed_streams: number;
    snapshots: number;
    empty_streams: number;
  };
};
