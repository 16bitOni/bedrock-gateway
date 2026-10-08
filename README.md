# Bedrock Portal

A personal AI gateway for Amazon Bedrock. Set up AWS permissions once. After that, every Bedrock model (Claude, Nova, Llama, gpt-oss, DeepSeek, Mistral, Qwen, Cohere and others), plus Polly voices and Transcribe, works behind one **OpenAI-compatible** and **Anthropic-compatible** URL with your own API keys. A dashboard covers spend, credits, logs and a playground.

```
your code / LangChain / Vercel AI SDK / Claude Code
        │  OPENAI_BASE_URL=http://127.0.0.1:8787/v1   (or ANTHROPIC_BASE_URL=http://127.0.0.1:8787)
        ▼
  Bedrock Portal  ── keys · budgets · aliases/fallbacks · cache · logs · cost per request
        │  assumes your IAM role (auto-refreshing credentials)
        ▼
  Amazon Bedrock (Converse / InvokeModel) · Polly · Transcribe · Cost Explorer · Billing
```

## What you get

| Area | Features |
|---|---|
| **APIs** | `/v1/chat/completions` (streaming, tools, vision, PDFs/docs, audio input, `response_format` JSON/JSON-schema, `reasoning_effort`) · `/v1/embeddings` (Titan v2, Cohere v3/v4, Nova multimodal; float **and** base64) · `/v1/images/generations` (Nova Canvas, Titan Image, Stability) · `/v1/audio/speech` (Polly, OpenAI voice names mapped) · `/v1/audio/transcriptions` (Voxtral via Converse, or Amazon Transcribe with srt/vtt) · `/v1/rerank` (Cohere Rerank 3.5, Amazon Rerank) · `/v1/models` · **Anthropic `/v1/messages`** + `/v1/messages/count_tokens` (Claude Code / Anthropic SDK) |
| **Keys** | One key per project. Each key can have a model allow-list, monthly $ budget, requests-per-minute limit, expiry, a Bedrock Guardrail, a response cache and a "don't store bodies" option. Keys can be rotated or disabled. Only a SHA-256 hash is stored. |
| **Models** | One-click sync from Bedrock: foundation models plus cross-region inference profiles (`global.` / `us.` / …) and application inference profiles. The best route for each model is enabled automatically. You can enable or disable models, add custom IDs, and check access. |
| **Aliases** | `smart`, `balanced`, `fast`, `cheap`, `coder`, `vision`, `embed`, `image`, `rerank`, `transcribe`, … are created automatically and point at the newest models. Each alias is an **ordered fallback chain**: throttling, outages or context-overflow errors move the request to the next model. OpenAI names such as `gpt-4o`, `gpt-4o-mini`, `text-embedding-3-small`, `dall-e-3` and `whisper-1` are mapped too, so tools that hard-code them still work. |
| **Presets** | A saved model, system prompt and parameters, called as `model: "preset/<name>"`. |
| **Cost** | Exact cost per request: input, output, cache-read and cache-write tokens, images, characters and queries. It's returned as `usage.cost` and the `x-portal-cost-usd` header. Prices are editable, past costs can be re-priced, and global-vs-regional profile pricing is handled. |
| **Budgets** | Per-key and global monthly hard caps (HTTP 429 `insufficient_quota` with `x-should-retry: false`), a budget alert threshold, and a month-end forecast. |
| **AWS billing** | Actual Bedrock spend from Cost Explorer (daily, by service and usage type), **AWS credits remaining** (`billing:GetCredits`), and credits applied this month, shown next to the gateway's own estimate. |
| **Logs** | Every request is logged with key, alias → resolved model, fallback attempt, status, TTFT, latency, tokens and cost. Bodies are stored too: large base64 payloads are trimmed, and storage can be turned off per key. You can filter, search, view a chat transcript, **replay in the playground**, and export to JSONL. |
| **Playground** | Chat with streaming, a thinking panel and tool calls; **side-by-side compare** of 2–4 models; image, speech, transcription (upload or record), embeddings (with a similarity matrix) and rerank. "Copy as code" turns the current request into a snippet. |
| **Quality of life** | Automatic Bedrock prompt caching for long system prompts, tool lists and conversations. Claude thinking signatures are kept across tool-call turns. Exact-match response cache. Retries with backoff. Quickstart snippets for curl, OpenAI (Python/Node), LangChain, LlamaIndex, Vercel AI SDK, CrewAI, the Anthropic SDK and Claude Code. |

## 1. Run it

### Option A: desktop app (just double-click)

Download `Bedrock-Portal-Windows.zip` from the repo's **Releases** page, unzip it and double-click **Bedrock Portal.exe**. No Python, Node or terminal needed. The app:

- starts the gateway on `http://127.0.0.1:8787` (or the next free port);
- opens the dashboard in its own window, using Windows' built-in WebView2;
- stops the gateway when you close the window.

While the window is open, your code and Claude Code can use `http://127.0.0.1:8787/v1`. Opening the app a second time just brings up another window.

- **Where your data lives:** the database, logs and images are in `%APPDATA%\BedrockPortal`, never next to the exe or in the repo. Updating the exe keeps them.
- **First launch:** Windows SmartScreen may say "unrecognized app", because the exe isn't code-signed. Click *More info → Run anyway*.
- **API only, no window:** `"Bedrock Portal.exe" --headless`. Add `--browser` to use your normal browser instead of the app window.
- **macOS:** `Bedrock-Portal-macOS.zip` → `Bedrock Portal.app`. The first time, right-click → Open, because the app is unsigned.

**Publishing a new version.** Push a tag such as `git tag v1.0.1 && git push origin v1.0.1`. The `Desktop app` GitHub Action then runs the tests, builds the Windows and macOS apps, smoke-tests them and attaches them to the release. To build the exe on your own PC instead, run `.\scripts\build-desktop.ps1`, which writes `dist\Bedrock Portal.exe`.

### Option B: run from source (Windows)

Requirements: **Python 3.10+** and **Node.js 20+** (Node is only needed once, to build the dashboard).

```powershell
cd "C:\Users\<you>\Documents\SSS-Fire\AWS Portal"
.\scripts\start.ps1
```

If PowerShell blocks the script, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once. Then open **http://127.0.0.1:8787** and create the admin password.

macOS/Linux: `./scripts/start.sh`. Docker: `docker compose up -d --build`. Compose mounts `~/.aws` read-only; for AWS SSO profiles, mount `~/.aws/sso/cache` read-write so tokens can refresh.

## 2. Connect AWS (once)

The portal works with any credentials boto3 can find. The recommended setup is a **dedicated least-privilege role** that the portal assumes.

1. In the dashboard, go to **Settings → AWS**. Copy the **External ID**. You can also download the template from that page.
2. Deploy `infra/bedrock-portal-role.yaml`, either with the CloudFormation console ("Upload a template file") or with the CLI:
   ```bash
   aws cloudformation deploy --template-file infra/bedrock-portal-role.yaml \
     --stack-name bedrock-portal-role --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides ExternalId=<external-id-from-settings>
   aws cloudformation describe-stacks --stack-name bedrock-portal-role --query "Stacks[0].Outputs"
   ```
   Optional template parameters:
   - `TrustedPrincipalArn`: for a true cross-account setup.
   - `TranscribeBucketName`: creates a private S3 bucket for Amazon Transcribe.
   - `CreateRunnerUser=true`: creates an IAM user that can only assume the role, if this machine has no AWS profile yet.
3. In **Settings → AWS**, choose **Assume role** and paste the `RoleArn`. If your source credentials aren't the default profile, set the source profile name. Then click **Test connection**.
4. Go to **Models → Sync from AWS**. Your models and default aliases appear.
5. **Anthropic models only:** submit the one-time use-case form in the Bedrock console (Model catalog → any Claude model). Other serverless models have been enabled automatically since Oct 2025.

Settings can also be preset through `.env`; see `.env.example`.

## 3. Create a key and use it

In **API Keys → New key**, the key is shown once. Then:

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="sk-portal-...")

r = client.chat.completions.create(model="smart", messages=[{"role": "user", "content": "Hi"}])
print(r.choices[0].message.content, r.usage.cost)          # cost in USD

client.embeddings.create(model="embed", input=["hello", "world"])
client.images.generate(model="image", prompt="isometric lighthouse at dusk")
client.audio.speech.create(model="tts-1-hd", voice="nova", input="Hello!").write_to_file("hi.mp3")
client.audio.transcriptions.create(model="whisper-1", file=open("note.m4a", "rb"))
```

**Claude Code** through the portal:
```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:8787"
$env:ANTHROPIC_AUTH_TOKEN = "sk-portal-..."
$env:ANTHROPIC_MODEL = "claude-opus-5-5"      # Anthropic names are mapped to the best Bedrock route; aliases also work
claude
```

**LangChain:** `ChatOpenAI(base_url=..., api_key=..., model="smart", stream_usage=True)`. For embeddings, use `OpenAIEmbeddings(..., check_embedding_ctx_length=False)`.
**Vercel AI SDK:** `createOpenAICompatible({ name: "portal", baseURL, apiKey, includeUsage: true })`.
More snippets are in the dashboard under **Quickstart**.

### Request and response extras

| Header / field | Meaning |
|---|---|
| `x-portal-cache: 1` (request) | Exact-match response cache for non-streaming chat and embeddings (TTL in Settings). |
| `x-portal-session: <id>` (request) | Groups related calls, such as an agent run, so you can filter them in Logs. |
| `x-request-id` (response) | ID of the log row. |
| `x-portal-model`, `x-portal-attempt` (response) | The Bedrock model that answered and its position in the fallback chain. |
| `x-portal-cost-usd`, `usage.cost` | Exact cost of the call. |
| `reasoning_effort` | Claude 5: adaptive thinking + effort. Claude 3.7–4.5: thinking budget. Nova 2: `reasoningConfig`. gpt-oss: `reasoning_effort`. `"none"` turns thinking off. Thinking text comes back as `reasoning_content`. |
| `response_format: json_schema` | Implemented with forced tool use. The JSON is returned in `message.content`. |
| `additional_model_request_fields` | Passed straight to Bedrock's `additionalModelRequestFields` for model-specific options. |
| `service_tier: "priority" \| "flex"`, `latency: "optimized"` | Mapped to Bedrock service tiers and latency-optimized inference. |

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/models`, `/v1/models/{id}` | Aliases, presets and enabled models visible to the key |
| POST | `/v1/chat/completions` | OpenAI Chat Completions → Bedrock Converse / ConverseStream |
| POST | `/v1/embeddings` | `encoding_format` float/base64. `dimensions`. `input_type` for Cohere. |
| POST | `/v1/images/generations` | `size`, `quality` (`hd` → premium), `n`, `negative_prompt`, `seed`, `response_format` url/b64_json |
| POST | `/v1/audio/speech` | Models: `polly/generative`, `polly/neural`, `polly/long-form`, `polly/standard` (or `tts-1`, `tts-1-hd`). Formats: mp3/opus/ogg/wav/pcm (pcm is 16 kHz). |
| POST | `/v1/audio/transcriptions` | Multipart `file`. `response_format` json/text/verbose_json. srt/vtt only with `aws-transcribe`. |
| GET | `/v1/audio/voices` | Polly voices (`?engine=generative&language=en-US`) |
| POST | `/v1/rerank` | `{model, query, documents, top_n, return_documents}` |
| POST | `/v1/messages`, `/v1/messages/count_tokens` | Anthropic Messages API for Claude models. Unsupported beta flags and fields are dropped automatically. |
| — | `/api/*` | Dashboard API (admin session). Interactive docs at `/docs`. |

## Security notes

- By default the server listens on **127.0.0.1 only**. If you expose it, put it behind HTTPS (Caddy, nginx, Cloudflare Tunnel) and set **Settings → Public base URL**.
- API keys are stored as SHA-256 hashes. The admin password uses scrypt, and changing it signs out every session.
- In `static_keys` mode the AWS secret is stored in the local SQLite file. Prefer **Assume role**.
- Remote image URLs in chat messages are fetched with an SSRF guard that blocks private, loopback, link-local and CGNAT addresses.
- Data lives in `backend/data/` (`portal.db` plus generated images). Back that folder up, and keep it out of git; `.gitignore` already excludes it.

## Limits worth knowing

- **Nova Sonic (realtime speech-to-speech)** is not proxied. It needs a bidirectional HTTP/2 stream that boto3 can't open. Voice in this portal is Polly (TTS) plus Voxtral or Transcribe (STT).
- `n > 1` is rejected; send parallel requests instead. `logprobs` are ignored.
- The OpenAI **Responses API** (`/v1/responses`) is not implemented. Use Chat Completions: in Vercel AI SDK use `openai.chat(...)` or `createOpenAICompatible`.
- Default prices are a snapshot from Oct 2026. Check them in **Settings → Pricing** against https://aws.amazon.com/bedrock/pricing/. The **Billing** page shows what AWS actually charged.
- Cost Explorer data lags about 24 h, and each refresh costs about $0.03, so it's cached (6 h by default).

## Development

```bash
cd backend && pip install -r requirements-dev.txt && python -m pytest -q tests   # fake AWS, no credentials needed
uvicorn app.main:app --reload --port 8787
cd frontend && npm install && npm run dev                                          # Vite dev server proxies to :8787
```

Desktop launcher: `backend/desktop.py`, packaged by `packaging/bedrock-portal.spec` (PyInstaller) and `.github/workflows/release.yml`.

Layout: `backend/app` (FastAPI: `translate.py` is the OpenAI↔Converse layer, `catalog.py` handles models, aliases and resolution, `routes/` has the endpoints) · `frontend/src` (React + Vite) · `infra/` (CloudFormation) · `scripts/` (launchers).
