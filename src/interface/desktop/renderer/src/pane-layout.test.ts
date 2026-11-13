import assert from "node:assert/strict";
import test from "node:test";
import {
  closeLeaf,
  leafForWorkspace,
  leaf,
  leaves,
  openBeside,
  prune,
  resize,
  setPaneWorkspace,
  type PaneNode,
} from "./pane-layout.js";

const ids = (node: PaneNode) => leaves(node).map((item) => item.workspaceId);

test("opening beside a pane splits it in the dropped direction", () => {
  const root = leaf("a");
  const right = openBeside(root, root.id, "right", "b");
  assert.equal(right.type, "split");
  if (right.type === "split") assert.equal(right.direction, "row");
  assert.deepEqual(ids(right), ["a", "b"]);
  assert.deepEqual(ids(openBeside(root, root.id, "left", "b")), ["b", "a"]);
  const below = openBeside(root, root.id, "bottom", "b");
  if (below.type === "split") assert.equal(below.direction, "column");
  assert.deepEqual(ids(openBeside(root, root.id, "top", "b")), ["b", "a"]);
});

test("a workspace is shown once: opening it elsewhere moves it", () => {
  const first = leaf("a");
  const two = openBeside(first, first.id, "right", "b");
  const target = leafForWorkspace(two, "a")!;
  const three = openBeside(two, target.id, "bottom", "b");
  assert.deepEqual(ids(three).sort(), ["a", "b"]);
});

test("splitting along the parent's direction stays flat", () => {
  const first = leaf("a");
  const two = openBeside(first, first.id, "right", "b");
  const three = openBeside(two, leafForWorkspace(two, "b")!.id, "right", "c");
  assert.equal(three.type, "split");
  if (three.type === "split") {
    assert.equal(three.children.length, 3);
    assert.ok(Math.abs(three.sizes.reduce((sum, size) => sum + size, 0) - 1) < 1e-9);
  }
});

test("closing a pane collapses the split and gives its space back", () => {
  const first = leaf("a");
  const two = openBeside(first, first.id, "right", "b");
  const only = closeLeaf(two, leafForWorkspace(two, "b")!.id);
  assert.deepEqual(only && ids(only), ["a"]);
  assert.equal(only?.type, "leaf");
  assert.equal(closeLeaf(first, first.id), undefined);
});

test("setting a pane's workspace swaps with another pane that already shows it", () => {
  const first = leaf("a");
  const two = openBeside(first, first.id, "right", "b");
  const swapped = setPaneWorkspace(two, leafForWorkspace(two, "a")!.id, "b");
  assert.deepEqual(ids(swapped), ["b", "a"]);
  const replaced = setPaneWorkspace(two, leafForWorkspace(two, "a")!.id, "c");
  assert.deepEqual(ids(replaced), ["c", "b"]);
});

test("pruning removes missing workspaces but keeps a pane", () => {
  const first = leaf("a");
  const two = openBeside(first, first.id, "right", "b");
  assert.deepEqual(ids(prune(two, (id) => id === "b")), ["b"]);
  assert.equal(leaves(prune(two, () => false)).length, 1);
  assert.equal(
    prune(first, () => true),
    first,
  );
});

test("resizing moves a divider within limits", () => {
  const first = leaf("a");
  const two = openBeside(first, first.id, "right", "b");
  if (two.type !== "split") throw new Error("expected a split");
  const moved = resize(two, two.id, 0, 0.2);
  if (moved.type !== "split") throw new Error("expected a split");
  assert.ok(Math.abs(moved.sizes[0] - 0.7) < 1e-9);
  const clamped = resize(two, two.id, 0, 5);
  if (clamped.type !== "split") throw new Error("expected a split");
  assert.ok(clamped.sizes[1] >= 0.12 - 1e-9);
});
