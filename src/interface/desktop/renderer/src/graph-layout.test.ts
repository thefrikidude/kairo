import assert from "node:assert/strict";
import test from "node:test";
import { buildGraph, layoutGraph } from "./graph-layout.js";

test("hangs files off folders and elides single-child folder chains", () => {
  const graph = buildGraph(
    [{ path: "src/a/b/one.ts" }, { path: "src/a/b/two.ts" }, { path: "readme.md" }],
    [],
  );
  const dirs = graph.vertices
    .filter((vertex) => vertex.kind === "dir")
    .map((vertex) => vertex.path);
  assert.deepEqual(dirs, ["", "src/a/b"]);
  const one = graph.edges.find((edge) => edge.target === "file:src/a/b/one.ts");
  assert.equal(one?.source, "dir:src/a/b");
  assert.equal(graph.edges.find((edge) => edge.target === "dir:src/a/b")?.source, "dir:");
});

test("adds import edges only between present files", () => {
  const graph = buildGraph(
    [{ path: "a.ts" }, { path: "b.ts" }],
    [
      { from: "a.ts", to: "b.ts" },
      { from: "a.ts", to: "gone.ts" },
    ],
  );
  assert.deepEqual(
    graph.edges.filter((edge) => edge.kind === "import"),
    [{ source: "file:a.ts", target: "file:b.ts", kind: "import" }],
  );
});

test("layout is deterministic, finite and keeps linked files closer than strangers", () => {
  const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"].map((path) => ({ path }));
  const graph = buildGraph(files, [{ from: "a.ts", to: "b.ts" }]);
  const first = layoutGraph(graph);
  const second = layoutGraph(graph);
  for (const [id, point] of first) {
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
    assert.deepEqual(second.get(id), point);
  }
  const distance = (a: string, b: string) => {
    const p = first.get(`file:${a}`)!;
    const q = first.get(`file:${b}`)!;
    return Math.hypot(p.x - q.x, p.y - q.y);
  };
  assert.ok(distance("a.ts", "b.ts") < distance("a.ts", "e.ts"));
});

test("warm layouts stay near the previous picture", () => {
  const graph = buildGraph([{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }], []);
  const before = layoutGraph(graph);
  const after = layoutGraph(graph, before);
  for (const [id, point] of before) {
    const moved = after.get(id)!;
    assert.ok(Math.hypot(point.x - moved.x, point.y - moved.y) < 40);
  }
});
