# openai-endpoint-doctor

Zero-dependency CLI that checks whether an OpenAI-compatible endpoint answers correctly, and optionally whether an Anthropic-compatible `/v1/messages` endpoint does.

Dry by default. A dry run issues exactly one request, `GET /models`, which is free on most providers. Anything that can be billed (a 1-token chat completion, a 1-token Anthropic message) runs only with `--live`.

## Why this exists

Most "the API does not work" reports come down to a few avoidable mistakes:

- the base URL includes `/v1` when the protocol expects the domain root, or the other way round
- the key is sent as `Authorization: Bearer` to an Anthropic endpoint (or as `x-api-key` to an OpenAI one)
- the endpoint returns an HTML login page or a WAF block instead of JSON
- the model name is not in that account's catalog

The doctor reports which one happened, with status code, latency and a short body snippet.

## Requirements

Node.js 18 or newer (built-in `fetch`). No dependencies.

## Usage

Free check (models list only):

```bash
node doctor.mjs --base https://api.example.com/v1 --key "$LLM_API_KEY"
```

Add the paid checks (1-token requests):

```bash
node doctor.mjs --base https://api.example.com/v1 --key "$LLM_API_KEY" \
  --anthropic-base https://api.example.com --live
```

Example output:

```
endpoint  https://api.example.com/v1
anthropic https://api.example.com

models     PASS  412 ms   166 models (gpt-6.2-sol, claude-fable-5-2, deepseek-v4.1-flash)
chat       PASS  903 ms   usage in=8 out=1
anthropic  PASS  611 ms   usage in=9 out=1
```

JSON output for scripting:

```bash
node doctor.mjs --base ... --key ... --json
```

Options:

| Flag | Meaning |
| --- | --- |
| `--base <url>` | OpenAI-compatible base URL, usually ending in `/v1` |
| `--key <key>` | API key; falls back to `OPENAI_API_KEY` or `LLM_API_KEY` |
| `--anthropic-base <url>` | Anthropic-compatible base URL, usually the domain root |
| `--anthropic-key <key>` | Anthropic key; defaults to `--key` |
| `--model <name>` | Model for live checks; defaults to the first model returned by `/models` |
| `--live` | Enable requests that may be billed |
| `--json` | Machine-readable report |
| `--timeout <ms>` | Per-request timeout, default 20000 |

Exit codes: `0` all required checks passed, `1` a required check failed, `2` invalid usage.

## Cost

`GET /models` is free on the providers I have used. `--live` sends `max_tokens: 1`, so the cost is the smallest billable request the provider allows, but it is not zero. Do not run `--live` in a loop.

## Example against a real relay

```bash
node doctor.mjs --base https://321ai.cc/v1 --key "$LLM_API_KEY" \
  --anthropic-base https://321ai.cc
```

Disclosure: the author operates 321ai.cc, which is why it appears in the example. The tool has no provider-specific logic and works with any OpenAI-compatible endpoint.

## License

MIT
