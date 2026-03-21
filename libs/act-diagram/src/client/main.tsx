import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ActDiagram } from "./components/ActDiagram.js";
import { SAMPLE_FILES } from "./data/sample-files.js";
import "./styles.css";

/** Dev mode: standalone diagram with sample files for visual testing */
function DevApp() {
  const [files] = useState(SAMPLE_FILES);

  return (
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-100">
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-4 py-2">
        <span className="text-xs font-semibold text-zinc-300">
          Act Diagram — Dev Mode
        </span>
        <span className="text-[10px] text-zinc-600">
          {files.length} files loaded
        </span>
      </div>
      <div className="flex-1">
        <ActDiagram
          files={files}
          onNavigate={(file, line, col) => {
            console.log(`Navigate to ${file}:${line}:${col}`);
          }}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DevApp />
  </StrictMode>
);
