// The command line: help, version, defaults, and one-line errors instead of stack traces.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = path.resolve('otel-png-cli.mjs');
const SAMPLE = path.resolve('sample-trace.json');
const run = (args, cwd = process.cwd()) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'otel-png-cli-'));

test('--help and -h print usage to stdout and exit 0', () => {
  for (const flag of ['--help', '-h']) {
    const r = run([flag]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^usage: otel-png trace\.json \[out\.png\]/);
    assert.match(r.stdout, /default trace\.png/);
    assert.doesNotMatch(r.stdout, /node otel-png-cli/);
  }
});

test('--version prints the package version', () => {
  const r = run(['--version']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), JSON.parse(fs.readFileSync('package.json', 'utf8')).version);
});

test('output defaults to trace.png; several pages are numbered trace-01.png, ...', () => {
  const dir = tmp();
  try {
    let r = run([SAMPLE, '--tall'], dir);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fs.readdirSync(dir), ['trace.png']);
    fs.rmSync(path.join(dir, 'trace.png'));
    r = run([SAMPLE, '--max-height', '300'], dir);
    assert.equal(r.status, 0, r.stderr);
    const files = fs.readdirSync(dir).sort();
    assert.ok(files.length > 1);
    assert.equal(files[0], 'trace-01.png');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bad arguments and inputs fail with one clean line, never a stack trace', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'bad.json'), '{"resourceSpans": [');
    fs.writeFileSync(path.join(dir, 'empty.json'), '{}');
    const cases = [
      [[], 2, /missing input/],
      [['--bogus', SAMPLE], 2, /Unknown option '--bogus'/],
      [[SAMPLE, 'a.png', 'extra'], 2, /unexpected argument "extra"/],
      [[SAMPLE, '--width', 'abc'], 2, /--width expects a number, got "abc"/],
      [[SAMPLE, '--width'], 2, /--width/],
      [[SAMPLE, '--scale', '3'], 1, /scale must be 1 or 2, got 3/],
      [[SAMPLE, '--compress', 'gzip'], 1, /compress must be one of 'stream', 'js', got "gzip"/],
      [[path.join(dir, 'missing.json')], 1, /ENOENT/],
      [[path.join(dir, 'bad.json')], 1, /not valid JSON/],
      [[path.join(dir, 'empty.json')], 1, /no valid spans/],
    ];
    for (const [args, status, re] of cases) {
      const r = run(args, dir);
      assert.equal(r.status, status, `${args.join(' ')}: ${r.stderr}`);
      assert.match(r.stderr, re);
      assert.match(r.stderr, /^otel-png: /);
      assert.doesNotMatch(r.stderr, /\n\s+at /, 'no stack trace');
    }
    assert.deepEqual(fs.readdirSync(dir).sort(), ['bad.json', 'empty.json'], 'no output written on failure');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
