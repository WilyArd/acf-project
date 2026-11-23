import type { CollectionRequestItem } from '../types/api';

export interface FolderNode {
  /** Path lengkap folder, unik per collection; dipakai sebagai key state expand/collapse. */
  key: string;
  name: string;
  folders: FolderNode[];
  items: CollectionRequestItem[];
  /** Jumlah request di folder ini beserta seluruh turunannya. */
  totalCount: number;
}

export interface CollectionTree {
  folders: FolderNode[];
  rootItems: CollectionRequestItem[];
}

function insert(
  into: CollectionTree,
  path: string[],
  item: CollectionRequestItem,
): void {
  if (path.length === 0) {
    into.rootItems.push(item);
    return;
  }

  let level = into.folders;
  let current: FolderNode | undefined;

  for (let depth = 0; depth < path.length; depth += 1) {
    const name = path[depth]!;
    let node = level.find((candidate) => candidate.name === name);
    if (!node) {
      node = {
        key: path.slice(0, depth + 1).join('/'),
        name,
        folders: [],
        items: [],
        totalCount: 0,
      };
      level.push(node);
    }
    current = node;
    level = node.folders;
  }

  current!.items.push(item);
}

function sumCounts(node: FolderNode): number {
  let total = node.items.length;
  for (const child of node.folders) {
    total += sumCounts(child);
  }
  node.totalCount = total;
  return total;
}

/**
 * Menyusun `folderPath` datar menjadi pohon folder bersarang agar sidebar dapat
 * dilipat per level seperti Postman, bukan satu label gabungan per path.
 */
export function buildCollectionTree(items: readonly CollectionRequestItem[]): CollectionTree {
  const tree: CollectionTree = { folders: [], rootItems: [] };
  for (const item of items) {
    insert(tree, item.folderPath.filter((segment) => segment !== ''), item);
  }
  for (const folder of tree.folders) {
    sumCounts(folder);
  }
  return tree;
}

export function collectFolderItemIds(node: FolderNode): string[] {
  const ids = node.items.map((item) => item.id);
  for (const child of node.folders) {
    ids.push(...collectFolderItemIds(child));
  }
  return ids;
}
