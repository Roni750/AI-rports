/**
 * Structural sanity check on mermaid blocks in markdown.
 *
 * Not a full parser — it catches the breakages that actually happen when hand-writing diagrams:
 * unbalanced subgraph/end, unbalanced quotes or brackets in a label, and reserved words used as
 * node ids. A diagram that fails to render is worse than no diagram, and GitHub gives no warning.
 */
import fs from "node:fs";

const RESERVED = new Set(["end", "graph", "subgraph", "style", "class", "click"]);
let failures = 0;

for (const file of process.argv.slice(2)) {
  const text = fs.readFileSync(file, "utf-8");
  const blocks = [...text.matchAll(/```mermaid\n([\s\S]*?)```/g)];
  console.log(`\n${file}: ${blocks.length} mermaid block(s)`);

  blocks.forEach((m, i) => {
    const body = m[1];
    const lines = body.split("\n");
    const problems = [];

    // subgraph / end balance (sequenceDiagram rect also uses `end`)
    const opens = lines.filter((l) => /^\s*(subgraph|rect)\b/.test(l)).length;
    const ends = lines.filter((l) => /^\s*end\s*$/.test(l)).length;
    if (opens !== ends) problems.push(`${opens} subgraph/rect vs ${ends} end`);

    const header = lines.find((l) => l.trim())?.trim() ?? "";
    if (!/^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram)/.test(header)) {
      problems.push(`unrecognised diagram type: "${header}"`);
    }

    lines.forEach((line, n) => {
      if ((line.match(/"/g) ?? []).length % 2 !== 0) {
        problems.push(`line ${n + 1}: odd number of quotes — ${line.trim()}`);
      }
      // Reserved word used as a node id at the start of a statement
      const idMatch = /^\s*([A-Za-z_][\w-]*)\s*[[({]/.exec(line);
      if (idMatch && RESERVED.has(idMatch[1].toLowerCase())) {
        problems.push(`line ${n + 1}: reserved word "${idMatch[1]}" used as node id`);
      }
    });

    if (problems.length) {
      failures++;
      console.log(`  block ${i + 1}: FAIL`);
      for (const p of problems) console.log(`    - ${p}`);
    } else {
      console.log(`  block ${i + 1}: ok (${lines.length} lines, ${opens} subgraphs)`);
    }
  });
}

process.exit(failures ? 1 : 0);
