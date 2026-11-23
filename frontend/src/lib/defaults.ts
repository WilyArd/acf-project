import type { AssertionDraft, CollectionGroup, Environment } from '../types/api';

export const INITIAL_ENVIRONMENTS: Environment[] = [];

export const INITIAL_COLLECTIONS: CollectionGroup[] = [];

export const INITIAL_ASSERTIONS: AssertionDraft[] = [
  {
    id: 'asrt-status',
    enabled: true,
    type: 'STATUS_CODE',
    operator: 'equals',
    target: '',
    expectedInput: '200',
  },
];
