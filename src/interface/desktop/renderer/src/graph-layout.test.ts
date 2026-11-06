import assert from "node:assert/strict";
import test from "node:test";
import { buildGraph, fitGraph, layoutGraph } from "./graph-layout.js";

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

test("a folder with hundreds of files lays out finite and compact", () => {
  const files = Array.from({ length: 400 }, (_, index) => ({ path: `bulk/file-${index}.txt` }));
  const links = Array.from({ length: 60 }, (_, index) => ({
    from: `bulk/file-${index}.txt`,
    to: `bulk/file-${index + 1}.txt`,
  }));
  const positions = layoutGraph(buildGraph(files, links));
  assert.equal(positions.size, 402);
  let farthest = 0;
  for (const point of positions.values()) {
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
    farthest = Math.max(farthest, Math.hypot(point.x, point.y));
  }
  assert.ok(farthest < 3_000, `layout spread to ${farthest}`);
});

test("warm layouts with many new files stay finite", () => {
  const first = buildGraph(
    Array.from({ length: 5 }, (_, index) => ({ path: `a/${index}.ts` })),
    [],
  );
  const before = layoutGraph(first);
  const second = buildGraph(
    Array.from({ length: 300 }, (_, index) => ({ path: `a/${index}.ts` })),
    [],
  );
  for (const point of layoutGraph(second, before).values())
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
});

test("a small graph is spread out to use the canvas while text stays 1:1", () => {
  const { spread, view } = fitGraph(
    { x: -50, y: -40, width: 100, height: 80 },
    { width: 1000, height: 800 },
  );
  assert.equal(spread, 2.5);
  assert.equal(view.width, 1000);
  assert.equal(view.height, 800);
  assert.ok(Math.abs(view.x + view.width / 2) < 1e-6 && Math.abs(view.y + view.height / 2) < 1e-6);
});

test("a graph that fills the canvas is not spread, and one that overflows is shrunk", () => {
  const exact = fitGraph({ x: 0, y: 0, width: 800, height: 600 }, { width: 800, height: 600 });
  assert.equal(exact.spread, 1);
  assert.equal(exact.view.width, 800);
  const big = fitGraph({ x: 0, y: 0, width: 4000, height: 1000 }, { width: 800, height: 600 });
  assert.equal(big.spread, 1);
  assert.equal(big.view.width, 4000);
  assert.ok(big.view.height >= 1000);
  assert.deepEqual(fitGraph({ x: 0, y: 0, width: 10, height: 10 }, { width: 0, height: 0 }), {
    spread: 1,
    view: { x: 0, y: 0, width: 10, height: 10 },
  });
});
