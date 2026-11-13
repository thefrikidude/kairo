/** A tree of resizable panes, each showing one workspace. Pure data so it can be tested alone. */
export type Direction = "row" | "column";
export type Edge = "left" | "right" | "top" | "bottom";
export type Leaf = { type: "leaf"; id: string; workspaceId: string };
export type Split = {
  type: "split";
  id: string;
  direction: Direction;
  /** Fractions that sum to 1, one per child. */
  sizes: number[];
  children: PaneNode[];
};
export type PaneNode = Leaf | Split;

let counter = 0;
const nextId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

export const leaf = (workspaceId: string): Leaf => ({
  type: "leaf",
  id: nextId("pane"),
  workspaceId,
});

export function leaves(node: PaneNode): Leaf[] {
  return node.type === "leaf" ? [node] : node.children.flatMap(leaves);
}

export const leafForWorkspace = (node: PaneNode, workspaceId: string) =>
  leaves(node).find((item) => item.workspaceId === workspaceId);

const directionOf = (edge: Edge): Direction =>
  edge === "left" || edge === "right" ? "row" : "column";

/** Removes a leaf, collapsing splits that are left with one child or that match their parent. */
export function closeLeaf(node: PaneNode, leafId: string): PaneNode | undefined {
  if (node.type === "leaf") return node.id === leafId ? undefined : node;
  const children: PaneNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, index) => {
    const next = closeLeaf(child, leafId);
    if (!next) return;
    children.push(next);
    sizes.push(node.sizes[index] ?? 1 / node.children.length);
  });
  if (!children.length) return undefined;
  if (children.length === 1) return children[0];
  const total = sizes.reduce((sum, size) => sum + size, 0) || 1;
  return normalize({ ...node, children, sizes: sizes.map((size) => size / total) });
}

/** Merges a child split into its parent when both run the same way, so the tree stays shallow. */
function normalize(node: Split): Split {
  const children: PaneNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, index) => {
    const size = node.sizes[index];
    if (child.type === "split" && child.direction === node.direction) {
      child.children.forEach((grandchild, at) => {
        children.push(grandchild);
        sizes.push(size * child.sizes[at]);
      });
    } else {
      children.push(child);
      sizes.push(size);
    }
  });
  return { ...node, children, sizes };
}

function splitLeaf(node: PaneNode, targetId: string, edge: Edge, fresh: Leaf): PaneNode {
  if (node.type === "leaf") {
    if (node.id !== targetId) return node;
    const before = edge === "left" || edge === "top";
    return {
      type: "split",
      id: nextId("split"),
      direction: directionOf(edge),
      sizes: [0.5, 0.5],
      children: before ? [fresh, node] : [node, fresh],
    };
  }
  return normalize({
    ...node,
    children: node.children.map((child) => splitLeaf(child, targetId, edge, fresh)),
  });
}

/**
 * Opens a workspace beside an existing pane. A workspace already shown elsewhere is moved, so each
 * workspace appears at most once.
 */
export function openBeside(
  root: PaneNode,
  targetId: string,
  edge: Edge,
  workspaceId: string,
): PaneNode {
  const target = leaves(root).find((item) => item.id === targetId);
  if (!target || target.workspaceId === workspaceId) return root;
  const existing = leafForWorkspace(root, workspaceId);
  const trimmed = existing ? (closeLeaf(root, existing.id) ?? root) : root;
  return splitLeaf(trimmed, targetId, edge, leaf(workspaceId));
}

/** Shows a different workspace in a pane. If it is open in another pane, the two panes swap. */
export function setPaneWorkspace(root: PaneNode, leafId: string, workspaceId: string): PaneNode {
  const target = leaves(root).find((item) => item.id === leafId);
  if (!target || target.workspaceId === workspaceId) return root;
  const other = leafForWorkspace(root, workspaceId);
  const map = (node: PaneNode): PaneNode => {
    if (node.type === "leaf") {
      if (node.id === leafId) return { ...node, workspaceId };
      if (other && node.id === other.id) return { ...node, workspaceId: target.workspaceId };
      return node;
    }
    return { ...node, children: node.children.map(map) };
  };
  return map(root);
}

/** Drops panes whose workspace no longer exists, always keeping one pane for the caller to fill. */
export function prune(root: PaneNode, exists: (workspaceId: string) => boolean): PaneNode {
  const all = leaves(root);
  const survivors = all.filter((item) => exists(item.workspaceId));
  if (!survivors.length) return all[0];
  let next: PaneNode = root;
  for (const item of all) if (!exists(item.workspaceId)) next = closeLeaf(next, item.id) ?? next;
  return next;
}

/** Moves the divider after `index`, keeping both neighbours above a minimum share. */
export function resize(
  root: PaneNode,
  splitId: string,
  index: number,
  delta: number,
  minimum = 0.12,
): PaneNode {
  if (root.type === "leaf") return root;
  if (root.id !== splitId)
    return {
      ...root,
      children: root.children.map((child) => resize(child, splitId, index, delta)),
    };
  const before = root.sizes[index];
  const after = root.sizes[index + 1];
  if (before === undefined || after === undefined) return root;
  const pair = before + after;
  const nextBefore = Math.min(pair - minimum, Math.max(minimum, before + delta));
  const sizes = [...root.sizes];
  sizes[index] = nextBefore;
  sizes[index + 1] = pair - nextBefore;
  return { ...root, sizes };
}
