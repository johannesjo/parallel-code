import type { ChangedFile } from '../ipc/types';

export interface FileTreeNode {
  /** Display name — may be a compacted path like "src/components" for single-child chains */
  name: string;
  /** Full path from project root */
  path: string;
  /** Child nodes (empty for files) */
  children: FileTreeNode[];
  /** Only set for leaf file nodes */
  file?: ChangedFile;
  /** Aggregate lines added across subtree */
  linesAdded: number;
  /** Aggregate lines removed across subtree */
  linesRemoved: number;
  /** Total files in subtree */
  fileCount: number;
}

export interface FlatTreeRow {
  node: FileTreeNode;
  depth: number;
  isDir: boolean;
}

/**
 * Build a tree from a flat list of changed files.
 * Single-child directory chains are compacted (e.g. src/components/ui).
 * Directories sort before files; both sorted alphabetically.
 */
export function buildFileTree(files: ChangedFile[]): FileTreeNode[] {
  interface RawNode {
    children: Map<string, RawNode>;
    file?: ChangedFile;
  }

  const root: RawNode = { children: new Map() };

  for (const file of files) {
    const parts = file.path.split('/');
    let current = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = current.children.get(parts[i]);
      if (!next) {
        next = { children: new Map() };
        current.children.set(parts[i], next);
      }
      current = next;
    }
    const fileName = parts[parts.length - 1];
    current.children.set(fileName, { children: new Map(), file });
  }

  function convert(node: RawNode, parentPath: string): FileTreeNode[] {
    const entries = [...node.children.entries()].sort(([aName, a], [bName, b]) => {
      const aIsDir = !a.file;
      const bIsDir = !b.file;
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
      return aName.localeCompare(bName);
    });

    const result: FileTreeNode[] = [];

    for (const [name, child] of entries) {
      const fullPath = parentPath ? `${parentPath}/${name}` : name;

      if (child.file) {
        result.push({
          name,
          path: fullPath,
          children: [],
          file: child.file,
          linesAdded: child.file.lines_added,
          linesRemoved: child.file.lines_removed,
          fileCount: 1,
        });
      } else {
        // Compact single-child directory chains
        let cur = child;
        let compactedName = name;
        let compactedPath = fullPath;

        while (cur.children.size === 1) {
          const entry = cur.children.entries().next();
          if (entry.done) break;
          const [onlyName, onlyChild] = entry.value;
          if (onlyChild.file) break; // stop before a file leaf
          compactedName += '/' + onlyName;
          compactedPath += '/' + onlyName;
          cur = onlyChild;
        }

        const children = convert(cur, compactedPath);
        let linesAdded = 0,
          linesRemoved = 0,
          fileCount = 0;
        for (const c of children) {
          linesAdded += c.linesAdded;
          linesRemoved += c.linesRemoved;
          fileCount += c.fileCount;
        }
        result.push({
          name: compactedName,
          path: compactedPath,
          children,
          linesAdded,
          linesRemoved,
          fileCount,
        });
      }
    }

    return result;
  }

  return convert(root, '');
}

/**
 * Flatten the tree into a list of visible rows based on which directories are collapsed.
 * Directories not in `collapsed` are expanded (i.e. default = all expanded).
 */
export function flattenVisibleTree(
  nodes: FileTreeNode[],
  collapsed: Set<string>,
  depth = 0,
): FlatTreeRow[] {
  const result: FlatTreeRow[] = [];
  for (const node of nodes) {
    const isDir = node.children.length > 0;
    result.push({ node, depth, isDir });
    if (isDir && !collapsed.has(node.path)) {
      for (const row of flattenVisibleTree(node.children, collapsed, depth + 1)) {
        result.push(row);
      }
    }
  }
  return result;
}
