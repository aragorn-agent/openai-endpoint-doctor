#!/usr/bin/env node
/**
 * openai-endpoint-doctor
 *
 * Zero-dependency health check for OpenAI-compatible endpoints, with an optional
 * Anthropic Messages check. Dry by default: it only issues GET /models.
 * Any request that can be billed requires --live.
 *
 * Node 18+ (built-in fetch). No npm dependencies.
 */
import process from 'node:process';

const HELP = `
openai-endpoint-doctor

Usage:
  node doctor.mjs --base https://api.example.com/v1 --key $API_KEY [options]

Options:
  --base <url>            OpenAI-compatible base URL (usually ends in /v1)
  --key <key>             API key (or set OPENAI_API_KEY / LLM_API_KEY)
  --anthropic-base <url>  Anthropic-compatible base URL (usually the domain root)
  --anthropic-key <key>   Anthropic key (defaults to --key)
  --model <name>          Model used for live checks (default: first from /models)
  --live                  Enable checks that may be billed (chat, messages)
  --json                  Print a JSON report instead of a table
  --timeout <ms>          Per-request timeout (default 20000)
  -h, --help

Exit codes:
  0  required checks passed
  1  a required check failed
  2  invalid usage
`;

function parseArgs(argv) {
  const out = { live: false, json: false, timeout: 20000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    if (a === '--live') out.live = true;
    else if (a === '--json') out.json = true;
    else if (a === '--base') out.base = take();
    else if (a === '--key') out.key = take();
    else if (a === '--anthropic-base') out.anthropicBase = take();
    else if (a === '--anthropic-key') out.anthropicKey = take();
    else if (a === '--model') out.model = take();
    else if (a === '--timeout') out.timeout = Number(take());
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

const trimSlash = (u) => String(u || '').replace(/\/+$/, '');

async function request(url, opts, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    const text = await res.text();
    const ms = Date.now() - started;
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, ok: res.ok, ms, json, text };
  } finally {
    clearTimeout(timer);
  }
}

function snippet(text) {
  return String(text || '').replace(/\s+/g, ' ').slice(0, 160);
}

async function checkModels(base, key, timeout) {
  const url = `${base}/models`;
  const r = await request(url, { headers: { Authorization: `Bearer ${key}` } }, timeout);
  if (!r.ok) {
    return { name: 'models', ok: false, ms: r.ms, detail: `HTTP ${r.status}: ${snippet(r.text)}` };
  }
  if (!r.json || !Array.isArray(r.json.data)) {
    return { name: 'models', ok: false, ms: r.ms, detail: 'HTTP 200 but no data[] array' };
  }
  const ids = r.json.data.map((m) => m && m.id).filter(Boolean);
  return {
    name: 'models',
    ok: true,
    ms: r.ms,
    count: ids.length,
    sample: ids.slice(0, 5),
    model: ids[0],
  };
}

async function checkChat(base, key, model, timeout) {
  const r = await request(
    `${base}/chat/completions`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
    },
    timeout
  );
  if (!r.ok) {
    return { name: 'chat', ok: false, ms: r.ms, detail: `HTTP ${r.status}: ${snippet(r.text)}` };
  }
  const choice = r.json && Array.isArray(r.json.choices) ? r.json.choices[0] : null;
  if (!choice) {
    return { name: 'chat', ok: false, ms: r.ms, detail: 'HTTP 200 but no choices[]' };
  }
  const usage = r.json.usage || {};
  return {
    name: 'chat',
    ok: true,
    ms: r.ms,
    detail: `usage in=${usage.prompt_tokens ?? '?'} out=${usage.completion_tokens ?? '?'}`,
  };
}

async function checkAnthropic(base, key, model, timeout) {
  const r = await request(
    `${base}/v1/messages`,
    {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    },
    timeout
  );
  if (!r.ok) {
    return { name: 'anthropic', ok: false, ms: r.ms, detail: `HTTP ${r.status}: ${snippet(r.text)}` };
  }
  const okShape = r.json && (Array.isArray(r.json.content) || r.json.type === 'message');
  return {
    name: 'anthropic',
    ok: Boolean(okShape),
    ms: r.ms,
    detail: okShape ? `usage in=${(r.json.usage || {}).input_tokens ?? '?'} out=${(r.json.usage || {}).output_tokens ?? '?'}` : 'HTTP 200 but no message shape',
  };
}

function printReport(rows, opts) {
  const width = Math.max(...rows.map((r) => r.name.length), 7);
  console.log(`endpoint  ${opts.base}`);
  if (opts.anthropicBase) console.log(`anthropic ${opts.anthropicBase}`);
  console.log('');
  for (const r of rows) {
    const status = r.ok === null ? 'SKIP' : r.ok ? 'PASS' : 'FAIL';
    const ms = r.ms == null ? '' : `${r.ms} ms`;
    let detail = r.detail || '';
    if (r.count != null) detail = `${r.count} models${r.sample && r.sample.length ? ` (${r.sample.join(', ')})` : ''}`;
    console.log(`${r.name.padEnd(width)}  ${status}  ${ms.padEnd(8)} ${detail}`.trimEnd());
  }
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(String(e.message || e));
    console.error(HELP);
    process.exit(2);
  }
  if (opts.help) {
    console.log(HELP);
    return;
  }
  opts.base = trimSlash(opts.base);
  opts.anthropicBase = opts.anthropicBase ? trimSlash(opts.anthropicBase) : '';
  opts.key = opts.key || process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || '';
  opts.anthropicKey = opts.anthropicKey || opts.key;

  if (!opts.base || !opts.key) {
    console.error('error: --base and --key are required (key may come from OPENAI_API_KEY or LLM_API_KEY)');
    console.error(HELP);
    process.exit(2);
  }

  const rows = [];
  let model = opts.model;

  try {
    const models = await checkModels(opts.base, opts.key, opts.timeout);
    rows.push(models);
    if (!model && models.model) model = models.model;
  } catch (e) {
    rows.push({ name: 'models', ok: false, detail: String(e.message || e) });
  }

  if (!opts.live) {
    rows.push({ name: 'chat', ok: null, detail: 'dry run (add --live)' });
    if (opts.anthropicBase) rows.push({ name: 'anthropic', ok: null, detail: 'dry run (add --live)' });
  } else {
    if (!model) {
      rows.push({ name: 'chat', ok: false, detail: 'no model available; pass --model' });
    } else {
      try {
        rows.push(await checkChat(opts.base, opts.key, model, opts.timeout));
      } catch (e) {
        rows.push({ name: 'chat', ok: false, detail: String(e.message || e) });
      }
    }
    if (opts.anthropicBase) {
      if (!model) {
        rows.push({ name: 'anthropic', ok: false, detail: 'no model available; pass --model' });
      } else {
        try {
          rows.push(await checkAnthropic(opts.anthropicBase, opts.anthropicKey, model, opts.timeout));
        } catch (e) {
          rows.push({ name: 'anthropic', ok: false, detail: String(e.message || e) });
        }
      }
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({ base: opts.base, anthropicBase: opts.anthropicBase || null, live: opts.live, checks: rows }, null, 2));
  } else {
    printReport(rows, opts);
    if (opts.live) console.log('\nnote: --live checks send 1-token requests and may be billed by the provider.');
  }

  const failed = rows.some((r) => r.ok === false);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
