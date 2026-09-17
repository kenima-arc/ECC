#!/usr/bin/env node
/**
 * Send code written in Claude Code to GPT-6-Astra (via Codex CLI) for an
 * independent review and print a structured verdict.
 *
 * Usage:
 *   node scripts/astra-review.js --consent-to-openai [scope] [options]
 *
 * Scope (pick one, default: uncommitted changes):
 *   --base <branch>          changes on HEAD relative to <branch>
 *   --commit <sha>           changes introduced by one commit
 *   --files <f1> [f2 ...]    full contents of explicit files
 *   --files-from-commit <sha> current contents of the files <sha> touched (repair rounds)
 *
 * Options:
 *   --model <slug>           default: gpt-6-astra (or ECC_ASTRA_MODEL)
 *   --timeout-seconds <n>    30-900, default 300
 *   --instructions <text>    extra reviewer instructions
 *   --output <file>          also write the JSON verdict to <file>
 *   --json                   print JSON instead of the markdown report
 *   --dry-run                print the prompt and exit without calling Codex
 *   --consent-to-openai      required (or ECC_ASTRA_CONSENT=1); code leaves the machine
 *
 * Exit codes: 0 PASS or nothing to review, 1 FAIL, 2 usage/runtime error.
 */

'use strict';

const fs = require('fs');
const { collectChanges, describeScope, parseScope } = require('./lib/astra-review/scope');
const { buildPrompt, effectiveVerdict, formatReport } = require('./lib/astra-review/prompt');
const codex = require('./lib/astra-review/codex');

const EXIT_PASS = 0;
const REPORT_FILE_MODE = 0o600;
const EXIT_FAIL = 1;
const EXIT_ERROR = 2;

/**
 * Write the JSON report without following a pre-existing symlink (a
 * predictable path could otherwise be pointed at another file) and readable
 * only by the current user.
 */
function writeReport(file, content, io = fs) {
  let existing = null;
  try {
    existing = io.lstatSync(file);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  if (existing && existing.isSymbolicLink()) throw new Error(`refusing to write report through symlink: ${file}`);
  if (existing && !existing.isFile()) throw new Error(`report path is not a regular file: ${file}`);
  io.writeFileSync(file, content, { encoding: 'utf8', mode: REPORT_FILE_MODE });
}

function usage() {
  return fs.readFileSync(__filename, 'utf8').split('\n')
    .slice(2, 23)
    .map((line) => line.replace(/^ \* ?/, ''))
    .join('\n');
}

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

/**
 * @param {string[]} argv
 * @param {object} [env]
 * @returns {object} Parsed, validated options
 */
function parseArgs(argv, env = process.env) {
  let options = {
    base: null, commit: null, files: [], filesFromCommit: null,
    model: env.ECC_ASTRA_MODEL || codex.DEFAULT_MODEL,
    timeoutMs: codex.DEFAULT_TIMEOUT_MS,
    instructions: '',
    output: null,
    json: false,
    dryRun: false,
    consent: env.ECC_ASTRA_CONSENT === '1',
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base') { options = { ...options, base: takeValue(argv, index, arg) }; index += 1; }
    else if (arg === '--commit') { options = { ...options, commit: takeValue(argv, index, arg) }; index += 1; }
    else if (arg === '--files-from-commit') { options = { ...options, filesFromCommit: takeValue(argv, index, arg) }; index += 1; }
    else if (arg === '--files') {
      const files = [];
      while (argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) {
        files.push(argv[index + 1]);
        index += 1;
      }
      if (files.length === 0) throw new Error('--files requires at least one path');
      options = { ...options, files };
    }
    else if (arg === '--model') { options = { ...options, model: takeValue(argv, index, arg) }; index += 1; }
    else if (arg === '--timeout-seconds') {
      const seconds = Number(takeValue(argv, index, arg));
      const min = codex.MIN_TIMEOUT_MS / 1000;
      const max = codex.MAX_TIMEOUT_MS / 1000;
      if (!Number.isInteger(seconds) || seconds < min || seconds > max) {
        throw new Error(`--timeout-seconds must be an integer from ${min} to ${max}`);
      }
      options = { ...options, timeoutMs: seconds * 1000 };
      index += 1;
    }
    else if (arg === '--instructions') { options = { ...options, instructions: takeValue(argv, index, arg) }; index += 1; }
    else if (arg === '--output') { options = { ...options, output: takeValue(argv, index, arg) }; index += 1; }
    else if (arg === '--json') options = { ...options, json: true };
    else if (arg === '--dry-run') options = { ...options, dryRun: true };
    else if (arg === '--consent-to-openai') options = { ...options, consent: true };
    else if (arg === '--help' || arg === '-h') options = { ...options, help: true };
    else throw new Error(`unknown argument: ${arg}`);
  }

  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(options.model)) throw new Error(`invalid model slug: ${options.model}`);
  return { ...options, scope: parseScope(options) };
}

/**
 * @param {object} options - From parseArgs
 * @param {{cwd?: string, collectChanges?: Function, runCodexReview?: Function, stdout?: object, stderr?: object, writeFile?: Function}} [deps]
 * @returns {number} Exit code
 */
function runCli(options, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const cwd = deps.cwd || process.cwd();
  const collect = deps.collectChanges || collectChanges;
  const review = deps.runCodexReview || codex.runCodexReview;
  const writeFile = deps.writeFile || writeReport;

  if (options.help) {
    stdout.write(`${usage()}\n`);
    return EXIT_PASS;
  }

  const changes = collect(options.scope, { cwd });
  const scopeLabel = describeScope(options.scope);
  if (changes.files.length === 0 && !changes.diff) {
    stdout.write(`Nothing to review (${scopeLabel}).\n`);
    return EXIT_PASS;
  }

  const prompt = buildPrompt({
    files: changes.files,
    diff: changes.diff,
    truncated: changes.truncated,
    recovery: changes.recovery,
    scopeLabel,
    extraInstructions: options.instructions,
  });

  if (options.dryRun) {
    stdout.write(`${prompt}\n`);
    return EXIT_PASS;
  }
  if (!options.consent) {
    stderr.write('Refusing to send code to OpenAI without --consent-to-openai (or ECC_ASTRA_CONSENT=1).\n');
    return EXIT_ERROR;
  }

  stderr.write(`[astra-review] sending ${changes.files.length} file(s) (${scopeLabel}) to ${options.model}...\n`);
  const repoRoot = changes.root || cwd;
  const result = review({ prompt, cwd: repoRoot, model: options.model, timeoutMs: options.timeoutMs });
  const verdict = effectiveVerdict(result);
  const payload = { model: options.model, scope: scopeLabel, files: changes.files, verdict, review: result };

  if (options.output) writeFile(options.output, `${JSON.stringify(payload, null, 2)}\n`);
  stdout.write(options.json
    ? `${JSON.stringify(payload, null, 2)}\n`
    : formatReport(result, { model: options.model, scopeLabel, files: changes.files }));

  return verdict === 'PASS' ? EXIT_PASS : EXIT_FAIL;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    return EXIT_ERROR;
  }
  try {
    return runCli(options);
  } catch (error) {
    process.stderr.write(`[astra-review] ${error.message}\n`);
    return EXIT_ERROR;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { EXIT_ERROR, EXIT_FAIL, EXIT_PASS, parseArgs, runCli, writeReport };
