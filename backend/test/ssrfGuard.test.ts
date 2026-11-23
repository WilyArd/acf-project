import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkTarget, isBlockedAddress } from '../src/services/ssrfGuard.js';

describe('isBlockedAddress (IPv4)', () => {
  const blocked = [
    '127.0.0.1',
    '127.1.2.3',
    '0.0.0.0',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.10',
    '169.254.169.254',
    '100.64.0.1',
  ];

  for (const address of blocked) {
    it(`blocks ${address}`, () => assert.equal(isBlockedAddress(address), true));
  }

  const allowed = ['8.8.8.8', '1.1.1.1', '172.32.0.1', '193.168.0.1', '11.0.0.1'];
  for (const address of allowed) {
    it(`allows ${address}`, () => assert.equal(isBlockedAddress(address), false));
  }
});

describe('isBlockedAddress (IPv6)', () => {
  const blocked = ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1'];
  for (const address of blocked) {
    it(`blocks ${address}`, () => assert.equal(isBlockedAddress(address), true));
  }

  const allowed = ['2606:4700:4700::1111', '::ffff:8.8.8.8'];
  for (const address of allowed) {
    it(`allows ${address}`, () => assert.equal(isBlockedAddress(address), false));
  }
});

function fakeLookup(addresses: Array<{ address: string; family: number }>) {
  return async () => addresses;
}

describe('checkTarget', () => {
  it('blocks a private literal when local targets are disallowed', async () => {
    const outcome = await checkTarget(new URL('http://127.0.0.1:8080/x'), {
      allowLocalTargets: false,
      lookup: fakeLookup([{ address: '127.0.0.1', family: 4 }]),
    });
    assert.equal(outcome.kind, 'blocked');
  });

  it('blocks when ANY resolved address is private', async () => {
    const outcome = await checkTarget(new URL('https://mixed.example'), {
      allowLocalTargets: false,
      lookup: fakeLookup([
        { address: '8.8.8.8', family: 4 },
        { address: '10.1.2.3', family: 4 },
      ]),
    });
    assert.equal(outcome.kind, 'blocked');
  });

  it('allows a public address', async () => {
    const outcome = await checkTarget(new URL('https://example.com'), {
      allowLocalTargets: false,
      lookup: fakeLookup([{ address: '93.184.216.34', family: 4 }]),
    });
    assert.equal(outcome.kind, 'allowed');
  });

  it('allows private addresses when ALLOW_LOCAL_TARGETS is true', async () => {
    const outcome = await checkTarget(new URL('http://127.0.0.1:8080/x'), {
      allowLocalTargets: true,
      lookup: fakeLookup([{ address: '127.0.0.1', family: 4 }]),
    });
    assert.equal(outcome.kind, 'allowed');
  });

  it('reports a DNS failure separately from a block', async () => {
    const outcome = await checkTarget(new URL('https://nope.invalid'), {
      allowLocalTargets: false,
      lookup: async () => {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
      },
    });
    assert.equal(outcome.kind, 'dns-failed');
  });

  it('treats an empty resolution as a DNS failure', async () => {
    const outcome = await checkTarget(new URL('https://empty.example'), {
      allowLocalTargets: false,
      lookup: fakeLookup([]),
    });
    assert.equal(outcome.kind, 'dns-failed');
  });

  it('resolves real localhost via the OS resolver', async () => {
    const outcome = await checkTarget(new URL('http://localhost:1234'), { allowLocalTargets: false });
    assert.equal(outcome.kind, 'blocked');
  });

  it('aborts slow DNS lookup with timeoutMs and sanitizes failure reason', async () => {
    const outcome = await checkTarget(new URL('https://slow-dns.example'), {
      allowLocalTargets: false,
      timeoutMs: 25,
      lookup: () => new Promise(() => undefined),
    });
    assert.equal(outcome.kind, 'dns-failed');
    assert.equal(outcome.reason.includes('slow-dns.example'), false);
  });
});

describe('hardened IPv4/IPv6 special ranges & fail-closed parsing', () => {
  const mustBlock = [
    '::ffff:127.0.0.1%eth0',
    '0:0:0:0:0:ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::127.0.0.1',
    '64:ff9b::127.0.0.1',
    '64:ff9b:1::1',
    '2002:7f00:1::1',
    '2001::1',
    'fec0::1',
    'ff02::1',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
    '198.18.0.1',
    '192.0.0.1',
    '192.0.2.1',
    '127.0.0.1garbage',
    '0177.0.0.1',
    'not-an-ip',
    'fe80::gggg',
  ];

  for (const addr of mustBlock) {
    it(`blocks special/malformed address ${addr}`, () => {
      assert.equal(isBlockedAddress(addr), true);
    });
  }
});
