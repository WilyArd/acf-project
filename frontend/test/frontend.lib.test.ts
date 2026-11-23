import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExecutePayload,
  extractAutoToken,
  lookupDotPath,
  substituteTemplate,
  transitionEnvVarType,
  validateJsonTemplateSyntax,
} from '../src/lib/variables.ts';
import {
  appendHistoryEntry,
  HISTORY_STORAGE_KEY,
  loadHistory,
  MAX_HISTORY_ENTRIES,
} from '../src/lib/history.ts';
import {
  exportEnvironmentAsPostmanJson,
  parsePostmanAutoJson,
  parsePostmanCollectionJson,
  parsePostmanEnvironmentJson,
} from '../src/lib/postmanImport.ts';
import {
  parseAutoImportFile,
  parseBruEnvironment,
  parseBruRequest,
  parseBrunoCollectionFiles,
  parseBrunoCollectionJson,
} from '../src/lib/brunoImport.ts';
import {
  discoverGitHubImportTargets,
  parseGitHubUrl,
  sanitizeGitHubPath,
} from '../src/lib/githubImport.ts';
import {
  MAX_BATCH_REQUESTS,
  moveBatchItem,
  runSequentialBatch,
  toggleBatchFolderSelection,
  toggleBatchSelection,
} from '../src/lib/batchRunner.ts';
import { sanitizeWorkspaceSnapshot } from '../src/lib/sessionStorageDb.ts';
import {
  closeRequestTab,
  createBlankTabSession,
  duplicateRequestTab,
  openBlankRequestTab,
  openImportedSingleTab,
  openOrFocusCollectionTab,
  unlinkRemovedCollectionTabs,
} from '../src/lib/requestTabs.ts';
import { resolveResponseBody, tokenizeJsonLine } from '../src/lib/jsonFormat.ts';
import {
  applyPostResponseVarRulesToEnv,
  detectBareJwtAuthorizationHeader,
  extractPostResponseVarRulesFromPostmanEvents,
  mergeCollectionAndActiveEnv,
  upsertTokenIntoEnvironment,
} from '../src/lib/postResponseScripts.ts';
import type { CollectionRequestItem, Environment } from '../src/types/api.ts';

const sampleEnv: Environment = {
  id: 'env-1',
  name: 'Demo Exam',
  variables: [
    {
      id: 'v1',
      enabled: true,
      key: 'url',
      type: 'default',
      initialValue: 'https://demo-cbt-api.sidigs.id',
      currentValue: 'https://demo-cbt-api.sidigs.id',
    },
    {
      id: 'v2',
      enabled: true,
      key: 'api_secret',
      type: 'secret',
      initialValue: '',
      currentValue: 'super-secret-value',
    },
  ],
};

test('substituteTemplate resolves environment vars and token passthrough {{$.data.token}}', () => {
  const res = substituteTemplate(
    'Bearer {{$.data.token}} @ {{url}}',
    sampleEnv,
    { data: { token: 'jwt-123' } },
  );
  assert.equal(res.resolved, 'Bearer jwt-123 @ https://demo-cbt-api.sidigs.id');
  assert.deepEqual(res.unresolved, []);
  assert.equal(res.references.length, 2);
});

test('substituteTemplate reports unresolved placeholders when No Environment is active', () => {
  const res = substituteTemplate('{{url}}/api/check', null, null);
  assert.equal(res.resolved, '{{url}}/api/check');
  assert.deepEqual(res.unresolved, ['url']);
});

test('lookupDotPath distinguishes missing keys from explicit null values', () => {
  const obj = { data: { token: null } };
  assert.deepEqual(lookupDotPath(obj, 'data.token'), { found: true, value: null });
  assert.deepEqual(lookupDotPath(obj, 'data.missing'), { found: false, value: undefined });
});

test('buildExecutePayload builds backend-compliant payload and locks exists expectedValue to null', () => {
  const built = buildExecutePayload({
    method: 'POST',
    url: '{{url}}/api/login',
    queryParams: [
      { id: 'q1', enabled: true, key: 'app_code', value: 'teacher', description: '' },
    ],
    headers: [
      { id: 'h1', enabled: true, key: 'Authorization', value: 'Bearer {{$.data.token}}', description: '' },
    ],
    bodyText: '{"username": "tester"}',
    assertions: [
      { id: 'a1', enabled: true, type: 'STATUS_CODE', operator: 'equals', target: '', expectedInput: '200' },
      { id: 'a2', enabled: true, type: 'LATENCY', operator: 'less_than_or_equal', target: '', expectedInput: '500' },
      { id: 'a3', enabled: true, type: 'BODY_JSON_PATH', operator: 'exists', target: '$.data.token', expectedInput: 'ignored' },
    ],
    activeEnv: sampleEnv,
    lastResponseBody: { data: { token: 'abc.def.ghi' } },
  });

  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.payload.request.url, 'https://demo-cbt-api.sidigs.id/api/login');
  assert.deepEqual(built.payload.request.headers, { Authorization: 'Bearer abc.def.ghi' });
  assert.deepEqual(built.payload.request.queryParams, { app_code: 'teacher' });
  assert.deepEqual(built.payload.request.body, { username: 'tester' });
  assert.deepEqual(built.payload.assertions, [
    { type: 'STATUS_CODE', operator: 'equals', target: null, expectedValue: 200 },
    { type: 'LATENCY', operator: 'less_than_or_equal', target: null, expectedValue: 500 },
    { type: 'BODY_JSON_PATH', operator: 'exists', target: 'data.token', expectedValue: null },
  ]);
});

test('buildExecutePayload omits body on GET and blocks unresolved variables', () => {
  const blocked = buildExecutePayload({
    method: 'GET',
    url: '{{url}}/api/test',
    queryParams: [],
    headers: [],
    bodyText: '{"ignored": true}',
    assertions: [
      { id: 'a1', enabled: true, type: 'STATUS_CODE', operator: 'equals', target: '', expectedInput: '200' },
    ],
    activeEnv: null,
    lastResponseBody: null,
  });
  assert.equal(blocked.ok, false);

  const okGet = buildExecutePayload({
    method: 'GET',
    url: '{{url}}/api/test',
    queryParams: [],
    headers: [],
    bodyText: '{invalid json ignored on GET',
    assertions: [
      { id: 'a1', enabled: true, type: 'STATUS_CODE', operator: 'equals', target: '', expectedInput: '200' },
    ],
    activeEnv: sampleEnv,
    lastResponseBody: null,
  });
  assert.equal(okGet.ok, true);
  if (!okGet.ok) return;
  assert.equal('body' in okGet.payload.request, false);
});

test('history localStorage enforces strict 6-field whitelist and 50-entry cap', () => {
  const backing = new Map<string, string>();
  const mockStorage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => {
      backing.set(k, v);
    },
  };

  const dirtyEntry = {
    method: 'POST',
    url: 'https://demo.sidigs.id/login',
    timestamp: '2026-11-22T05:00:00.000Z',
    overallStatus: 'PASS',
    passedCount: 2,
    failedCount: 0,
    headers: { Authorization: 'Bearer LEAKED' },
    body: { password: 'LEAKED' },
  } as unknown as Parameters<typeof appendHistoryEntry>[0];

  appendHistoryEntry(dirtyEntry, mockStorage);
  const rawStored = backing.get(HISTORY_STORAGE_KEY) ?? '';
  assert.equal(rawStored.includes('LEAKED'), false);
  assert.equal(rawStored.includes('headers'), false);
  assert.equal(rawStored.includes('password'), false);

  for (let i = 0; i < 60; i += 1) {
    appendHistoryEntry(
      {
        method: 'GET',
        url: `https://example.com/${i}`,
        timestamp: new Date().toISOString(),
        overallStatus: 'PASS',
        passedCount: 1,
        failedCount: 0,
      },
      mockStorage,
    );
  }
  assert.equal(loadHistory(mockStorage).length, MAX_HISTORY_ENTRIES);
});

test('parsePostmanCollectionJson parses v2.1 folders, ignores scripts, and emits warnings', () => {
  const colJson = JSON.stringify({
    info: {
      name: 'SIDIGS API',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: [
      {
        name: 'App Version',
        item: [
          {
            name: 'Check Version',
            event: [{ listen: 'test', script: { exec: ['pm.test("x",()=>{})'] } }],
            request: {
              method: 'GET',
              header: [
                { key: 'X-Test', value: 'one' },
                { key: 'x-test', value: 'two' },
              ],
              url: {
                raw: '{{url}}/api/app-version/check?app_code=teacher',
                query: [{ key: 'app_code', value: 'teacher' }],
              },
            },
          },
        ],
      },
    ],
  });

  const parsed = parsePostmanCollectionJson(colJson);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.collection.name, 'SIDIGS API');
  assert.equal(parsed.collection.items.length, 1);
  const item = parsed.collection.items[0];
  assert.deepEqual(item.folderPath, ['App Version']);
  assert.equal(item.headers.length, 1);
  assert.equal(item.headers[0].value, 'two');
  assert.ok(item.warnings.some((w) => w.includes('Header duplikat')));
  assert.ok(item.warnings.some((w) => w.includes('Script')));
  assert.ok(item.warnings.some((w) => w.includes('{{url}}')));
});

test('parsePostmanEnvironmentJson flags secret keys and export strips secret values', () => {
  const envJson = JSON.stringify({
    name: 'PROD SIDIGS',
    values: [
      { key: 'url', value: 'https://api.sidigs.id', enabled: true },
      { key: 'api_secret_token', value: 'top-secret-999', enabled: true },
    ],
  });

  const parsed = parsePostmanEnvironmentJson(envJson);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.secretFlaggedCount, 1);
  assert.equal(parsed.environment.variables[1].type, 'secret');
  assert.equal(parsed.environment.variables[1].initialValue, '');

  const exported = exportEnvironmentAsPostmanJson(parsed.environment);
  assert.equal(exported.includes('top-secret-999'), false);
  assert.equal(exported.includes('https://api.sidigs.id'), true);
});

test('parsePostmanAutoJson auto-detects collection vs environment JSON', () => {
  const col = parsePostmanAutoJson(
    JSON.stringify({
      info: { name: 'Col A', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [{ name: 'Ping', request: { method: 'GET', url: 'https://example.com/ping' } }],
    }),
  );
  assert.equal(col.ok, true);
  if (col.ok) assert.equal(col.kind, 'collection');

  const env = parsePostmanAutoJson(
    JSON.stringify({ name: 'Env A', values: [{ key: 'url', value: 'https://example.com' }] }),
  );
  assert.equal(env.ok, true);
  if (env.ok) assert.equal(env.kind, 'environment');

  const bad = parsePostmanAutoJson(JSON.stringify({ foo: 'bar' }));
  assert.equal(bad.ok, false);
});

test('parsePostmanAutoJson accepts 10.5 MB collection and rejects >20 MB', () => {
  const padding = 'x'.repeat(1024 * 1024 * 10.5);
  const largeCol = JSON.stringify({
    info: {
      name: 'Large SIDIGS Collection',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: [
      {
        name: 'Check Large',
        request: {
          method: 'POST',
          url: '{{url}}/api/test',
          body: { mode: 'raw', raw: JSON.stringify({ pad: padding }) },
        },
      },
    ],
  });
  const okRes = parsePostmanAutoJson(largeCol);
  assert.equal(okRes.ok, true);

  const oversized = 'a'.repeat(21 * 1024 * 1024);
  const failRes = parsePostmanAutoJson(oversized);
  assert.equal(failRes.ok, false);
});

test('parsePostmanCollectionJson inherits collection/folder bearer auth and extracts collection variables', () => {
  const colJson = JSON.stringify({
    info: {
      name: 'SIDIGS Full',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    auth: {
      type: 'bearer',
      bearer: [{ key: 'token', value: '{{jwt_token}}' }],
    },
    variable: [
      { key: 'url', value: 'https://demo-cbt-api.sidigs.id' },
      { key: 'jwt_token', value: 'secret-token-xyz' },
    ],
    item: [
      {
        name: 'Teacher',
        item: [
          {
            name: 'Profile',
            request: {
              method: 'GET',
              url: {
                protocol: 'https',
                host: ['{{url}}'],
                path: ['api', 'teacher', 'profile'],
              },
            },
          },
        ],
      },
    ],
  });

  const parsed = parsePostmanCollectionJson(colJson);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const item = parsed.collection.items[0];
  assert.equal(item.url, '{{url}}/api/teacher/profile');
  assert.ok(
    item.headers.some((h) => h.key.toLowerCase() === 'authorization' && h.value === 'Bearer {{jwt_token}}'),
    'Expected inherited Bearer auth header',
  );
  assert.ok(parsed.collectionEnv, 'Expected extracted collection-level environment variables');
  assert.equal(parsed.collectionEnv?.variables.length, 2);
  assert.equal(parsed.collectionEnv?.variables[1].type, 'secret');
});

test('parsePostmanCollectionJson converts urlencoded and formdata fields to JSON body with warning', () => {
  const colJson = JSON.stringify({
    info: {
      name: 'Form Col',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: [
      {
        name: 'Login Form',
        request: {
          method: 'POST',
          url: 'https://api.example.com/login',
          body: {
            mode: 'formdata',
            formdata: [
              { key: 'email', value: 'guru@sidigs.id', type: 'text' },
              { key: 'password', value: '123456', type: 'text' },
              { key: 'avatar', type: 'file', src: '/tmp/a.png' },
            ],
          },
        },
      },
    ],
  });

  const parsed = parsePostmanCollectionJson(colJson);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const item = parsed.collection.items[0];
  const bodyObj = JSON.parse(item.bodyText);
  assert.deepEqual(bodyObj, { email: 'guru@sidigs.id', password: '123456' });
  assert.ok(item.warnings.some((w) => w.toLowerCase().includes('formdata')));
});

test('buildExecutePayload normalizes double slash after substituted {{url}} trailing slash', () => {
  const envWithSlash: Environment = {
    id: 'e-slash',
    name: 'Slash Env',
    variables: [
      {
        id: 'v1',
        enabled: true,
        key: 'url',
        type: 'default',
        initialValue: 'https://demo-api.sidigs.id/',
        currentValue: 'https://demo-api.sidigs.id/',
      },
      {
        id: 'v2',
        enabled: true,
        key: 'expected_code',
        type: 'default',
        initialValue: 'teacher',
        currentValue: 'teacher',
      },
    ],
  };

  const built = buildExecutePayload({
    method: 'GET',
    url: '{{url}}/api/app-version/check',
    queryParams: [
      { id: 'q1', enabled: true, key: 'k', value: 'first', description: '' },
      { id: 'q2', enabled: true, key: 'k', value: 'second', description: '' },
    ],
    headers: [
      { id: 'h1', enabled: true, key: 'X-Test', value: 'one', description: '' },
      { id: 'h2', enabled: true, key: 'x-test', value: 'two', description: '' },
    ],
    bodyText: '',
    assertions: [
      {
        id: 'a1',
        enabled: true,
        type: 'BODY_JSON_PATH',
        operator: 'equals',
        target: '.data.app_code',
        expectedInput: '{{expected_code}}',
      },
    ],
    activeEnv: envWithSlash,
    lastResponseBody: null,
  });

  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.payload.request.url, 'https://demo-api.sidigs.id/api/app-version/check');
  assert.deepEqual(built.payload.request.queryParams, { k: 'second' });
  assert.deepEqual(built.payload.request.headers, { 'x-test': 'two' });
  assert.equal(built.payload.assertions[0].target, 'data.app_code');
  assert.equal(built.payload.assertions[0].expectedValue, 'teacher');
});

test('validateJsonTemplateSyntax allows both quoted and unquoted {{var}} placeholders', () => {
  assert.equal(validateJsonTemplateSyntax('{"id": {{user_id}}, "name": "{{user_name}}"}').ok, true);
  assert.equal(validateJsonTemplateSyntax('{"broken": }').ok, false);
});

test('extractAutoToken finds token across common REST API response paths', () => {
  assert.deepEqual(extractAutoToken({ data: { token: 't1' } }), { path: 'data.token', value: 't1' });
  assert.deepEqual(extractAutoToken({ access_token: 't2' }), { path: 'access_token', value: 't2' });
  assert.deepEqual(extractAutoToken({ data: { access_token: 't3' } }), { path: 'data.access_token', value: 't3' });
  assert.equal(extractAutoToken({ data: { token: null } }), null);
});

test('transitionEnvVarType preserves initialValue into currentValue when switching default -> secret', () => {
  const moved = transitionEnvVarType(
    {
      id: 'v1',
      enabled: true,
      key: 'api_key',
      type: 'default',
      initialValue: 'my-real-key',
      currentValue: '',
    },
    'secret',
  );
  assert.equal(moved.type, 'secret');
  assert.equal(moved.initialValue, '');
  assert.equal(moved.currentValue, 'my-real-key');
});

test('parseBrunoCollectionJson parses folders, inherited bearer auth, body, and embedded environments', () => {
  const brunoJson = JSON.stringify({
    name: 'SIDIGS Bruno',
    version: '1',
    root: {
      request: {
        auth: {
          mode: 'bearer',
          bearer: { token: '{{access_token}}' },
        },
        headers: [{ name: 'Accept', value: 'application/json', enabled: true }],
      },
    },
    items: [
      {
        type: 'folder',
        name: 'Student',
        items: [
          {
            type: 'http',
            name: 'Create Exam Attempt',
            request: {
              url: '{{url}}/api/student/attempt?kelas=10',
              method: 'POST',
              headers: [{ name: 'X-App', value: 'sidigs', enabled: true }],
              params: [
                { name: 'kelas', value: '10', type: 'query', enabled: true },
                { name: 'debug', value: '1', type: 'query', enabled: false },
              ],
              body: {
                mode: 'json',
                json: '{\n  "exam_id": {{exam_id}}\n}',
              },
              auth: { mode: 'inherit' },
              tests: 'test("status 200", () => {})',
            },
          },
        ],
      },
    ],
    environments: [
      {
        name: 'Demo Sidigs',
        variables: [
          { name: 'url', value: 'https://demo-api.sidigs.id', enabled: true, secret: false },
          { name: 'access_token', value: 'jwt-secret-123', enabled: true, secret: true },
        ],
      },
    ],
  });

  const parsed = parseBrunoCollectionJson(brunoJson);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.collection.name, 'SIDIGS Bruno');
  assert.equal(parsed.collection.items.length, 1);

  const item = parsed.collection.items[0];
  assert.deepEqual(item.folderPath, ['Student']);
  assert.equal(item.method, 'POST');
  assert.equal(item.url, '{{url}}/api/student/attempt');
  assert.equal(item.queryParams.length, 2);
  assert.equal(item.queryParams[1].enabled, false);
  assert.ok(
    item.headers.some((h) => h.key.toLowerCase() === 'authorization' && h.value === 'Bearer {{access_token}}'),
    'Expected inherited bearer auth header from Bruno root',
  );
  assert.ok(
    item.headers.some((h) => h.key.toLowerCase() === 'accept' && h.value === 'application/json'),
    'Expected inherited Accept header from Bruno root',
  );
  assert.ok(item.bodyText.includes('"exam_id": {{exam_id}}'));
  assert.ok(item.warnings.some((w) => w.toLowerCase().includes('script') || w.toLowerCase().includes('test')));

  assert.equal(parsed.environments.length, 1);
  assert.equal(parsed.environments[0].name, 'Demo Sidigs');
  assert.equal(parsed.environments[0].variables[1].type, 'secret');
  assert.equal(parsed.environments[0].variables[1].initialValue, '');
  assert.equal(parsed.environments[0].variables[1].currentValue, 'jwt-secret-123');
});

test('parseBruRequest parses .bru DSL blocks, disabled rows, path params, bearer auth, and json body', () => {
  const bruText = `meta {
  name: Update Profile
  type: http
  seq: 2
}

patch {
  url: {{url}}/api/users/:userId?lang=id
  body: json
  auth: bearer
}

params:query {
  lang: id
  ~verbose: true
}

params:path {
  userId: 42
}

headers {
  X-Client: web
  ~X-Unused: nope
}

auth:bearer {
  token: {{jwt}}
}

body:json {
  {
    "name": "Budi",
    "active": true
  }
}

assert {
  res.status: eq 200
}
`;

  const parsed = parseBruRequest(bruText, 'Users/Update Profile.bru');
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.item.name, 'Update Profile');
  assert.equal(parsed.item.method, 'PATCH');
  assert.equal(parsed.item.url, '{{url}}/api/users/42');
  assert.equal(parsed.item.queryParams.length, 2);
  assert.equal(parsed.item.queryParams[0].key, 'lang');
  assert.equal(parsed.item.queryParams[1].key, 'verbose');
  assert.equal(parsed.item.queryParams[1].enabled, false);
  assert.ok(parsed.item.headers.some((h) => h.key === 'Authorization' && h.value === 'Bearer {{jwt}}'));
  assert.ok(parsed.item.headers.some((h) => h.key === 'X-Client' && h.enabled === true));
  assert.ok(parsed.item.headers.some((h) => h.key === 'X-Unused' && h.enabled === false));
  assert.deepEqual(JSON.parse(parsed.item.bodyText), { name: 'Budi', active: true });
  assert.ok(parsed.item.warnings.some((w) => w.toLowerCase().includes('assert')));
});

test('parseBruEnvironment parses vars and vars:secret blocks', () => {
  const envBru = `vars {
  url: https://api.sidigs.id
  ~legacy_mode: 1
}

vars:secret [
  api_token,
  db_password
]
`;
  const parsed = parseBruEnvironment(envBru, 'Production.bru');
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.environment.name, 'Production');
  assert.equal(parsed.environment.variables.length, 4);
  assert.equal(parsed.environment.variables[0].key, 'url');
  assert.equal(parsed.environment.variables[0].currentValue, 'https://api.sidigs.id');
  assert.equal(parsed.environment.variables[1].key, 'legacy_mode');
  assert.equal(parsed.environment.variables[1].enabled, false);
  assert.equal(parsed.environment.variables[2].key, 'api_token');
  assert.equal(parsed.environment.variables[2].type, 'secret');
  assert.equal(parsed.secretFlaggedCount, 2);
});

test('parseBrunoCollectionFiles assembles folder tree, bruno.json name, collection.bru auth, and environments', () => {
  const assembled = parseBrunoCollectionFiles([
    {
      path: 'sidigs-bruno/bruno.json',
      content: JSON.stringify({ version: '1', name: 'SIDIGS Repo API', type: 'collection' }),
    },
    {
      path: 'sidigs-bruno/collection.bru',
      content: `auth:bearer {\n  token: {{session_jwt}}\n}\n\nheaders {\n  X-Org: sidigs\n}\n`,
    },
    {
      path: 'sidigs-bruno/environments/Staging.bru',
      content: `vars {\n  url: https://staging.sidigs.id\n}\n\nvars:secret [\n  session_jwt\n]\n`,
    },
    {
      path: 'sidigs-bruno/Teacher/List Classes.bru',
      content: `meta {\n  name: List Classes\n  type: http\n}\n\nget {\n  url: {{url}}/api/teacher/classes\n  auth: inherit\n}\n`,
    },
  ]);

  assert.equal(assembled.ok, true);
  if (!assembled.ok) return;
  assert.equal(assembled.collection?.name, 'SIDIGS Repo API');
  assert.equal(assembled.collection?.items.length, 1);
  const req = assembled.collection?.items[0];
  assert.deepEqual(req?.folderPath, ['Teacher']);
  assert.ok(req?.headers.some((h) => h.key === 'Authorization' && h.value === 'Bearer {{session_jwt}}'));
  assert.ok(req?.headers.some((h) => h.key === 'X-Org' && h.value === 'sidigs'));
  assert.equal(assembled.environments.length, 1);
  assert.equal(assembled.environments[0].name, 'Staging');
});

test('parseAutoImportFile detects Postman JSON, Bruno JSON, .bru request, and .bru environment', () => {
  const brunoEnv = parseAutoImportFile('Staging.bru', 'vars {\n  url: https://a.test\n}\n');
  assert.equal(brunoEnv.ok, true);
  if (brunoEnv.ok) assert.equal(brunoEnv.kind, 'environment');

  const brunoReq = parseAutoImportFile('Ping.bru', 'meta {\n  name: Ping\n  type: http\n}\nget {\n  url: https://a.test/ping\n}\n');
  assert.equal(brunoReq.ok, true);
  if (brunoReq.ok) assert.equal(brunoReq.kind, 'collection');

  const brunoJson = parseAutoImportFile(
    'col.json',
    JSON.stringify({
      name: 'Bruno Col',
      version: '1',
      items: [{ type: 'http', name: 'Health', request: { method: 'GET', url: 'https://a.test/health' } }],
    }),
  );
  assert.equal(brunoJson.ok, true);
  if (brunoJson.ok) assert.equal(brunoJson.kind, 'collection');
});

test('parseGitHubUrl parses repo, tree, blob, raw, shorthand, and rejects non-GitHub hosts', () => {
  assert.deepEqual(parseGitHubUrl('https://github.com/sidigs/api-collection'), {
    ok: true,
    target: { kind: 'repo', owner: 'sidigs', repo: 'api-collection', ref: undefined, path: '' },
  });

  assert.deepEqual(parseGitHubUrl('https://github.com/sidigs/api-collection/tree/main/bruno/v1'), {
    ok: true,
    target: { kind: 'tree', owner: 'sidigs', repo: 'api-collection', ref: 'main', path: 'bruno/v1' },
  });

  assert.deepEqual(parseGitHubUrl('https://github.com/sidigs/api-collection/blob/dev/postman/sidigs.json'), {
    ok: true,
    target: { kind: 'blob', owner: 'sidigs', repo: 'api-collection', ref: 'dev', path: 'postman/sidigs.json' },
  });

  assert.deepEqual(parseGitHubUrl('https://raw.githubusercontent.com/sidigs/api-collection/main/col.json'), {
    ok: true,
    target: { kind: 'raw', owner: 'sidigs', repo: 'api-collection', ref: 'main', path: 'col.json' },
  });

  assert.deepEqual(parseGitHubUrl('sidigs/api-collection'), {
    ok: true,
    target: { kind: 'repo', owner: 'sidigs', repo: 'api-collection', ref: undefined, path: '' },
  });

  const invalid = parseGitHubUrl('https://evil.example.com/sidigs/api-collection');
  assert.equal(invalid.ok, false);
});

test('discoverGitHubImportTargets groups Bruno folders and filters out non-collection config JSON files', () => {
  const targets = discoverGitHubImportTargets([
    { path: 'package.json', type: 'blob', size: 1200 },
    { path: 'tsconfig.json', type: 'blob', size: 400 },
    { path: 'node_modules/foo/bar.json', type: 'blob', size: 300 },
    { path: 'postman/sidigs.postman_collection.json', type: 'blob', size: 54000 },
    { path: 'postman/prod.postman_environment.json', type: 'blob', size: 900 },
    { path: 'bruno-api/bruno.json', type: 'blob', size: 120 },
    { path: 'bruno-api/collection.bru', type: 'blob', size: 180 },
    { path: 'bruno-api/Auth/Login.bru', type: 'blob', size: 350 },
    { path: 'bruno-api/environments/Prod.bru', type: 'blob', size: 140 },
  ]);

  assert.equal(targets.brunoCollections.length, 1);
  assert.equal(targets.brunoCollections[0].rootPath, 'bruno-api');
  assert.equal(targets.brunoCollections[0].filePaths.length, 4);
  assert.deepEqual(
    targets.jsonFiles.map((f) => f.path),
    ['postman/sidigs.postman_collection.json', 'postman/prod.postman_environment.json'],
  );
});

test('security: history localStorage strips URL userinfo, query parameters, and fragments', () => {
  const backing = new Map<string, string>();
  const mockStorage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => {
      backing.set(k, v);
    },
  };

  const next = appendHistoryEntry(
    {
      method: 'GET',
      url: 'https://admin:hunter2@api.example.com/v1/users?api_key=SECRET123&token=JWT#fragment_secret',
      timestamp: '2026-11-22T12:00:00.000Z',
      overallStatus: 'PASS',
      passedCount: 1,
      failedCount: 0,
    },
    mockStorage,
  );

  assert.equal(next[0]?.url, 'https://api.example.com/v1/users');
  const rawStored = backing.get(HISTORY_STORAGE_KEY) ?? '';
  assert.equal(rawStored.includes('hunter2'), false);
  assert.equal(rawStored.includes('SECRET123'), false);
  assert.equal(rawStored.includes('fragment_secret'), false);
});

test('security: buildExecutePayload JSON-escapes string template injections and redacts secret URLs', () => {
  const secretQueryEnv: Environment = {
    id: 'e-sec',
    name: 'Sec Env',
    variables: [
      { id: 'v1', enabled: true, key: 'api_key', type: 'secret', initialValue: '', currentValue: 'MY_REAL_KEY' },
    ],
  };

  const built = buildExecutePayload({
    method: 'POST',
    url: 'https://api.example.com/login',
    queryParams: [{ id: 'q1', enabled: true, key: 'key', value: '{{api_key}}', description: '' }],
    headers: [{ id: 'h1', enabled: true, key: 'Authorization', value: 'Bearer {{$.data.token}}', description: '' }],
    bodyText: '{"token": "{{$.data.token}}", "name": "user"}',
    assertions: [{ id: 'a1', enabled: true, type: 'STATUS_CODE', operator: 'equals', target: '', expectedInput: '200' }],
    activeEnv: secretQueryEnv,
    lastResponseBody: { data: { token: 'abc", "isAdmin": true, "x": "' } },
  });

  assert.equal(built.ok, true);
  if (!built.ok) return;
  const bodyObj = built.payload.request.body as Record<string, unknown>;
  assert.equal('isAdmin' in bodyObj, false);
  assert.equal(bodyObj.token, 'abc", "isAdmin": true, "x": "');
  assert.equal(built.resolvedFullUrl.includes('MY_REAL_KEY'), false);
});

test('security: buildExecutePayload rejects injected JSON sibling keys in unquoted placeholders', () => {
  const built = buildExecutePayload({
    method: 'POST',
    url: 'https://api.example.com/submit',
    queryParams: [],
    headers: [],
    bodyText: '{"id": {{$.data.id}}}',
    assertions: [{ id: 'a1', enabled: true, type: 'STATUS_CODE', operator: 'equals', target: '', expectedInput: '200' }],
    activeEnv: null,
    lastResponseBody: { data: { id: '1, "role": "superadmin"' } },
  });
  assert.equal(built.ok, false);
});

test('security: suppressResponseFallback revokes passthrough token even when lastResponseBody still holds it', () => {
  const sub = substituteTemplate(
    'Bearer {{$.data.token}}',
    null,
    { data: { token: 'old-session-jwt' } },
    null,
    { allowResponseFallback: false },
  );
  assert.equal(sub.resolved, 'Bearer {{$.data.token}}');
  assert.deepEqual(sub.unresolved, ['$.data.token']);
});

test('security: transitionEnvVarType secret -> default does not promote currentValue into initialValue', () => {
  const downgraded = transitionEnvVarType(
    {
      id: 'v1',
      enabled: true,
      key: 'jwt',
      type: 'secret',
      initialValue: '',
      currentValue: 'super-secret-jwt',
    },
    'default',
  );
  assert.equal(downgraded.type, 'default');
  assert.equal(downgraded.initialValue, '');
  const exported = exportEnvironmentAsPostmanJson({
    id: 'env',
    name: 'E',
    variables: [downgraded],
  });
  assert.equal(exported.includes('super-secret-jwt'), false);
});

test('security: parseGitHubUrl rejects malformed percent encoding, traversal paths, and invalid raw owner/repo', () => {
  assert.equal(parseGitHubUrl('https://github.com/owner/repo/blob/main/%E0%A4%A').ok, false);
  assert.equal(parseGitHubUrl('https://github.com/owner/repo/blob/main/../../user/orgs').ok, false);
  assert.equal(parseGitHubUrl('https://raw.githubusercontent.com/../evil/main/col.json').ok, false);
  assert.equal(sanitizeGitHubPath('a/../../b/file.json'), null);
});

test('security: Bruno & Postman parsers cap nesting depth, respect auth none & disabled basic fields, and stop path amplification', () => {
  const nestedDeep = (depth: number): Record<string, unknown> =>
    depth === 0
      ? { type: 'http', name: 'Leaf', request: { method: 'GET', url: 'https://example.com' } }
      : { type: 'folder', name: `F${depth}`, items: [nestedDeep(depth - 1)] };

  const brunoDeep = parseBrunoCollectionJson(
    JSON.stringify({ name: 'Deep', version: '1', items: [nestedDeep(45)] }),
  );
  assert.equal(brunoDeep.ok, false);

  const bruAuthNone = parseBruRequest(
    `meta {\n  name: Public\n  type: http\n}\nget {\n  url: https://other.example/ping\n  auth: none\n}\nauth:basic {\n  ~username: disabled\n  password: hidden\n}\n`,
    'Public.bru',
    {
      authHeader: { key: 'Authorization', value: 'Bearer {{root_jwt}}' },
      headers: [
        { enabled: true, key: 'Authorization', value: 'Bearer {{leaked_header}}' },
        { enabled: true, key: 'Accept', value: 'application/json' },
      ],
    },
  );
  assert.equal(bruAuthNone.ok, true);
  if (bruAuthNone.ok) {
    assert.equal(
      bruAuthNone.item.headers.some((h) => h.key.toLowerCase() === 'authorization'),
      false,
    );
    assert.equal(
      bruAuthNone.item.headers.some((h) => h.key.toLowerCase() === 'accept'),
      true,
    );
  }

  const singlePassPath = parseBruRequest(
    `meta {\n  name: PathTest\n  type: http\n}\nget {\n  url: https://example.com/:a/:b\n}\nparams:path {\n  a: :b\n  b: end\n}\n`,
    'PathTest.bru',
  );
  assert.equal(singlePassPath.ok, true);
  if (singlePassPath.ok) {
    assert.equal(singlePassPath.item.url, 'https://example.com/:b/end');
  }
});

function makeBatchItem(overrides: Partial<CollectionRequestItem> & { id: string; name: string; url: string }): CollectionRequestItem {
  return {
    folderPath: [],
    method: 'GET',
    headers: [],
    queryParams: [],
    bodyText: '',
    warnings: [],
    ...overrides,
  };
}

test('batchRunner selection helpers enforce order, up/down move, folder toggle, and 30-request cap', () => {
  assert.equal(MAX_BATCH_REQUESTS, 30);

  let selected: string[] = [];
  selected = toggleBatchSelection(selected, 'req-b');
  selected = toggleBatchSelection(selected, 'req-a');
  selected = toggleBatchSelection(selected, 'req-c');
  assert.deepEqual(selected, ['req-b', 'req-a', 'req-c']);

  selected = moveBatchItem(selected, 2, -1);
  assert.deepEqual(selected, ['req-b', 'req-c', 'req-a']);
  selected = moveBatchItem(selected, 0, -1);
  assert.deepEqual(selected, ['req-b', 'req-c', 'req-a']);

  selected = toggleBatchSelection(selected, 'req-c');
  assert.deepEqual(selected, ['req-b', 'req-a']);

  const thirtyFive = Array.from({ length: 35 }, (_, idx) => `item-${idx + 1}`);
  const capped = toggleBatchFolderSelection([], thirtyFive);
  assert.equal(capped.length, 30);
  const cleared = toggleBatchFolderSelection(capped, capped);
  assert.deepEqual(cleared, []);
});

test('runSequentialBatch executes POST -> GET sequentially with origin-scoped token chaining', async () => {
  const seenCalls: Array<{ method: string; url: string; auth?: string }> = [];
  const loginItem = makeBatchItem({
    id: 'step-1',
    name: 'Login',
    method: 'POST',
    url: 'https://api.sidigs.example/auth/login',
    bodyText: '{"user":"demo"}',
  });
  const profileItem = makeBatchItem({
    id: 'step-2',
    name: 'Profile',
    method: 'GET',
    url: 'https://api.sidigs.example/me',
    headers: [{ id: 'h1', enabled: true, key: 'Authorization', value: 'Bearer {{$.data.token}}', description: '' }],
  });
  const foreignItem = makeBatchItem({
    id: 'step-3',
    name: 'Other Domain',
    method: 'GET',
    url: 'https://other.example/leak',
    headers: [{ id: 'h2', enabled: true, key: 'Authorization', value: 'Bearer {{$.data.token}}', description: '' }],
  });

  const summary = await runSequentialBatch({
    steps: [
      { item: loginItem, collectionName: 'Demo' },
      { item: profileItem, collectionName: 'Demo' },
      { item: foreignItem, collectionName: 'Demo' },
    ],
    activeEnv: null,
    initialCapturedToken: null,
    initialLastResponseBody: null,
    stopOnFailure: false,
    delayMs: 0,
    executeFn: async (payload) => {
      seenCalls.push({
        method: payload.request.method,
        url: payload.request.url,
        auth: payload.request.headers.Authorization,
      });
      if (payload.request.url.endsWith('/auth/login')) {
        return {
          kind: 'result',
          data: {
            overallStatus: 'PASS',
            totalAssertions: 1,
            passedCount: 1,
            failedCount: 0,
            executedAt: '2026-11-22T14:00:00.000Z',
            assertionDetails: [],
            rawResponse: {
              statusCode: 200,
              responseTimeMs: 42,
              bodySizeBytes: 30,
              truncated: false,
              headers: {},
              body: { data: { token: 'chained-jwt-xyz' } },
            },
          },
        };
      }
      return {
        kind: 'result',
        data: {
          overallStatus: 'PASS',
          totalAssertions: 1,
          passedCount: 1,
          failedCount: 0,
          executedAt: '2026-11-22T14:00:01.000Z',
          assertionDetails: [],
          rawResponse: {
            statusCode: 200,
            responseTimeMs: 20,
            bodySizeBytes: 12,
            truncated: false,
            headers: {},
            body: { ok: true },
          },
        },
      };
    },
  });

  assert.equal(seenCalls.length, 2);
  assert.equal(seenCalls[0].method, 'POST');
  assert.equal(seenCalls[1].auth, 'Bearer chained-jwt-xyz');
  assert.equal(summary.passCount, 2);
  assert.equal(summary.validationCount, 1);
  assert.equal(summary.steps[2].status, 'validation');
  assert.equal(summary.finalCapturedToken?.value, 'chained-jwt-xyz');
});

test('runSequentialBatch respects stopOnFailure, auto-stops on 429, and handles AbortSignal', async () => {
  const s1 = makeBatchItem({ id: '1', name: 'First', url: 'https://api.example.com/1' });
  const s2 = makeBatchItem({ id: '2', name: 'Second', url: 'https://api.example.com/2' });
  const s3 = makeBatchItem({ id: '3', name: 'Third', url: 'https://api.example.com/3' });

  const stopRes = await runSequentialBatch({
    steps: [
      { item: s1, collectionName: 'C' },
      { item: s2, collectionName: 'C' },
      { item: s3, collectionName: 'C' },
    ],
    activeEnv: null,
    stopOnFailure: true,
    delayMs: 0,
    executeFn: async () => ({
      kind: 'result',
      data: {
        overallStatus: 'FAIL',
        totalAssertions: 1,
        passedCount: 0,
        failedCount: 1,
        executedAt: '2026-11-22T14:00:00.000Z',
        assertionDetails: [],
        rawResponse: {
          statusCode: 500,
          responseTimeMs: 10,
          bodySizeBytes: 2,
          truncated: false,
          headers: {},
          body: {},
        },
      },
    }),
  });
  assert.equal(stopRes.failCount, 1);
  assert.equal(stopRes.skippedCount, 2);
  assert.equal(stopRes.steps[1].status, 'skipped');

  const rateLimitedRes = await runSequentialBatch({
    steps: [
      { item: s1, collectionName: 'C' },
      { item: s2, collectionName: 'C' },
    ],
    activeEnv: null,
    stopOnFailure: false,
    delayMs: 0,
    executeFn: async () => ({
      kind: 'validation',
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Terlalu banyak request.',
        field: null,
        httpStatus: 429,
      },
    }),
  });
  assert.equal(rateLimitedRes.rateLimited, true);
  assert.equal(rateLimitedRes.steps[0].status, 'validation');
  assert.equal(rateLimitedRes.steps[1].status, 'skipped');

  const controller = new AbortController();
  let calls = 0;
  const abortedRes = await runSequentialBatch({
    steps: [
      { item: s1, collectionName: 'C' },
      { item: s2, collectionName: 'C' },
    ],
    activeEnv: null,
    stopOnFailure: false,
    delayMs: 0,
    signal: controller.signal,
    executeFn: async () => {
      calls += 1;
      controller.abort();
      return { kind: 'aborted' };
    },
  });
  assert.equal(calls, 1);
  assert.equal(abortedRes.aborted, true);
  assert.equal(abortedRes.steps[0].status, 'aborted');
  assert.equal(abortedRes.steps[1].status, 'aborted');
});

test('sanitizeWorkspaceSnapshot keeps structure & placeholder headers while stripping secrets and raw credentials', () => {
  const sanitized = sanitizeWorkspaceSnapshot({
    collections: [
      {
        id: 'col-1',
        name: 'SIDIGS',
        items: [
          makeBatchItem({
            id: 'r1',
            name: 'Auth Test',
            url: '{{url}}/api/me',
            headers: [
              { id: 'h1', enabled: true, key: 'Authorization', value: 'Bearer {{$.data.token}}', description: '' },
              { id: 'h2', enabled: true, key: 'X-API-Key', value: 'hardcoded-secret-key-999', description: '' },
              { id: 'h3', enabled: true, key: 'Cookie', value: 'session=abc123', description: '' },
              { id: 'h4', enabled: true, key: 'Accept', value: 'application/json', description: '' },
            ],
          }),
        ],
      },
    ],
    environments: [
      {
        id: 'env-1',
        name: 'Demo',
        variables: [
          { id: 'v1', enabled: true, key: 'url', type: 'default', initialValue: 'https://demo.sidigs.id', currentValue: 'https://demo.sidigs.id' },
          { id: 'v2', enabled: true, key: 'api_secret', type: 'secret', initialValue: 'should-clear', currentValue: 'TOP-SECRET-123' },
        ],
      },
    ],
    activeEnvId: 'env-missing',
  });

  assert.equal(sanitized.activeEnvId, null);
  assert.equal(sanitized.environments[0].variables[0].currentValue, 'https://demo.sidigs.id');
  assert.equal(sanitized.environments[0].variables[1].initialValue, '');
  assert.equal(sanitized.environments[0].variables[1].currentValue, '');

  const headers = sanitized.collections[0].items[0].headers;
  assert.equal(headers[0].value, 'Bearer {{$.data.token}}');
  assert.equal(headers[1].value, '');
  assert.equal(headers[2].value, '');
  assert.equal(headers[3].value, 'application/json');
});

test('requestTabs opens multiple tabs without duplicating active collection requests and handles closing cleanly', () => {
  const r1 = makeBatchItem({ id: 'req-1', name: 'Check Version', folderPath: ['App Version'] });
  const r2 = makeBatchItem({ id: 'req-2', name: 'Login Student', method: 'POST', folderPath: ['Auth'] });

  const init = createBlankTabSession('tab-0');
  let tabs = [init];
  let active = init.tabId;

  // Replacing initial pristine blank tab keeps length 1
  ({ tabs, activeTabId: active } = openOrFocusCollectionTab(tabs, active, r1, {
    collectionName: 'SIDIGS',
    tabId: 'tab-r1',
  }));
  assert.equal(tabs.length, 1);
  assert.equal(active, 'tab-r1');
  assert.equal(tabs[0].title, 'Check Version');

  // Opening second collection item opens tab #2
  ({ tabs, activeTabId: active } = openOrFocusCollectionTab(tabs, active, r2, {
    collectionName: 'SIDIGS',
    tabId: 'tab-r2',
  }));
  assert.equal(tabs.length, 2);
  assert.equal(active, 'tab-r2');

  // Clicking first item again focuses existing tab without creating duplicate
  ({ tabs, activeTabId: active } = openOrFocusCollectionTab(tabs, active, r1, {
    collectionName: 'SIDIGS',
    tabId: 'tab-dup',
  }));
  assert.equal(tabs.length, 2);
  assert.equal(active, 'tab-r1');

  // forceDuplicate opens an independent copy tab (and duplicateRequestTab clones any tab)
  ({ tabs, activeTabId: active } = openOrFocusCollectionTab(tabs, active, r1, {
    collectionName: 'SIDIGS',
    tabId: 'tab-r1-copy',
    forceDuplicate: true,
  }));
  assert.equal(tabs.length, 3);
  assert.equal(active, 'tab-r1-copy');
  assert.equal(tabs[2].requestId, null);

  ({ tabs, activeTabId: active } = duplicateRequestTab(tabs, 'tab-r1', 'tab-r1-dup2'));
  assert.equal(tabs.length, 4);
  assert.equal(active, 'tab-r1-dup2');
  assert.equal(tabs[1].tabId, 'tab-r1-dup2');
  assert.equal(tabs[1].title, 'Check Version');
  assert.equal(tabs[1].requestId, null);
  // Close extra duplicates before continuing existing assertions
  ({ tabs, activeTabId: active } = closeRequestTab(tabs, active, 'tab-r1-copy'));
  ({ tabs, activeTabId: active } = closeRequestTab(tabs, active, 'tab-r1-dup2'));
  active = 'tab-r1';

  // Opening a new blank tab creates tab #3 and focuses it
  ({ tabs, activeTabId: active } = openBlankRequestTab(tabs, active, { tabId: 'tab-blank-3' }));
  assert.equal(tabs.length, 3);
  assert.equal(active, 'tab-blank-3');

  // Importing single request appends another tab when current tab is non-pristine
  const r3 = makeBatchItem({ id: 'ext-1', name: 'Single Import', folderPath: [] });
  ({ tabs, activeTabId: active } = openImportedSingleTab(tabs, active, r3, {
    collectionName: 'Postman',
    tabId: 'tab-imp-4',
  }));
  assert.equal(tabs.length, 4);
  assert.equal(active, 'tab-imp-4');
  assert.equal(tabs[3].requestId, null);

  // Closing inactive tab preserves active tab
  ({ tabs, activeTabId: active } = closeRequestTab(tabs, active, 'tab-r2'));
  assert.equal(tabs.length, 3);
  assert.equal(active, 'tab-imp-4');

  // Unlinking deleted collection detaches requestId without losing open tab
  tabs = unlinkRemovedCollectionTabs(tabs, new Set(['req-1']));
  assert.equal(tabs[0].requestId, null);
  assert.equal(tabs[0].breadcrumb, 'Request Tunggal');

  // Closing remaining tabs eventually leaves 1 fresh blank tab
  ({ tabs, activeTabId: active } = closeRequestTab(tabs, active, 'tab-imp-4'));
  ({ tabs, activeTabId: active } = closeRequestTab(tabs, active, 'tab-blank-3'));
  ({ tabs, activeTabId: active } = closeRequestTab(tabs, active, 'tab-r1', 'tab-fallback'));
  assert.equal(tabs.length, 1);
  assert.equal(active, 'tab-fallback');
  assert.equal(tabs[0].title, 'Request Baru');
});

test('jsonFormat resolves string/object bodies and tokenizes pretty JSON lines with clean copyable values', () => {
  const fromString = resolveResponseBody('{"data":{"access_token":"jwt.abc.xyz"},"ok":true}');
  assert.equal(fromString.isJson, true);
  assert.match(fromString.prettyText, /\n  "data": \{\n/);

  const plainText = resolveResponseBody('hello world');
  assert.equal(plainText.isJson, false);
  assert.equal(plainText.rawText, 'hello world');

  const tokenLine = tokenizeJsonLine('    "access_token": "eyJ.a\\"b.c",');
  assert.equal(tokenLine.indent, '    ');
  assert.equal(tokenLine.keyToken, '"access_token"');
  assert.equal(tokenLine.valueType, 'string');
  assert.equal(tokenLine.comma, ',');
  assert.equal(tokenLine.copyValue, 'eyJ.a"b.c');

  const numLine = tokenizeJsonLine('      "id": 1337,');
  assert.equal(numLine.valueType, 'number');
  assert.equal(numLine.copyValue, '1337');

  const boolLine = tokenizeJsonLine('  "success": true,');
  assert.equal(boolLine.valueType, 'boolean');
  assert.equal(boolLine.copyValue, 'true');

  const nullLine = tokenizeJsonLine('  "message": null,');
  assert.equal(nullLine.valueType, 'null');
  assert.equal(nullLine.copyValue, 'null');

  const braceLine = tokenizeJsonLine('  "data": {');
  assert.equal(braceLine.valueType, 'punct');
  assert.equal(braceLine.copyValue, null);
});

test('postResponseScripts extracts pm.environment.set rules, merges collection+active env, and detects bare JWT header', () => {
  const events = [
    {
      listen: 'test',
      script: {
        exec: [
          'const res = pm.response.json();',
          'pm.environment.set("token", "Bearer " + res.data.access_token);',
          'pm.collectionVariables.set("user_id", res.data.user.id);',
        ],
      },
    },
  ];
  const parsed = extractPostResponseVarRulesFromPostmanEvents(events);
  assert.equal(parsed.rules.length, 2);
  assert.deepEqual(parsed.rules[0], {
    target: 'environment',
    varName: 'token',
    sourcePath: 'data.access_token',
    prefix: 'Bearer ',
  });
  assert.deepEqual(parsed.rules[1], {
    target: 'collection',
    varName: 'user_id',
    sourcePath: 'data.user.id',
  });

  const envRulesApplied = applyPostResponseVarRulesToEnv(
    sampleEnv,
    [parsed.rules[0]],
    { data: { access_token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature123' } },
    200,
  );
  assert.equal(envRulesApplied.applied.length, 1);
  const savedToken = envRulesApplied.updatedEnv.variables.find((v) => v.key === 'token');
  assert.equal(
    savedToken?.currentValue,
    'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature123',
  );
  assert.equal(savedToken?.type, 'secret');

  const collectionEnv: Environment = {
    id: 'col-vars',
    name: 'SIDIGS API (Vars)',
    variables: [
      { id: 'c1', enabled: true, key: 'url', type: 'default', initialValue: 'https://col.example.com', currentValue: 'https://col.example.com' },
      { id: 'c2', enabled: true, key: 'app_code', type: 'default', initialValue: 'student', currentValue: 'student' },
    ],
  };
  const merged = mergeCollectionAndActiveEnv(sampleEnv, collectionEnv);
  assert.equal(merged.sources.url, 'environment');
  assert.equal(merged.sources.app_code, 'collection');
  assert.equal(
    merged.effectiveEnv?.variables.find((v) => v.key === 'url')?.currentValue,
    'https://demo-cbt-api.sidigs.id',
  );
  assert.equal(
    merged.effectiveEnv?.variables.find((v) => v.key === 'app_code')?.currentValue,
    'student',
  );

  // Bare JWT stored in {{token}} without "Bearer " triggers Authorization header fix suggestion
  const bareJwtEnv = upsertTokenIntoEnvironment(
    sampleEnv,
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMzM3In0.signature12345',
    { withBearerPrefix: false },
  ).updatedEnv;
  const issue = detectBareJwtAuthorizationHeader(
    [{ id: 'h1', enabled: true, key: 'Authorization', value: '{{token}}', description: '' }],
    bareJwtEnv,
    null,
  );
  assert.ok(issue);
  assert.equal(issue?.suggestedTemplate, 'Bearer {{token}}');
  assert.equal(issue?.envVarName, 'token');

  // With Bearer prefix stored in env, no issue is reported
  const bearerEnv = upsertTokenIntoEnvironment(
    sampleEnv,
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMzM3In0.signature12345',
    { withBearerPrefix: true },
  ).updatedEnv;
  const noIssue = detectBareJwtAuthorizationHeader(
    [{ id: 'h1', enabled: true, key: 'Authorization', value: '{{token}}', description: '' }],
    bearerEnv,
    null,
  );
  assert.equal(noIssue, null);
});



