import React, { useEffect, useMemo, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { File01Icon, FileImportIcon, Folder01Icon } from '@hugeicons/core-free-icons';
import type { CollectionGroup, CollectionRequestItem, Environment } from '../types/api';
import { MAX_IMPORT_BYTES, MAX_IMPORT_MB } from '../lib/postmanImport';
import {
  parseAutoImportFile,
  parseBrunoCollectionFiles,
} from '../lib/brunoImport';
import {
  fetchGitHubFiles,
  inspectGitHubTarget,
  type DiscoveredBrunoCollection,
  type DiscoveredJsonFile,
} from '../lib/githubImport';

const PREVIEW_ROW_LIMIT = 200;

type ImportSourceTab = 'local' | 'github';

interface ImportPostmanModalProps {
  open: boolean;
  onClose: () => void;
  onImportSingleRequest: (item: CollectionRequestItem, collectionName: string) => void;
  onImportCollectionTree: (collection: CollectionGroup, firstItem: CollectionRequestItem) => void;
  onImportEnvironment: (env: Environment) => void;
}

interface LoadedEnvEntry {
  fileName: string;
  env: Environment;
  secretCount: number;
}

interface LoadedCollectionEntry {
  fileName: string;
  sourceLabel: string;
  collection: CollectionGroup;
}

interface ScannedGitHubRepo {
  owner: string;
  repo: string;
  ref: string;
  brunoCollections: DiscoveredBrunoCollection[];
  jsonFiles: DiscoveredJsonFile[];
  truncated: boolean;
}

function mergeEnvEntries(base: LoadedEnvEntry[], incoming: LoadedEnvEntry[]): LoadedEnvEntry[] {
  const next = [...base];
  for (const entry of incoming) {
    const idx = next.findIndex((e) => e.env.name === entry.env.name);
    if (idx >= 0) {
      next[idx] = entry;
    } else {
      next.push(entry);
    }
  }
  return next;
}

interface DroppedLocalFile {
  file: File;
  relativePath: string;
}

interface FsEntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath?: string;
  file?: (success: (f: File) => void, error?: () => void) => void;
  createReader?: () => {
    readEntries: (success: (entries: FsEntryLike[]) => void, error?: () => void) => void;
  };
}

const IGNORED_DROP_DIRS = new Set(['node_modules', '.git', '.vscode', '.idea', 'dist', 'build']);
const MAX_DROP_FILES = 2500;
const MAX_DROP_DEPTH = 32;

async function readFsEntryRecursive(
  entry: FsEntryLike,
  out: DroppedLocalFile[],
  prefix: string,
  depth: number,
): Promise<void> {
  if (depth > MAX_DROP_DEPTH || out.length >= MAX_DROP_FILES) return;

  if (entry.isFile && entry.file) {
    const file = await new Promise<File | null>((resolve) => {
      entry.file?.(resolve, () => resolve(null));
    });
    if (file && out.length < MAX_DROP_FILES) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      out.push({ file, relativePath: rel });
    }
    return;
  }

  if (entry.isDirectory && entry.createReader) {
    if (IGNORED_DROP_DIRS.has(entry.name.toLowerCase())) return;
    const reader = entry.createReader();
    const children: FsEntryLike[] = [];
    // readEntries returns batches (often <=100 per call), loop until empty array
    while (children.length < MAX_DROP_FILES) {
      const batch = await new Promise<FsEntryLike[]>((resolve) => {
        reader.readEntries(resolve, () => resolve([]));
      });
      if (batch.length === 0) break;
      children.push(...batch);
    }
    const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
    for (const child of children) {
      if (out.length >= MAX_DROP_FILES) break;
      await readFsEntryRecursive(child, out, nextPrefix, depth + 1);
    }
  }
}

async function collectDroppedFiles(dataTransfer: DataTransfer): Promise<DroppedLocalFile[]> {
  const items = Array.from(dataTransfer.items ?? []);
  const entries: FsEntryLike[] = [];
  for (const item of items) {
    const withEntry = item as DataTransferItem & { webkitGetAsEntry?: () => FsEntryLike | null };
    const fsEntry = withEntry.webkitGetAsEntry?.();
    if (fsEntry) entries.push(fsEntry);
  }

  if (entries.length > 0) {
    const out: DroppedLocalFile[] = [];
    for (const entry of entries) {
      if (out.length >= MAX_DROP_FILES) break;
      await readFsEntryRecursive(entry, out, '', 0);
    }
    if (out.length > 0) return out;
  }

  return Array.from(dataTransfer.files ?? []).map((file) => ({
    file,
    relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
  }));
}

export const ImportPostmanModal: React.FC<ImportPostmanModalProps> = ({
  open,
  onClose,
  onImportSingleRequest,
  onImportCollectionTree,
  onImportEnvironment,
}) => {
  const [sourceTab, setSourceTab] = useState<ImportSourceTab>('local');
  const [errors, setErrors] = useState<string[]>([]);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [isDragActive, setIsDragActive] = useState(false);

  const [loadedCollection, setLoadedCollection] = useState<LoadedCollectionEntry | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [previewFilter, setPreviewFilter] = useState('');
  const [loadedEnvs, setLoadedEnvs] = useState<LoadedEnvEntry[]>([]);

  // GitHub import state (session-only; PAT cleared immediately when modal closes)
  const [githubUrl, setGithubUrl] = useState('');
  const [githubBranch, setGithubBranch] = useState('');
  const [githubToken, setGithubToken] = useState('');
  const [scannedRepo, setScannedRepo] = useState<ScannedGitHubRepo | null>(null);
  const [githubJsonFilter, setGithubJsonFilter] = useState('');

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) {
      abortRef.current?.abort();
      abortRef.current = null;
      setSourceTab('local');
      setErrors([]);
      setStatusMessage(null);
      setIsParsing(false);
      setIsDragActive(false);
      setLoadedCollection(null);
      setSelectedItemId(null);
      setPreviewFilter('');
      setLoadedEnvs([]);
      setGithubUrl('');
      setGithubBranch('');
      setGithubToken('');
      setScannedRepo(null);
      setGithubJsonFilter('');
    }
  }, [open]);

  // Attach webkitdirectory imperatively to keep TSX props standard
  useEffect(() => {
    if (folderInputRef.current) {
      folderInputRef.current.setAttribute('webkitdirectory', '');
      folderInputRef.current.setAttribute('directory', '');
    }
  }, [open, sourceTab]);

  const filteredPreviewItems = useMemo(() => {
    if (!loadedCollection) return [];
    const q = previewFilter.trim().toLowerCase();
    if (!q) return loadedCollection.collection.items;
    return loadedCollection.collection.items.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        item.folderPath.join(' ').toLowerCase().includes(q) ||
        item.method.toLowerCase().includes(q),
    );
  }, [loadedCollection, previewFilter]);

  const filteredGitHubJsonFiles = useMemo(() => {
    if (!scannedRepo) return [];
    const q = githubJsonFilter.trim().toLowerCase();
    if (!q) return scannedRepo.jsonFiles;
    return scannedRepo.jsonFiles.filter((f) => f.path.toLowerCase().includes(q));
  }, [scannedRepo, githubJsonFilter]);

  if (!open) return null;

  const applyParsedSingleFile = (
    fileName: string,
    text: string,
    currentCol: LoadedCollectionEntry | null,
    currentSelectedId: string | null,
    currentEnvs: LoadedEnvEntry[],
    nextErrors: string[],
  ): {
    collection: LoadedCollectionEntry | null;
    selectedId: string | null;
    envs: LoadedEnvEntry[];
  } => {
    const res = parseAutoImportFile(fileName, text);
    if (!res.ok) {
      nextErrors.push(`${fileName}: ${res.error}`);
      return { collection: currentCol, selectedId: currentSelectedId, envs: currentEnvs };
    }

    if (res.kind === 'collection') {
      const sourceLabel =
        res.source === 'bruno-json'
          ? 'BRUNO JSON'
          : res.source === 'bruno-bru'
            ? 'BRUNO .BRU'
            : 'POSTMAN';

      const extraEnvs: LoadedEnvEntry[] = res.environments.map((env) => ({
        fileName: `${fileName} (vars/env)`,
        env,
        secretCount: env.variables.filter((v) => v.type === 'secret').length,
      }));

      return {
        collection: { fileName, sourceLabel, collection: res.collection },
        selectedId: res.collection.items[0]?.id ?? null,
        envs: mergeEnvEntries(currentEnvs, extraEnvs),
      };
    }

    return {
      collection: currentCol,
      selectedId: currentSelectedId,
      envs: mergeEnvEntries(currentEnvs, [
        {
          fileName,
          env: res.environment,
          secretCount: res.secretFlaggedCount,
        },
      ]),
    };
  };

  const processLocalEntries = async (entries: DroppedLocalFile[]) => {
    if (entries.length === 0) return;

    setIsParsing(true);
    setErrors([]);
    setStatusMessage('Membaca file lokal...');
    try {
      const nextErrors: string[] = [];
      let nextCollection = loadedCollection;
      let nextSelectedId = selectedItemId;
      let nextEnvs = [...loadedEnvs];

      // Check if selection includes Bruno folder/multi-.bru files
      const bruBundleCandidates: Array<{ path: string; content: string }> = [];
      const regularFiles: File[] = [];

      let totalBytes = 0;
      for (const { file, relativePath } of entries) {
        const relPath = relativePath || file.name;
        const lower = relPath.toLowerCase();
        const base = lower.split('/').pop() ?? lower;
        const fromFolder = relPath.includes('/');

        // Ignore irrelevant files when user selects or drops a whole folder
        if (fromFolder && !lower.endsWith('.bru') && !lower.endsWith('.json')) {
          continue;
        }

        if (file.size > MAX_IMPORT_BYTES) {
          nextErrors.push(
            `${file.name}: Ukuran file (${(file.size / (1024 * 1024)).toFixed(1)} MB) melebihi batas maksimal ${MAX_IMPORT_MB} MB.`,
          );
          continue;
        }

        totalBytes += file.size;
        if (totalBytes > MAX_IMPORT_BYTES * 2) {
          nextErrors.push('Total ukuran seluruh file terlalu besar. Pilih folder koleksi yang lebih spesifik.');
          break;
        }

        if (lower.endsWith('.bru') || base === 'bruno.json') {
          try {
            const content = await file.text();
            bruBundleCandidates.push({ path: relPath, content });
          } catch {
            nextErrors.push(`${file.name}: Gagal membaca file.`);
          }
        } else if (lower.endsWith('.json')) {
          regularFiles.push(file);
        } else if (!fromFolder) {
          nextErrors.push(`${file.name}: Format tidak didukung. Gunakan file .json atau .bru.`);
        }
      }

      // Assemble Bruno .bru bundle if any .bru files were provided
      if (bruBundleCandidates.length > 0) {
        const assembled = parseBrunoCollectionFiles(bruBundleCandidates);
        if (!assembled.ok) {
          nextErrors.push(assembled.error);
        } else {
          if (assembled.collection) {
            nextCollection = {
              fileName: `${bruBundleCandidates.length} file Bruno`,
              sourceLabel: 'BRUNO .BRU',
              collection: assembled.collection,
            };
            nextSelectedId = assembled.collection.items[0]?.id ?? null;
          }
          if (assembled.environments.length > 0) {
            nextEnvs = mergeEnvEntries(
              nextEnvs,
              assembled.environments.map((env) => ({
                fileName: `${env.name}.bru`,
                env,
                secretCount: env.variables.filter((v) => v.type === 'secret').length,
              })),
            );
          }
        }
      }

      // Parse remaining JSON files individually
      for (const file of regularFiles) {
        let text: string;
        try {
          text = await file.text();
        } catch {
          nextErrors.push(`${file.name}: Gagal membaca file.`);
          continue;
        }
        const updated = applyParsedSingleFile(
          file.name,
          text,
          nextCollection,
          nextSelectedId,
          nextEnvs,
          nextErrors,
        );
        nextCollection = updated.collection;
        nextSelectedId = updated.selectedId;
        nextEnvs = updated.envs;
      }

      setErrors(nextErrors);
      setLoadedCollection(nextCollection);
      setSelectedItemId(nextSelectedId);
      setLoadedEnvs(nextEnvs);
    } catch {
      setErrors(['Gagal membaca atau memparse file lokal yang dipilih.']);
    } finally {
      setStatusMessage(null);
      setIsParsing(false);
      setIsDragActive(false);
    }
  };

  const handleLocalFiles = async (fileList: FileList | File[]) => {
    const entries: DroppedLocalFile[] = Array.from(fileList).map((file) => ({
      file,
      relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
    }));
    await processLocalEntries(entries);
  };

  const handleDropLocal = async (dataTransfer: DataTransfer) => {
    setIsDragActive(false);
    setIsParsing(true);
    setErrors([]);
    setStatusMessage('Memindai file & folder yang ditarik...');
    try {
      const entries = await collectDroppedFiles(dataTransfer);
      if (entries.length === 0) {
        setStatusMessage(null);
        setIsParsing(false);
        return;
      }
      await processLocalEntries(entries);
    } catch {
      setErrors(['Gagal membaca file atau folder yang ditarik ke dropzone.']);
      setStatusMessage(null);
      setIsParsing(false);
    }
  };

  const handleLoadGitHubBrunoCollection = async (
    repo: ScannedGitHubRepo,
    targetCol: DiscoveredBrunoCollection,
    controller: AbortController,
  ) => {
    setIsParsing(true);
    setErrors([]);
    setStatusMessage(`Mengunduh 0 / ${targetCol.filePaths.length} file Bruno dari GitHub...`);

    try {
      const fetched = await fetchGitHubFiles(repo.owner, repo.repo, repo.ref, targetCol.filePaths, {
        token: githubToken,
        signal: controller.signal,
        onProgress: (done, total) => {
          setStatusMessage(`Mengunduh ${done} / ${total} file Bruno dari GitHub...`);
        },
      });

      if (!fetched.ok) {
        setErrors([fetched.error]);
        return;
      }

      const fallbackName =
        targetCol.rootPath ? targetCol.rootPath.split('/').pop() || repo.repo : repo.repo;
      const assembled = parseBrunoCollectionFiles(fetched.files, fallbackName);
      if (!assembled.ok) {
        setErrors([assembled.error]);
        return;
      }

      if (assembled.collection) {
        setLoadedCollection({
          fileName: `${repo.owner}/${repo.repo}/${targetCol.rootPath || ''}`,
          sourceLabel: 'GITHUB · BRUNO',
          collection: assembled.collection,
        });
        setSelectedItemId(assembled.collection.items[0]?.id ?? null);
      }

      if (assembled.environments.length > 0) {
        setLoadedEnvs((prev) =>
          mergeEnvEntries(
            prev,
            assembled.environments.map((env) => ({
              fileName: `GitHub: ${env.name}.bru`,
              env,
              secretCount: env.variables.filter((v) => v.type === 'secret').length,
            })),
          ),
        );
      }
    } catch {
      setErrors(['Terjadi kesalahan saat mengunduh koleksi Bruno dari GitHub.']);
    } finally {
      setStatusMessage(null);
      setIsParsing(false);
      setIsDragActive(false);
    }
  };

  const handleLoadGitHubJsonFile = async (
    repo: ScannedGitHubRepo,
    jsonFile: DiscoveredJsonFile,
  ) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsParsing(true);
    setErrors([]);
    setStatusMessage(`Mengunduh ${jsonFile.path}...`);

    try {
      const fetched = await fetchGitHubFiles(repo.owner, repo.repo, repo.ref, [jsonFile.path], {
        token: githubToken,
        signal: controller.signal,
      });

      if (!fetched.ok) {
        setErrors([fetched.error]);
        return;
      }

      const nextErrors: string[] = [];
      const updated = applyParsedSingleFile(
        jsonFile.path,
        fetched.files[0].content,
        loadedCollection,
        selectedItemId,
        loadedEnvs,
        nextErrors,
      );

      if (updated.collection && updated.collection !== loadedCollection) {
        updated.collection = {
          ...updated.collection,
          sourceLabel: `GITHUB · ${updated.collection.sourceLabel}`,
        };
      }

      setErrors(nextErrors);
      setLoadedCollection(updated.collection);
      setSelectedItemId(updated.selectedId);
      setLoadedEnvs(updated.envs);
    } catch {
      setErrors(['Terjadi kesalahan saat mengunduh file JSON dari GitHub.']);
    } finally {
      setStatusMessage(null);
      setIsParsing(false);
      setIsDragActive(false);
    }
  };

  const handleScanGitHub = async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsParsing(true);
    setErrors([]);
    setScannedRepo(null);
    setStatusMessage('Memindai repository GitHub...');

    try {
      const res = await inspectGitHubTarget(githubUrl, {
        token: githubToken,
        branchOverride: githubBranch,
        signal: controller.signal,
      });

      if (!res.ok) {
        setErrors([res.error]);
        return;
      }

      if (res.mode === 'single-file') {
        const nextErrors: string[] = [];
        const updated = applyParsedSingleFile(
          res.fileName,
          res.content,
          loadedCollection,
          selectedItemId,
          loadedEnvs,
          nextErrors,
        );
        if (updated.collection && updated.collection !== loadedCollection) {
          updated.collection = {
            ...updated.collection,
            sourceLabel: `GITHUB · ${updated.collection.sourceLabel}`,
          };
        }
        setErrors(nextErrors);
        setLoadedCollection(updated.collection);
        setSelectedItemId(updated.selectedId);
        setLoadedEnvs(updated.envs);
        return;
      }

      const repoState: ScannedGitHubRepo = {
        owner: res.owner,
        repo: res.repo,
        ref: res.ref,
        brunoCollections: res.brunoCollections,
        jsonFiles: res.jsonFiles,
        truncated: res.truncated,
      };
      setScannedRepo(repoState);

      // Auto-load immediately if repo/folder has exactly 1 Bruno collection and no JSON files
      if (res.brunoCollections.length === 1 && res.jsonFiles.length === 0) {
        await handleLoadGitHubBrunoCollection(repoState, res.brunoCollections[0], controller);
        return;
      }
    } catch {
      setErrors(['Terjadi kesalahan tak terduga saat memindai repository GitHub.']);
    } finally {
      setStatusMessage(null);
      setIsParsing(false);
      setIsDragActive(false);
    }
  };

  const selectedRequest =
    loadedCollection?.collection.items.find((it) => it.id === selectedItemId) ??
    loadedCollection?.collection.items[0] ??
    null;

  const hasCollection = loadedCollection !== null && selectedRequest !== null;
  const hasEnvs = loadedEnvs.length > 0;

  const handleImportAll = () => {
    for (const entry of loadedEnvs) {
      onImportEnvironment(entry.env);
    }
    if (loadedCollection && selectedRequest) {
      onImportCollectionTree(loadedCollection.collection, selectedRequest);
    }
    onClose();
  };

  const handleImportSelectedOnly = () => {
    for (const entry of loadedEnvs) {
      onImportEnvironment(entry.env);
    }
    if (loadedCollection && selectedRequest) {
      onImportSingleRequest(selectedRequest, loadedCollection.collection.name);
    }
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'var(--scrim)' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-modal-title"
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border"
        style={{
          backgroundColor: 'var(--surface-recessed)',
          borderColor: 'var(--border-control)',
          boxShadow: 'var(--shadow-modal)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between border-b px-5 py-3.5"
          style={{ borderColor: 'var(--border-hairline)' }}
        >
          <div>
            <h2
              id="import-modal-title"
              className="text-sm font-bold"
              style={{ color: 'var(--text-primary)' }}
            >
              Import Collection & Environment
            </h2>
            <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Mendukung Postman (.json), Bruno (.json / .bru / folder), dan Repository GitHub
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Tutup dialog import"
            className="inline-flex h-8 w-8 items-center justify-center rounded text-sm"
            style={{ color: 'var(--text-secondary)' }}
          >
            x
          </button>
        </div>

        {/* Source Switcher Tabs */}
        <div
          role="tablist"
          aria-label="Sumber import"
          className="flex border-b px-5"
          style={{
            backgroundColor: 'var(--surface-elevated)',
            borderColor: 'var(--border-hairline)',
          }}
        >
          {(
            [
              { id: 'local', label: 'File / Folder (Postman & Bruno)' },
              { id: 'github', label: 'Dari Repo GitHub' },
            ] as const
          ).map((tab) => {
            const active = sourceTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => {
                  if (sourceTab !== tab.id) {
                    abortRef.current?.abort();
                    setSourceTab(tab.id);
                    setErrors([]);
                    setStatusMessage(null);
                    setIsParsing(false);
                    setLoadedCollection(null);
                    setSelectedItemId(null);
                    setPreviewFilter('');
                    setLoadedEnvs([]);
                  }
                }}
                className="relative px-3 py-2.5 text-xs transition-colors"
                style={{
                  color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                  fontWeight: active ? 600 : 400,
                }}
              >
                {tab.label}
                {active && (
                  <span
                    className="absolute inset-x-1 bottom-0 h-0.5 rounded-t"
                    style={{ backgroundColor: 'var(--brand-action)' }}
                    aria-hidden="true"
                  />
                )}
              </button>
            );
          })}
        </div>

        {/* Content */}
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          {sourceTab === 'local' ? (
            /* Unified Local Dropzone (Postman JSON + Bruno JSON + Bruno .bru / Folder) */
            <div
              onDragEnter={(e) => {
                e.preventDefault();
                setIsDragActive(true);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                if (!isDragActive) setIsDragActive(true);
              }}
              onDragLeave={(e) => {
                if (e.currentTarget === e.target) setIsDragActive(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                void handleDropLocal(e.dataTransfer);
              }}
              className="rounded-md border border-dashed p-5 text-center transition-colors"
              style={{
                backgroundColor: isDragActive ? 'var(--brand-tint)' : 'var(--surface-elevated)',
                borderColor: isDragActive ? 'var(--brand-action)' : 'var(--border-strong)',
              }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,.bru,application/json,text/plain"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.length) void handleLocalFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              <input
                ref={folderInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.length) void handleLocalFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              <div className="mb-2 flex justify-center">
                <span
                  className="inline-flex h-9 w-9 items-center justify-center rounded-lg border"
                  style={{
                    backgroundColor: 'var(--surface-recessed)',
                    borderColor: 'var(--border-control)',
                    color: 'var(--brand-tint-text)',
                  }}
                >
                  <HugeiconsIcon icon={FileImportIcon} size={18} strokeWidth={1.8} />
                </span>
              </div>
              <p className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
                Tarik file Postman (.json), Bruno (.json / .bru), atau tarik Folder Bruno ke sini
              </p>
              <p className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Deteksi otomatis Collection & Environment · Maks. {MAX_IMPORT_MB} MB per file · Diparse 100% di browser
              </p>
              <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                <button
                  type="button"
                  disabled={isParsing}
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 rounded-md border px-3.5 py-1.5 text-xs font-semibold disabled:opacity-50"
                  style={{
                    backgroundColor: 'var(--surface-recessed)',
                    borderColor: 'var(--border-control)',
                    color: 'var(--text-primary)',
                  }}
                >
                  <HugeiconsIcon icon={File01Icon} size={13} strokeWidth={1.8} />
                  <span>{isParsing ? 'Memproses...' : 'Pilih File (.json / .bru)'}</span>
                </button>
                <button
                  type="button"
                  disabled={isParsing}
                  onClick={() => folderInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 rounded-md border px-3.5 py-1.5 text-xs font-semibold disabled:opacity-50"
                  style={{
                    backgroundColor: 'var(--brand-tint)',
                    borderColor: 'var(--brand-tint-border)',
                    color: 'var(--brand-tint-text)',
                  }}
                >
                  <HugeiconsIcon icon={Folder01Icon} size={13} strokeWidth={1.8} />
                  <span>Pilih Folder Bruno</span>
                </button>
              </div>
              <p className="mt-2.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                Tips: Drag &amp; drop folder langsung ke kotak ini agar tidak memicu dialog izin &quot;Upload files&quot; bawaan browser.
              </p>
            </div>
          ) : (
            /* GitHub Repository / Folder / File Import */
            <div
              className="space-y-3 rounded-md border p-4"
              style={{
                backgroundColor: 'var(--surface-elevated)',
                borderColor: 'var(--border-hairline)',
              }}
            >
              <div>
                <label
                  htmlFor="github-import-url"
                  className="block text-xs font-semibold"
                  style={{ color: 'var(--text-primary)' }}
                >
                  URL Repository, Folder, atau File GitHub
                </label>
                <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  Contoh: <span className="font-mono">https://github.com/owner/repo</span>,{' '}
                  <span className="font-mono">.../tree/main/bruno</span>, atau URL file{' '}
                  <span className="font-mono">.json</span> / <span className="font-mono">.bru</span>
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <input
                    id="github-import-url"
                    type="text"
                    value={githubUrl}
                    onChange={(e) => setGithubUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !isParsing && githubUrl.trim()) {
                        void handleScanGitHub();
                      }
                    }}
                    placeholder="https://github.com/owner/repo atau owner/repo"
                    className="h-9 min-w-0 flex-1 rounded-md border px-3 font-mono text-xs"
                    style={{
                      backgroundColor: 'var(--surface-recessed)',
                      borderColor: 'var(--border-control)',
                      color: 'var(--text-primary)',
                    }}
                  />
                  <button
                    type="button"
                    disabled={isParsing || !githubUrl.trim()}
                    onClick={() => void handleScanGitHub()}
                    className="h-9 shrink-0 rounded-md px-4 text-xs font-bold disabled:opacity-50"
                    style={{
                      backgroundColor: 'var(--brand-action)',
                      color: 'var(--brand-on-action)',
                    }}
                  >
                    {isParsing ? 'Memuat...' : 'Pindai & Muat'}
                  </button>
                </div>
              </div>

              <div className="grid gap-2.5 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="github-import-branch"
                    className="block text-[11px] font-medium"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    Branch (opsional, otomatis jika kosong)
                  </label>
                  <input
                    id="github-import-branch"
                    type="text"
                    value={githubBranch}
                    onChange={(e) => setGithubBranch(e.target.value)}
                    placeholder="main / develop"
                    className="mt-1 h-8 w-full rounded-md border px-2.5 font-mono text-xs"
                    style={{
                      backgroundColor: 'var(--surface-recessed)',
                      borderColor: 'var(--border-hairline)',
                      color: 'var(--text-primary)',
                    }}
                  />
                </div>
                <div>
                  <label
                    htmlFor="github-import-token"
                    className="block text-[11px] font-medium"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    GitHub Token / PAT (opsional, untuk repo privat)
                  </label>
                  <input
                    id="github-import-token"
                    type="password"
                    autoComplete="off"
                    value={githubToken}
                    onChange={(e) => setGithubToken(e.target.value)}
                    placeholder="ghp_... (hanya di memori sesi)"
                    className="mt-1 h-8 w-full rounded-md border px-2.5 font-mono text-xs"
                    style={{
                      backgroundColor: 'var(--surface-recessed)',
                      borderColor: 'var(--border-hairline)',
                      color: 'var(--text-primary)',
                    }}
                  />
                </div>
              </div>

              <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Diambil langsung dari browser ke GitHub API. Token PAT hanya dipakai saat import dan langsung dihapus saat dialog ditutup.
              </p>

              {/* Discovered Repo Items Picker */}
              {scannedRepo && (
                <div
                  className="space-y-2.5 border-t pt-3"
                  style={{ borderColor: 'var(--border-hairline)' }}
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                      Ditemukan di{' '}
                      <span className="font-mono">
                        {scannedRepo.owner}/{scannedRepo.repo}@{scannedRepo.ref}
                      </span>
                    </span>
                    {scannedRepo.truncated && (
                      <span className="text-[10px]" style={{ color: 'var(--status-warn-fg)' }}>
                        Repo sangat besar; arahkan URL ke subfolder lebih spesifik.
                      </span>
                    )}
                  </div>

                  {scannedRepo.brunoCollections.length > 0 && (
                    <div className="space-y-1.5">
                      <p
                        className="text-[10px] font-semibold tracking-wider uppercase"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        Koleksi Bruno ({scannedRepo.brunoCollections.length})
                      </p>
                      {scannedRepo.brunoCollections.map((bc) => (
                        <div
                          key={bc.id}
                          className="flex items-center justify-between gap-2 rounded border px-2.5 py-2 text-xs"
                          style={{
                            backgroundColor: 'var(--surface-recessed)',
                            borderColor: 'var(--border-hairline)',
                          }}
                        >
                          <div className="min-w-0">
                            <p className="truncate font-mono font-semibold" style={{ color: 'var(--text-primary)' }}>
                              {bc.label}
                            </p>
                            <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                              {bc.filePaths.length} file (.bru{bc.hasBrunoJson ? ' + bruno.json' : ''})
                            </p>
                          </div>
                          <button
                            type="button"
                            disabled={isParsing}
                            onClick={() => {
                              abortRef.current?.abort();
                              const controller = new AbortController();
                              abortRef.current = controller;
                              void handleLoadGitHubBrunoCollection(scannedRepo, bc, controller);
                            }}
                            className="shrink-0 rounded border px-2.5 py-1 text-[11px] font-semibold disabled:opacity-50"
                            style={{
                              backgroundColor: 'var(--brand-tint)',
                              borderColor: 'var(--brand-tint-border)',
                              color: 'var(--brand-tint-text)',
                            }}
                          >
                            Muat Koleksi
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {scannedRepo.jsonFiles.length > 0 && (
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <p
                          className="text-[10px] font-semibold tracking-wider uppercase"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          File JSON Kandidat ({scannedRepo.jsonFiles.length})
                        </p>
                        {scannedRepo.jsonFiles.length > 6 && (
                          <input
                            type="search"
                            value={githubJsonFilter}
                            onChange={(e) => setGithubJsonFilter(e.target.value)}
                            placeholder="Filter path JSON..."
                            className="h-6 w-44 rounded border bg-transparent px-2 text-[11px]"
                            style={{
                              borderColor: 'var(--border-hairline)',
                              color: 'var(--text-primary)',
                            }}
                          />
                        )}
                      </div>
                      <div className="max-h-36 space-y-1 overflow-y-auto">
                        {filteredGitHubJsonFiles.slice(0, 50).map((jf) => (
                          <div
                            key={jf.path}
                            className="flex items-center justify-between gap-2 rounded border px-2.5 py-1.5 text-xs"
                            style={{
                              backgroundColor: 'var(--surface-recessed)',
                              borderColor: 'var(--border-hairline)',
                            }}
                          >
                            <span
                              className="min-w-0 flex-1 truncate font-mono text-[11px]"
                              style={{ color: 'var(--text-primary)' }}
                              title={jf.path}
                            >
                              {jf.path}
                            </span>
                            <button
                              type="button"
                              disabled={isParsing}
                              onClick={() => void handleLoadGitHubJsonFile(scannedRepo, jf)}
                              className="shrink-0 rounded border px-2 py-0.5 text-[11px] font-semibold disabled:opacity-50"
                              style={{
                                backgroundColor: 'var(--surface-elevated)',
                                borderColor: 'var(--border-control)',
                                color: 'var(--text-primary)',
                              }}
                            >
                              Muat
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {statusMessage && (
            <div
              className="rounded-md border px-3 py-2 text-xs font-medium"
              style={{
                backgroundColor: 'var(--surface-elevated)',
                borderColor: 'var(--border-control)',
                color: 'var(--text-secondary)',
              }}
            >
              {statusMessage}
            </div>
          )}

          {errors.length > 0 && (
            <div
              role="alert"
              className="space-y-1 rounded-md border p-3 text-xs font-medium"
              style={{
                backgroundColor: 'var(--status-fail-bg)',
                borderColor: 'var(--status-fail-border)',
                color: 'var(--status-fail-fg)',
              }}
            >
              {errors.map((err, i) => (
                <p key={i}>{err}</p>
              ))}
            </div>
          )}

          {/* Auto-detected Collection Preview */}
          {loadedCollection && (
            <div className="space-y-2.5">
              <div
                className="overflow-hidden rounded-md border"
                style={{
                  backgroundColor: 'var(--surface-elevated)',
                  borderColor: 'var(--border-hairline)',
                }}
              >
                <div
                  className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2 text-xs"
                  style={{
                    backgroundColor: 'var(--surface-canvas)',
                    borderColor: 'var(--border-hairline)',
                  }}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="rounded px-1.5 py-0.5 font-mono text-[10px] font-bold"
                      style={{
                        backgroundColor: 'var(--brand-tint)',
                        color: 'var(--brand-tint-text)',
                      }}
                    >
                      {loadedCollection.sourceLabel}
                    </span>
                    <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {loadedCollection.collection.name} ({loadedCollection.collection.items.length} request)
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setLoadedCollection(null);
                      setSelectedItemId(null);
                    }}
                    className="text-[11px] font-semibold"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    Hapus
                  </button>
                </div>

                <div
                  className="border-b px-3 py-1.5"
                  style={{ borderColor: 'var(--border-hairline)' }}
                >
                  <label htmlFor="import-collection-filter" className="sr-only">
                    Cari request dalam collection
                  </label>
                  <input
                    id="import-collection-filter"
                    type="search"
                    value={previewFilter}
                    onChange={(e) => setPreviewFilter(e.target.value)}
                    placeholder="Cari endpoint di collection ini..."
                    className="h-7 w-full rounded border bg-transparent px-2 text-xs"
                    style={{
                      borderColor: 'var(--border-hairline)',
                      color: 'var(--text-primary)',
                    }}
                  />
                </div>

                <div
                  className="border-b px-3 py-1.5 text-[11px]"
                  style={{
                    backgroundColor: 'var(--surface-canvas)',
                    borderColor: 'var(--border-hairline)',
                    color: 'var(--text-muted)',
                  }}
                >
                  Pilih 1 endpoint awal yang langsung dibuka (atau muat tunggal via tombol di bawah):
                </div>

                <div
                  className="max-h-44 divide-y overflow-y-auto"
                  style={{ borderColor: 'var(--border-hairline)' }}
                >
                  {filteredPreviewItems.slice(0, PREVIEW_ROW_LIMIT).map((item) => {
                    const checked = item.id === selectedRequest?.id;
                    return (
                      <label
                        key={item.id}
                        className="flex items-center gap-2.5 px-3 py-2 text-xs"
                        style={{
                          backgroundColor: checked ? 'var(--surface-recessed)' : 'transparent',
                        }}
                      >
                        <input
                          type="radio"
                          name="postman-request-pick"
                          checked={checked}
                          onChange={() => setSelectedItemId(item.id)}
                          className="accent-[var(--brand-action)]"
                        />
                        <span
                          className="w-11 shrink-0 font-mono text-[10px] font-bold"
                          style={{ color: 'var(--brand-tint-text)' }}
                        >
                          {item.method}
                        </span>
                        <span
                          className="min-w-0 flex-1 truncate"
                          style={{ color: 'var(--text-primary)' }}
                        >
                          {item.folderPath.length > 0 ? `${item.folderPath.join(' / ')} / ` : ''}
                          {item.name}
                        </span>
                      </label>
                    );
                  })}
                  {filteredPreviewItems.length > PREVIEW_ROW_LIMIT && (
                    <p
                      className="px-3 py-2 text-[11px]"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      Menampilkan {PREVIEW_ROW_LIMIT} dari {filteredPreviewItems.length} request. Gunakan pencarian di atas atau klik "Import Semua" untuk memuat seluruhnya ke sidebar.
                    </p>
                  )}
                </div>
              </div>

              <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                Catatan: Script/Tests Postman & Bruno diabaikan; atur validasi otomatis secara deklaratif di tab Assertions.
              </p>
            </div>
          )}

          {/* Auto-detected Environment Preview(s) */}
          {loadedEnvs.map((entry) => (
            <div
              key={entry.env.id}
              className="space-y-2 rounded-md border p-3.5 text-xs"
              style={{
                backgroundColor: 'var(--surface-elevated)',
                borderColor: 'var(--border-hairline)',
              }}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span
                    className="rounded px-1.5 py-0.5 font-mono text-[10px] font-bold"
                    style={{
                      backgroundColor: 'var(--status-pass-bg)',
                      color: 'var(--status-pass-fg)',
                    }}
                  >
                    ENVIRONMENT
                  </span>
                  <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {entry.env.name} ({entry.env.variables.length} variabel)
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setLoadedEnvs((prev) => prev.filter((item) => item.env.id !== entry.env.id))
                  }
                  className="text-[11px] font-semibold"
                  style={{ color: 'var(--text-muted)' }}
                >
                  Hapus
                </button>
              </div>

              {entry.secretCount > 0 && (
                <p className="text-[11px]" style={{ color: 'var(--brand-tint-text)' }}>
                  {entry.secretCount} variabel sensitif otomatis ditandai Secret (dimasking dan hanya di memori sesi).
                </p>
              )}

              <ul className="max-h-32 space-y-1 overflow-y-auto font-mono text-[11px]">
                {entry.env.variables.slice(0, PREVIEW_ROW_LIMIT).map((v) => (
                  <li key={v.id} className="flex items-center justify-between gap-2">
                    <span style={{ color: 'var(--text-primary)' }}>{v.key}</span>
                    <span className="truncate" style={{ color: 'var(--text-muted)' }}>
                      {v.type === 'secret' ? 'Secret (masked)' : v.currentValue || '(kosong)'}
                    </span>
                  </li>
                ))}
              </ul>
              {entry.env.variables.length > PREVIEW_ROW_LIMIT && (
                <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  Menampilkan {PREVIEW_ROW_LIMIT} dari {entry.env.variables.length} variabel.
                </p>
              )}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div
          className="flex flex-wrap items-center justify-end gap-2 border-t px-5 py-3"
          style={{ borderColor: 'var(--border-hairline)' }}
        >
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-3.5 py-2 text-xs font-semibold"
            style={{
              backgroundColor: 'var(--surface-elevated)',
              borderColor: 'var(--border-control)',
              color: 'var(--text-primary)',
            }}
          >
            Batal
          </button>

          {hasCollection && loadedCollection && selectedRequest && (
            <>
              <button
                type="button"
                onClick={handleImportSelectedOnly}
                className="rounded-md border px-3.5 py-2 text-xs font-semibold"
                style={{
                  backgroundColor: 'var(--brand-tint)',
                  borderColor: 'var(--brand-tint-border)',
                  color: 'var(--brand-tint-text)',
                }}
              >
                {hasEnvs ? 'Muat 1 Terpilih + Env' : 'Muat 1 Terpilih'}
              </button>
              <button
                type="button"
                onClick={handleImportAll}
                className="rounded-md px-4 py-2 text-xs font-bold"
                style={{
                  backgroundColor: 'var(--brand-action)',
                  color: 'var(--brand-on-action)',
                }}
              >
                Import Semua
              </button>
            </>
          )}

          {!hasCollection && hasEnvs && (
            <button
              type="button"
              onClick={handleImportAll}
              className="rounded-md px-4 py-2 text-xs font-bold"
              style={{
                backgroundColor: 'var(--brand-action)',
                color: 'var(--brand-on-action)',
              }}
            >
              Simpan & Aktifkan {loadedEnvs.length > 1 ? `${loadedEnvs.length} Environment` : 'Environment'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
