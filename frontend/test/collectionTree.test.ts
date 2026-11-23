import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCollectionTree,
  collectFolderItemIds,
  type FolderNode,
} from '../src/lib/collectionTree.ts';
import type { CollectionRequestItem } from '../src/types/api.ts';

function item(id: string, folderPath: string[], name = id): CollectionRequestItem {
  return {
    id,
    name,
    folderPath,
    method: 'GET',
    url: `https://example.test/${id}`,
    headers: [],
    queryParams: [],
    bodyText: '',
    warnings: [],
  };
}

function findFolder(node: FolderNode, name: string): FolderNode | undefined {
  for (const folder of node.folders) {
    if (folder.name === name) return folder;
    const nested = findFolder(folder, name);
    if (nested) return nested;
  }
  return undefined;
}

test('buildCollectionTree nests sibling folders under their shared parent', () => {
  const tree = buildCollectionTree([
    item('a', ['App Version']),
    item('b', ['Student', 'Authentication']),
    item('c', ['Student', 'Rules']),
    item('d', ['Student', 'Subject', 'Exam']),
  ]);

  assert.deepEqual(
    tree.folders.map((f) => f.name),
    ['App Version', 'Student'],
  );

  const student = findFolder(tree, 'Student');
  assert.ok(student);
  assert.deepEqual(
    student.folders.map((f) => f.name),
    ['Authentication', 'Rules', 'Subject'],
  );

  const subject = findFolder(tree, 'Subject');
  assert.ok(subject);
  assert.deepEqual(subject.folders.map((f) => f.name), ['Exam']);
  assert.deepEqual(subject.folders[0]!.items.map((i) => i.id), ['d']);
});

test('buildCollectionTree keeps requests declared directly in a folder', () => {
  const tree = buildCollectionTree([
    item('root-req', []),
    item('direct', ['Student']),
    item('nested', ['Student', 'Rules']),
  ]);

  const student = findFolder(tree, 'Student');
  assert.ok(student);
  assert.deepEqual(student.items.map((i) => i.id), ['direct']);
  assert.deepEqual(tree.rootItems.map((i) => i.id), ['root-req']);
  assert.deepEqual(findFolder(tree, 'Rules')!.items.map((i) => i.id), ['nested']);
});

test('buildCollectionTree does not duplicate a folder that appears in separate branches', () => {
  const tree = buildCollectionTree([
    item('x', ['Student', 'Class']),
    item('y', ['Teacher', 'Class']),
  ]);

  const student = findFolder(tree, 'Student');
  const teacher = findFolder(tree, 'Teacher');
  assert.ok(student && teacher);
  assert.deepEqual(student.folders.map((f) => f.name), ['Class']);
  assert.deepEqual(teacher.folders.map((f) => f.name), ['Class']);
  assert.deepEqual(student.folders[0]!.items.map((i) => i.id), ['x']);
  assert.deepEqual(teacher.folders[0]!.items.map((i) => i.id), ['y']);
});

test('buildCollectionTree reports a folder request count including all descendants', () => {
  const tree = buildCollectionTree([
    item('a', ['Student']),
    item('b', ['Student', 'Rules']),
    item('c', ['Student', 'Subject', 'Exam']),
    item('d', ['App Version']),
  ]);

  const student = findFolder(tree, 'Student');
  assert.ok(student);
  assert.equal(student.totalCount, 3);
  assert.equal(findFolder(tree, 'Subject')!.totalCount, 1);
  assert.equal(findFolder(tree, 'App Version')!.totalCount, 1);
});

test('collectFolderItemIds returns ids of the folder and every descendant', () => {
  const tree = buildCollectionTree([
    item('a', ['Student']),
    item('b', ['Student', 'Rules']),
    item('c', ['Student', 'Subject', 'Exam']),
    item('d', ['App Version']),
  ]);

  const student = findFolder(tree, 'Student');
  assert.ok(student);
  assert.deepEqual(collectFolderItemIds(student).sort(), ['a', 'b', 'c']);
  assert.deepEqual(collectFolderItemIds(findFolder(tree, 'Subject')!), ['c']);
});

test('buildCollectionTree gives each folder a unique key safe for expand state', () => {
  const tree = buildCollectionTree([
    item('x', ['Student', 'Class']),
    item('y', ['Teacher', 'Class']),
  ]);

  const keys = [
    ...tree.folders.map((f) => f.key),
    ...findFolder(tree, 'Student')!.folders.map((f) => f.key),
    ...findFolder(tree, 'Teacher')!.folders.map((f) => f.key),
  ];
  assert.equal(new Set(keys).size, keys.length);
});

test('buildCollectionTree keeps root requests separate from folders so folders can render first', () => {
  const tree = buildCollectionTree([
    item('loose-1', []),
    item('loose-2', []),
    item('filed', ['App Version']),
    item('nested', ['Student', 'Rules']),
  ]);

  // Request tanpa folder tidak boleh ikut masuk ke node folder mana pun.
  assert.deepEqual(tree.rootItems.map((i) => i.id), ['loose-1', 'loose-2']);
  assert.deepEqual(tree.folders.map((f) => f.name), ['App Version', 'Student']);
  assert.deepEqual(findFolder(tree, 'App Version')!.items.map((i) => i.id), ['filed']);
});

test('buildCollectionTree preserves declaration order of folders and of requests', () => {
  const tree = buildCollectionTree([
    item('z', ['Zeta']),
    item('a', ['Alpha']),
    item('m', ['Zeta']),
  ]);

  assert.deepEqual(tree.folders.map((f) => f.name), ['Zeta', 'Alpha']);
  assert.deepEqual(findFolder(tree, 'Zeta')!.items.map((i) => i.id), ['z', 'm']);
});
