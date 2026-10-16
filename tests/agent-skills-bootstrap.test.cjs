// allow-test-rule: source-text-is-the-product see #1866
// Agent .md files are the installed AI agents — the self-load instruction IS the deployed
// behavior. Checking text content IS checking what runs in production. Same exemption basis
// as tests/agent-skills-awareness.test.cjs (agent_skills is a config/state contract).
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fc = require('fast-check');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

const AGENTS_DIR = path.join(__dirname, '..', 'agents');
const REFS_DIR = path.join(__dirname, '..', 'gsd-core', 'references');
const BOOTSTRAP_REF = 'agent-skills-bootstrap.md';
const BOOTSTRAP_PATH = path.join(REFS_DIR, BOOTSTRAP_REF);

// The 22 agent_skills consumer agents. This MUST stay in sync with the
// CONSUMER_AGENTS list in tests/agent-skills.test.cjs ("all 22 agent_skills
// consumer agents"). The parity test below enforces the bijection between
// this list and the set of agent files that carry the self-load bootstrap
// (Generative-Fix-Divergence guard — CLAUDE.md "Generative Fix Divergence").
const CONSUMER_AGENTS = [
  'gsd-advisor-researcher',
  'gsd-assumptions-analyzer',
  'gsd-code-fixer',
  'gsd-code-reviewer',
  'gsd-codebase-mapper',
  'gsd-debugger',
  'gsd-doc-writer',
  'gsd-eval-auditor',
  'gsd-executor',
  'gsd-integration-checker',
  'gsd-nyquist-auditor',
  'gsd-phase-researcher',
  'gsd-plan-checker',
  'gsd-planner',
  'gsd-project-researcher',
  'gsd-research-synthesizer',
  'gsd-roadmapper',
  'gsd-security-auditor',
  'gsd-ui-auditor',
  'gsd-ui-checker',
  'gsd-ui-researcher',
  'gsd-verifier',
];

function readAgent(name) {
  return fs.readFileSync(path.join(AGENTS_DIR, `${name}.md`), 'utf8');
}

function allAgentFiles() {
  // #4407: .compact.md variant siblings carry the same self-load line as their
  // canonical agent (preserved verbatim by design) but are not a distinct
  // consumer identity — exclude them from the CONSUMER_AGENTS bijection.
  return fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md') && !f.endsWith('.compact.md'));
}

describe('agent_skills self-load bootstrap', () => {
  test('bootstrap reference file exists at gsd-core/references/', () => {
    assert.ok(fs.existsSync(BOOTSTRAP_PATH), `missing bootstrap reference: ${BOOTSTRAP_PATH}`);
  });

  test('bootstrap documents the dedup guard + frontmatter-name query', () => {
    assert.ok(fs.existsSync(BOOTSTRAP_PATH), 'bootstrap missing');
    const content = fs.readFileSync(BOOTSTRAP_PATH, 'utf8');
    assert.ok(/<agent_skills>/.test(content), 'bootstrap must name the <agent_skills> block');
    // Dedup guard (C2): must instruct the agent to skip self-load when the
    // orchestrator already injected an <agent_skills> block, so the prompt
    // never carries two copies on runtimes where orchestrator injection runs.
    assert.ok(/skip/i.test(content) && /already/i.test(content),
      'bootstrap must document the dedup guard (skip when <agent_skills> already present)');
    // The bootstrap uses the agent's own frontmatter name as the query type —
    // there is no per-agent name baked into each agent file (keeps each file
    // small and the wording uniform). Assert the bootstrap says so.
    assert.ok(/frontmatter/i.test(content) && /query agent-skills/i.test(content),
      'bootstrap must instruct query agent-skills using the frontmatter name');
  });

  describe('every consumer agent carries the self-load bootstrap reference', () => {
    for (const name of CONSUMER_AGENTS) {
      test(`${name} @-includes the bootstrap reference`, () => {
        const content = readAgent(name);
        assert.ok(
          content.includes(BOOTSTRAP_REF),
          `${name} must @-include references/${BOOTSTRAP_REF} (self-load contract)`
        );
      });
    }
  });

  test('parity: set of agents referencing the bootstrap == CONSUMER_AGENTS (bijection)', () => {
    const withBootstrap = allAgentFiles()
      .filter((f) =>
        fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8').includes(BOOTSTRAP_REF))
      .map((f) => f.replace(/\.md$/, ''));

    const consumer = new Set(CONSUMER_AGENTS);
    const bootstrap = new Set(withBootstrap);
    const missing = [...consumer].filter((a) => !bootstrap.has(a));
    const extra = [...bootstrap].filter((a) => !consumer.has(a));
    assert.deepStrictEqual(
      { missing, extra },
      { missing: [], extra: [] },
      `bootstrap presence must exactly match CONSUMER_AGENTS (Generative-Fix-Divergence)\n` +
        `  missing bootstrap: ${missing.join(', ') || '(none)'}\n` +
        `  extra bootstrap: ${extra.join(', ') || '(none)'}`
    );
  });

  test('property (fast-check): for any sampled agent file, bootstrap-presence iff consumer-status', () => {
    const files = allAgentFiles();
    fc.assert(
      fc.property(fc.shuffledSubarray(files, { minLength: 1 }), (sample) => {
        for (const f of sample) {
          const stem = f.replace(/\.md$/, '');
          const content = fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8');
          const hasBootstrap = content.includes(BOOTSTRAP_REF);
          const isConsumer = CONSUMER_AGENTS.includes(stem);
          if (hasBootstrap !== isConsumer) return false;
        }
        return true;
      }),
      { numRuns: 60 }
    );
  });
});

// ── #5122: the self-load must be runnable, name the agent's own type, and not
// re-ingest the agent's persona ───────────────────────────────────────────────
// Every file that carries the bootstrap pointer — canonical agents and their
// .compact.md siblings, which are what a non-Claude runtime serves — gets the
// same three guarantees. The type is stated in the body because Claude Code
// never shows frontmatter to a subagent, the Kimi converter drops it, and Codex
// keeps it in a TOML key; the launcher comes from the canonical preamble that
// scripts/sync-runtime-launcher.cjs inserts into the first bash block that
// calls gsd_run.
function selfLoadFiles() {
  return fs.readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith('.md'))
    .filter((f) => fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8').includes(BOOTSTRAP_REF));
}

function agentTypeOf(file) {
  return file.replace(/\.compact\.md$/, '').replace(/\.md$/, '');
}

function bashBlocks(content) {
  const blocks = [];
  let current = null;
  for (const line of splitLines(content)) {
    const t = line.trim();
    if (current === null) {
      if (/^`{3}(?:bash|sh|shell)\s*$/.test(t)) current = [];
    } else if (/^`{3}\s*$/.test(t)) {
      blocks.push(current.join('\n'));
      current = null;
    } else {
      current.push(line);
    }
  }
  return blocks;
}

describe('#5122 self-load is runnable and names the agent type', () => {
  const files = selfLoadFiles();

  test('the sweep covers canonical agents and compact siblings', () => {
    assert.ok(files.length >= CONSUMER_AGENTS.length * 2 - 8, `only ${files.length} files found`);
    for (const name of CONSUMER_AGENTS) {
      assert.ok(files.includes(`${name}.md`), `${name}.md missing from the sweep`);
    }
  });

  for (const file of files) {
    const type = agentTypeOf(file);
    const selfLoad = `gsd_run query agent-skills ${type} --skills-only`;

    describe(file, () => {
      const content = fs.readFileSync(path.join(AGENTS_DIR, file), 'utf8');
      const blocks = bashBlocks(content);

      test('queries its own type with --skills-only in a bash block', () => {
        const idx = blocks.findIndex((b) => b.includes(selfLoad));
        assert.notStrictEqual(idx, -1, `${file} must carry a bash block running: ${selfLoad}`);
      });

      test('the queried type is the agent\'s own name', () => {
        const queried = [...content.matchAll(/gsd_run query agent-skills ([A-Za-z0-9-]{1,64})/g)].map((m) => m[1]);
        assert.deepStrictEqual([...new Set(queried)], [type], `${file} may only query its own type`);
        const fm = /^name:\s*"?([A-Za-z0-9-]{1,64})"?\s*$/m.exec(content);
        if (fm) assert.strictEqual(fm[1], type, 'frontmatter name must match the queried type');
      });

      test('the launcher is defined in or before the self-load block', () => {
        const selfIdx = blocks.findIndex((b) => b.includes(selfLoad));
        const resolverAt = content.indexOf('references/gsd-run-resolver.md');
        if (resolverAt !== -1) {
          // These agents define gsd_run through the shared resolver reference
          // (scripts/sync-runtime-launcher.cjs never inlines a second copy), so
          // the self-load has to sit after that include.
          assert.ok(resolverAt < content.indexOf(selfLoad), 'self-load must follow the gsd-run-resolver include');
          return;
        }
        const firstGsdRun = blocks.findIndex((b) => b.includes('gsd_run'));
        assert.ok(firstGsdRun !== -1 && firstGsdRun <= selfIdx, 'self-load must not precede the first gsd_run block');
        assert.ok(
          blocks[firstGsdRun].includes('gsd_run() {') && blocks[firstGsdRun].includes('_gsd_at()'),
          'the first gsd_run block must carry the canonical launcher preamble',
        );
      });

      test('the query does not swallow the launcher or query failure', () => {
        const line = splitLines(blocks.find((b) => b.includes(selfLoad)) || '').find((l) => l.includes(selfLoad)) || '';
        assert.ok(!line.includes('2>/dev/null'), 'stderr must stay visible so a failure is not read as "nothing configured"');
        assert.ok(!line.includes('|| true'), 'a failure must not be turned into an empty result');
      });
    });
  }
});

describe('#5122 bootstrap states what each runtime returns', () => {
  const doc = fs.readFileSync(BOOTSTRAP_PATH, 'utf8');

  test('documents --skills-only and the per-runtime return contract', () => {
    assert.ok(doc.includes('--skills-only'), 'bootstrap must tell the agent to pass --skills-only');
    assert.ok(/non-Claude/.test(doc) && /persona/i.test(doc),
      'bootstrap must state that a non-Claude runtime returns the agent persona without --skills-only');
  });

  test('no longer claims premises that do not hold on every runtime', () => {
    assert.ok(!/your own init already defines/i.test(doc), 'gsd_run is supplied by the self-load block, not by the agent init');
    assert.ok(!/exits 0 with an empty\s+block when nothing is configured for your type/i.test(doc),
      'the empty-block claim must be scoped to --skills-only');
    assert.ok(!/the `name:` value in\s+your frontmatter/i.test(doc),
      'the agent type must come from the agent body, not frontmatter the runtime may hide');
  });

  test('tells the agent its type is stated in its own file', () => {
    assert.ok(/agent type/i.test(doc) && /(Claude Code|Kimi|Codex)/.test(doc),
      'bootstrap must explain why frontmatter is not the source of the type');
  });
});
