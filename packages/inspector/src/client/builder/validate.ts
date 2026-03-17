import type { DomainModel, ValidationWarning } from "./types.js";

/** Validate domain model — only critical issues */
export function validate(model: DomainModel): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];

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
