import type { DomainModel, ValidationWarning } from "./types.js";

/** Validate domain model for completeness */
export function validate(model: DomainModel): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];

  // Collect all emitted event names
  const emittedEvents = new Set<string>();
  for (const s of model.states) {
    for (const e of s.events) emittedEvents.add(e.name);
  }

  // Collect all handled event names (reactions + projections)
  const handledEvents = new Set<string>();
  for (const s of model.slices) {
    for (const r of s.reactions) handledEvents.add(r.event);
  }
  for (const r of model.reactions) handledEvents.add(r.event);
  for (const p of model.projections) {
    for (const e of p.handles) handledEvents.add(e);
  }

  // Events emitted but never handled
  for (const name of emittedEvents) {
    if (!handledEvents.has(name)) {
      warnings.push({
        message: `Event "${name}" is emitted but never handled by any reaction or projection`,
        severity: "warning",
        element: name,
      });
    }
  }

  // Reactions referencing events not emitted
  for (const name of handledEvents) {
    if (!emittedEvents.has(name)) {
      warnings.push({
        message: `Reaction handles "${name}" but no state emits this event`,
        severity: "error",
        element: name,
      });
    }
  }

  // States with no actions
  for (const s of model.states) {
    if (s.actions.length === 0) {
      warnings.push({
        message: `State "${s.name}" has no actions defined`,
        severity: "warning",
        element: s.name,
      });
    }
  }

  // Actions that don't emit events
  for (const s of model.states) {
    for (const a of s.actions) {
      if (a.emits.length === 0) {
        warnings.push({
          message: `Action "${a.name}" in "${s.name}" does not emit any events`,
          severity: "warning",
          element: a.name,
        });
      }
    }
  }

  return warnings;
}
