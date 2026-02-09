import { describe, it, before, beforeEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';

// Mock fetch globally before importing the module
const originalFetch = globalThis.fetch;
let fetchMock;

// Import module (won't execute CLI due to _isMain check)
const mod = await import('./openclaw-monitor.mjs');
const {
  _initForTest, loadConfig,
  shouldNotify, statusIcon, formatSummary,
  checkGateway, checkPm2Process, checkBridge, checkCloudflared,
  state, sleep
} = mod;

// === Pure function tests ===

describe('statusIcon', () => {
  it('returns checkmark for ok', () => {
    assert.equal(statusIcon('ok'), '\u2713');
  });
  it('returns X for fail', () => {
    assert.equal(statusIcon('fail'), '\u2717');
  });
  it('returns dash for disabled', () => {
    assert.equal(statusIcon('disabled'), '-');
  });
  it('returns ? for unknown', () => {
    assert.equal(statusIcon('unknown'), '?');
  });
});

describe('formatSummary', () => {
  it('shows ALL OK when all services ok', () => {
    const r = { gateway: 'ok', kakaotalk: 'ok', bridge: 'ok', cloudflared: 'ok' };
    const result = formatSummary(r);
    assert.match(result, /ALL OK/);
    assert.match(result, /GW:\u2713/);
  });

  it('shows ALERT when any service fails', () => {
    const r = { gateway: 'fail', kakaotalk: 'ok', bridge: 'ok', cloudflared: 'ok' };
    const result = formatSummary(r);
    assert.match(result, /ALERT/);
    assert.match(result, /GW:\u2717/);
  });

  it('treats disabled as ok for summary', () => {
    const r = { gateway: 'ok', kakaotalk: 'disabled', bridge: 'ok', cloudflared: 'disabled' };
    const result = formatSummary(r);
    assert.match(result, /ALL OK/);
  });
});

describe('shouldNotify', () => {
  const testConfig = {
    notification: { cooldown: 300 },
    services: {},
    autoRepair: false
  };

  beforeEach(() => {
    _initForTest(testConfig);
  });

  it('returns true when never notified', () => {
    assert.equal(shouldNotify('gateway'), true);
  });

  it('returns false within cooldown period', () => {
    state.gateway.lastNotify = Date.now();
    assert.equal(shouldNotify('gateway'), false);
  });

  it('returns true after cooldown expires', () => {
    state.gateway.lastNotify = Date.now() - 301_000;
    assert.equal(shouldNotify('gateway'), true);
  });

  it('uses default 300s cooldown when not configured', () => {
    _initForTest({ notification: {}, services: {}, autoRepair: false });
    state.gateway.lastNotify = Date.now() - 299_000;
    assert.equal(shouldNotify('gateway'), false);
  });
});

describe('loadConfig', () => {
  it('loads config from given directory', () => {
    const config = loadConfig(new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
    assert.ok(config);
    assert.ok('services' in config || 'interval' in config);
  });
});

// === Health check tests (with mocked fetch) ===

describe('checkGateway', () => {
  const testConfig = {
    services: {
      gateway: { enabled: true, port: 25382, probeUrl: 'http://localhost:99999/' }
    },
    notification: { cooldown: 300 },
    autoRepair: false
  };

  beforeEach(() => {
    _initForTest(testConfig);
  });

  it('returns ok when HTTP probe succeeds', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200 });
    try {
      const result = await checkGateway();
      assert.equal(result, 'ok');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('returns ok for non-500 status', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 401 });
    try {
      const result = await checkGateway();
      assert.equal(result, 'ok');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('returns fail for 500+ status', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 502 });
    try {
      const result = await checkGateway();
      assert.equal(result, 'fail');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('returns fail on network error', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
    try {
      const result = await checkGateway();
      assert.equal(result, 'fail');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('returns disabled when service not enabled', async () => {
    _initForTest({
      services: { gateway: { enabled: false } },
      notification: { cooldown: 300 },
      autoRepair: false
    });
    const result = await checkGateway();
    assert.equal(result, 'disabled');
  });
});

describe('sleep', () => {
  it('resolves after specified ms', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 40, `Expected >= 40ms, got ${elapsed}ms`);
  });
});
