export function stripFences(code: string): string {
  let result = code.replace(/```(?:typescript|ts)?\s*\n/g, "");
  result = result.replace(/\n?```\s*$/g, "");
  // Strip leading natural language before first code line
  result = result.replace(
    /^[\s\S]*?(?=\/\*\*|\/\/|import\b|export\b|const\b|let\b|var\b|type\b|interface\b|function\b)/,
    ""
  );
  // Strip trailing natural language after last code-like line
  const lines = result.split("\n");
  let lastCodeLine = lines.length - 1;
  while (lastCodeLine > 0) {
    const trimmed = lines[lastCodeLine].trim();
    if (trimmed && /[;{})\]:]$|^\s*\/\/|^\s*\*\/|^\s*\*|^$/.test(trimmed))
      break;
    lastCodeLine--;
  }
  if (lastCodeLine < lines.length - 1) {
    result = lines.slice(0, lastCodeLine + 1).join("\n");
  }
  return result.trim();
}

/** Derive a project name from the prompt or generated code */
export function deriveProjectName(prompt: string, code?: string): string {
  // Try to extract from code: look for act() variable or first state() name
  if (code) {
    const actMatch = code.match(/(?:const|let|var)\s+(\w+)\s*=\s*act\s*\(/);
    if (actMatch) return actMatch[1];
    const stateMatch = code.match(/state\(\s*\{\s*(\w+)/);
    if (stateMatch) return stateMatch[1] + " App";
  }
  // Fall back to prompt: take first 3 meaningful words, title-case
  const words = prompt
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 3);
  return words.length > 0
    ? words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(" ")
    : "Generated App";
}
