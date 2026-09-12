/** A folder or file in the project's file tree. */
export interface PathTreeNode {
  name: string;
  /** Repo-relative path. */
  path: string;
  /** Empty for a file. */
  children: PathTreeNode[];
}

/** Repo-relative paths as a tree: folders first, then files, both alphabetical. */
export function buildPathTree(paths: readonly string[]): PathTreeNode[] {
  interface Raw {
    children: Map<string, Raw>;
    isFile: boolean;
  }
  const root: Raw = { children: new Map(), isFile: false };
  for (const full of paths) {
    const parts = full.split('/').filter(Boolean);
    let node = root;
    parts.forEach((part, i) => {
      let next = node.children.get(part);
      if (!next) {
        next = { children: new Map(), isFile: false };
        node.children.set(part, next);
      }
      if (i === parts.length - 1) next.isFile = true;
      node = next;
    });
  }
  const convert = (node: Raw, parentPath: string): PathTreeNode[] =>
    [...node.children.entries()]
      .sort(([aName, a], [bName, b]) => {
        if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
        return aName.localeCompare(bName);
      })
      .map(([name, child]) => {
        const path = parentPath ? `${parentPath}/${name}` : name;
        return { name, path, children: child.isFile ? [] : convert(child, path) };
      });
  return convert(root, '');
}
