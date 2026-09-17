/**
 * Tests for scripts/astra-review.js (CLI)
 *
 * Run with: node tests/scripts/astra-review.test.js
 */

'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const cli = require('../../scripts/astra-review');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'astra-review.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
    failed++;
  }
}

function sink() {
  const chunks = [];
  return { write: (text) => chunks.push(String(text)), text: () => chunks.join('') };
}

const passingReview = { verdict: 'PASS', summary: 'fine', checks: [], findings: [] };
const failingReview = {
  verdict: 'FAIL', summary: 'bad', checks: [],
  findings: [{ severity: 'HIGH', file: 'a.js', line: 1, title: 'Bug', detail: '', suggestion: '' }],
};

function baseDeps(overrides = {}) {
  return {
    cwd: '/repo',
    collectChanges: () => ({ files: ['a.js'], diff: '+x', truncated: true, root: '/repo-root', recovery: 'git show sha:<path>' }),
    runCodexReview: () => passingReview,
    stdout: sink(),
    stderr: sink(),
    writeFile: () => {},
    ...overrides,
  };
}

console.log('=== Testing scripts/astra-review.js ===\n');

test('parseArgs defaults to uncommitted scope and gpt-6-astra', () => {
  const options = cli.parseArgs([], {});

  assert.strictEqual(options.scope.kind, 'uncommitted');
  assert.strictEqual(options.model, 'gpt-6-astra');
  assert.strictEqual(options.consent, false);
});

test('parseArgs honors ECC_ASTRA_MODEL and ECC_ASTRA_CONSENT', () => {
  const options = cli.parseArgs([], { ECC_ASTRA_MODEL: 'gpt-5.5', ECC_ASTRA_CONSENT: '1' });

  assert.strictEqual(options.model, 'gpt-5.5');
  assert.strictEqual(options.consent, true);
});

test('parseArgs collects multiple --files paths', () => {
  const options = cli.parseArgs(['--files', 'a.js', 'b.js', '--json'], {});

  assert.deepStrictEqual(options.scope, { kind: 'files', value: ['a.js', 'b.js'] });
  assert.strictEqual(options.json, true);
});

test('parseArgs accepts --files-from-commit for repair rounds', () => {
  const options = cli.parseArgs(['--files-from-commit', 'HEAD~1'], {});

  assert.deepStrictEqual(options.scope, { kind: 'files-from-commit', value: 'HEAD~1' });
});

test('parseArgs rejects unknown flags and bad timeouts', () => {
  assert.throws(() => cli.parseArgs(['--bogus'], {}), /unknown argument/);
  assert.throws(() => cli.parseArgs(['--timeout-seconds', '5'], {}), /timeout-seconds/);
  assert.throws(() => cli.parseArgs(['--model', 'bad slug!'], {}), /invalid model/);
});

test('runCli prints "Nothing to review" and passes when there are no changes', () => {
  const deps = baseDeps({ collectChanges: () => ({ files: [], diff: '', truncated: false }) });

  const code = cli.runCli(cli.parseArgs(['--consent-to-openai'], {}), deps);

  assert.strictEqual(code, cli.EXIT_PASS);
  assert.ok(deps.stdout.text().includes('Nothing to review'));
});

test('runCli --dry-run prints the prompt and never calls Codex', () => {
  let called = false;
  const deps = baseDeps({ runCodexReview: () => { called = true; return passingReview; } });

  const code = cli.runCli(cli.parseArgs(['--dry-run'], {}), deps);

  assert.strictEqual(code, cli.EXIT_PASS);
  assert.strictEqual(called, false);
  assert.ok(deps.stdout.text().includes('--- BEGIN DIFF ---'));
});

test('runCli refuses to call Codex without consent', () => {
  let called = false;
  const deps = baseDeps({ runCodexReview: () => { called = true; return passingReview; } });

  const code = cli.runCli(cli.parseArgs([], {}), deps);

  assert.strictEqual(code, cli.EXIT_ERROR);
  assert.strictEqual(called, false);
  assert.ok(deps.stderr.text().includes('consent'));
});

test('runCli returns 0 and a markdown report on PASS', () => {
  const deps = baseDeps();

  const code = cli.runCli(cli.parseArgs(['--consent-to-openai'], {}), deps);

  assert.strictEqual(code, cli.EXIT_PASS);
  assert.ok(deps.stdout.text().includes('# Astra Review (gpt-6-astra)'));
  assert.ok(deps.stdout.text().includes('**PASS**'));
});

test('runCli returns 1 on FAIL and writes JSON to --output', () => {
  let written = null;
  const deps = baseDeps({
    runCodexReview: () => failingReview,
    writeFile: (file, content) => { written = { file, content }; },
  });

  const code = cli.runCli(cli.parseArgs(['--consent-to-openai', '--output', '/tmp/r.json', '--json'], {}), deps);

  assert.strictEqual(code, cli.EXIT_FAIL);
  assert.strictEqual(written.file, '/tmp/r.json');
  assert.strictEqual(JSON.parse(written.content).verdict, 'FAIL');
  assert.strictEqual(JSON.parse(deps.stdout.text()).review.findings.length, 1);
});

test('runCli passes model, prompt, and timeout through to the reviewer', () => {
  let seen = null;
  const deps = baseDeps({ runCodexReview: (input) => { seen = input; return passingReview; } });

  cli.runCli(cli.parseArgs(['--consent-to-openai', '--model', 'gpt-5.5', '--timeout-seconds', '60'], {}), deps);

  assert.strictEqual(seen.model, 'gpt-5.5');
  assert.strictEqual(seen.timeoutMs, 60_000);
  assert.strictEqual(seen.cwd, '/repo-root');
  assert.ok(seen.prompt.includes('+x'));
  assert.ok(seen.prompt.includes('git show sha:<path>'));
});

test('writeReport refuses to write through an existing symlink', () => {
  const io = {
    lstatSync: () => ({ isSymbolicLink: () => true, isFile: () => false }),
    writeFileSync: () => { throw new Error('must not write'); },
  };

  assert.throws(() => cli.writeReport('/tmp/x.json', '{}', io), /symlink/);
});

test('writeReport creates a user-only file when the path is new', () => {
  let written = null;
  const io = {
    lstatSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    writeFileSync: (file, content, options) => { written = { file, content, options }; },
  };

  cli.writeReport('/tmp/new.json', '{}', io);

  assert.strictEqual(written.file, '/tmp/new.json');
  assert.strictEqual(written.options.mode, 0o600);
});

test('CLI exits 2 with usage on a bad argument', () => {
  const result = spawnSync('node', [SCRIPT, '--nope'], { encoding: 'utf8' });

  assert.strictEqual(result.status, 2);
  assert.ok(result.stderr.includes('unknown argument'));
  assert.ok(result.stderr.includes('Usage'));
});

test('CLI --help exits 0 and prints usage', () => {
  const result = spawnSync('node', [SCRIPT, '--help'], { encoding: 'utf8' });

  assert.strictEqual(result.status, 0);
  assert.ok(result.stdout.includes('--consent-to-openai'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
