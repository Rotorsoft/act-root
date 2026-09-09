export { ActDiagram } from "./client/components/ActDiagram.js";
export { AiBar, type AiOptions } from "./client/components/AiBar.js";
export { Diagram } from "./client/components/Diagram.js";
export { Logo } from "./client/components/Logo.js";
export { Tooltip } from "./client/components/Tooltip.js";

// Pipeline stages. `ActDiagram` drives these internally; they are public so
// an IDE integration can run them itself — cache a model, extract in a
// worker, or feed a non-standard file source (RFC 1650).
//
// Public spellings are camelCase per the naming convention; the internal
// implementations keep their snake_case names.
export { extract_model as extractModel } from "./client/lib/evaluate.js";
export type {
  Box as LayoutBox,
  E as LayoutEdge,
  Layout,
  N as LayoutNode,
  Pos as LayoutPos,
} from "./client/lib/layout.js";
export { compute_layout as computeLayout } from "./client/lib/layout.js";
export {
  type NavigateResult,
  navigate_to_code as navigateToCode,
} from "./client/lib/navigate.js";
export { topo_sort as topoSort } from "./client/lib/sort.js";
export {
  derive_project_name as deriveProjectName,
  parse_multi_file_response as parseMultiFileResponse,
  strip_fences as stripFences,
} from "./client/lib/strip-fences.js";
export { validate } from "./client/lib/validate.js";
export type {
  ActionNode,
  ActNode,
  DomainModel,
  EntryPoint,
  EventNode,
  ProjectionNode,
  ReactionNode,
  SliceNode,
  StateNode,
  ValidationWarning,
} from "./client/types/domain-model.js";
export { emptyModel } from "./client/types/domain-model.js";
export type { FileTab } from "./client/types/file-tab.js";
export type { DiagramMessage, HostMessage } from "./client/types/protocol.js";
// v0.1.1
