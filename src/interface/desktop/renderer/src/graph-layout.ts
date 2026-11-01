export type GraphInput = { path: string };
export type GraphLink = { from: string; to: string };
export type Vertex = { id: string; kind: "file" | "dir"; label: string; path: string };
export type Edge = { source: string; target: string; kind: "tree" | "import" };
export type Graph = { vertices: Vertex[]; edges: Edge[] };
export type Point = { x: number; y: number };

const dirId = (path: string) => `dir:${path}`;
const fileId = (path: string) => `file:${path}`;

/**
 * Changed files hang off their folders; folders chain up to the root. A folder with a single child
 * is elided so deep paths do not become long strings of empty hubs. Import links connect files.
 */
export function buildGraph(files: GraphInput[], links: GraphLink[]): Graph {
  const parentOf = new Map<string, string>();
  const dirs = new Set<string>([""]);
  for (const { path } of files) {
    const parts = path.split("/");
    let parent = "";
    for (let index = 0; index < parts.length - 1; index += 1) {
      const dir = parts.slice(0, index + 1).join("/");
      dirs.add(dir);
      parentOf.set(dirId(dir), dirId(parent));
      parent = dir;
    }
    parentOf.set(fileId(path), dirId(parent));
  }
  const childCount = new Map<string, number>();
  for (const parent of parentOf.values()) childCount.set(parent, (childCount.get(parent) ?? 0) + 1);
  const elided = new Set(
    [...dirs].filter((dir) => dir && childCount.get(dirId(dir)) === 1).map(dirId),
  );
  const survivingParent = (id: string): string => {
    let parent = parentOf.get(id)!;
    while (elided.has(parent)) parent = parentOf.get(parent)!;
    return parent;
  };
  const vertices: Vertex[] = [
    ...[...dirs]
      .filter((dir) => !elided.has(dirId(dir)))
      .sort()
      .map((dir): Vertex => ({
        id: dirId(dir),
        kind: "dir",
        label: dir ? dir.split("/").pop()! : "/",
        path: dir,
      })),
    ...files
      .map((file) => file.path)
      .sort()
      .map((path): Vertex => ({
        id: fileId(path),
        kind: "file",
        label: path.split("/").pop()!,
        path,
      })),
  ];
  const edges: Edge[] = [];
  for (const vertex of vertices)
    if (vertex.id !== dirId(""))
      edges.push({ source: survivingParent(vertex.id), target: vertex.id, kind: "tree" });
  const present = new Set(files.map((file) => file.path));
  for (const link of links)
    if (present.has(link.from) && present.has(link.to))
      edges.push({ source: fileId(link.from), target: fileId(link.to), kind: "import" });
  // A folder left with only a root hub and nothing else would float alone; the root keeps it connected.
  return { vertices, edges };
}

/** Folder membership pulls tight; imports are longer so related files cluster without collapsing. */
const restLength = { tree: 48, import: 84 };

/**
 * Deterministic force layout. Passing the previous positions keeps the picture stable while the
 * agent edits, and only a few settling iterations run for a graph that has barely changed.
 */
export function layoutGraph(
  graph: Graph,
  previous?: ReadonlyMap<string, Point>,
): Map<string, Point> {
  const count = graph.vertices.length;
  const index = new Map(graph.vertices.map((vertex, at) => [vertex.id, at]));
  const x = new Float64Array(count);
  const y = new Float64Array(count);
  const vx = new Float64Array(count);
  const vy = new Float64Array(count);
  let warm = 0;
  graph.vertices.forEach((vertex, at) => {
    const known = previous?.get(vertex.id);
    if (known) {
      x[at] = known.x;
      y[at] = known.y;
      warm += 1;
    } else {
      const angle = at * 2.399963;
      const radius = 28 * Math.sqrt(at + 1);
      x[at] = Math.cos(angle) * radius;
      y[at] = Math.sin(angle) * radius;
    }
  });
  const iterations = warm > count * 0.8 ? 60 : 320;
  const pairs = graph.edges.map((edge) => ({
    a: index.get(edge.source)!,
    b: index.get(edge.target)!,
    length: restLength[edge.kind],
  }));
  for (let step = 0; step < iterations; step += 1) {
    const alpha = Math.max(0.03, 1 - step / iterations);
    for (let i = 0; i < count; i += 1)
      for (let j = i + 1; j < count; j += 1) {
        let dx = x[i] - x[j];
        let dy = y[i] - y[j];
        let squared = dx * dx + dy * dy;
        if (squared < 0.01) {
          dx = (i - j) * 0.1;
          dy = 0.1;
          squared = dx * dx + dy * dy;
        }
        if (squared > 90_000) continue;
        const push = (2600 * alpha) / squared;
        vx[i] += dx * push;
        vy[i] += dy * push;
        vx[j] -= dx * push;
        vy[j] -= dy * push;
      }
    for (const { a, b, length } of pairs) {
      const dx = x[b] - x[a];
      const dy = y[b] - y[a];
      const distance = Math.sqrt(dx * dx + dy * dy) || 1;
      const pull = ((distance - length) / distance) * 0.12;
      vx[a] += dx * pull;
      vy[a] += dy * pull;
      vx[b] -= dx * pull;
      vy[b] -= dy * pull;
    }
    for (let i = 0; i < count; i += 1) {
      vx[i] = (vx[i] - x[i] * 0.012) * 0.62;
      vy[i] = (vy[i] - y[i] * 0.012) * 0.62;
      x[i] += vx[i];
      y[i] += vy[i];
    }
  }
  return new Map(graph.vertices.map((vertex, at) => [vertex.id, { x: x[at], y: y[at] }]));
}

/** A viewBox that frames every vertex; labels are wider than they are tall, so x gets more room. */
export function frame(
  points: Iterable<Point>,
  marginX = 80,
  marginY = 36,
): { x: number; y: number; width: number; height: number } {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  if (!Number.isFinite(minX)) return { x: -100, y: -100, width: 200, height: 200 };
  return {
    x: minX - marginX,
    y: minY - marginY,
    width: Math.max(maxX - minX + marginX * 2, 160),
    height: Math.max(maxY - minY + marginY * 2, 120),
  };
}
