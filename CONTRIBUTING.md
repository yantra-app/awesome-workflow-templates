# Contributing

Thanks for helping grow the Yantra workflow template collection.

## Add or improve a template

1. Fork the repository and create a branch.
2. Put the workflow JSON in the matching category folder as `<slug>.json`,
   where `<slug>` equals the file's `workflowSlug` (kebab-case).
3. Keep the `template` metadata block: `category`, `department`, `connectors`,
   `source` (leave `path` empty for an original template) and `conversion`.
   Do not write `tier`, `blockers`, `setup` or `conversion.status` by hand:
   the converter writes them for converted files and
   `node scripts/validate.mjs --fix-hand` for hand-built ones.
4. Never commit credentials, tokens, ids of real accounts, or personal data.
   Connectors resolve credentials at run time from the user's own vault.
5. Run the checks and regenerate the catalog:

   ```bash
   npm ci             # once: installs ajv for schema validation
   npm run index      # rebuilds templates.json and the README tables
   npm test           # unit tests, connector catalog check, validation
   npm run report     # tiers, blockers, approximations, shim size
   ```

6. Open a pull request. CI runs the same validation.

## Tiers and blockers

`scripts/lib/quality.mjs` is the one place that decides a template's
quality. The converter, `validate`, `build-index` and `report-quality` all
call it, and CI fails when a file's `template.tier` / `blockers` / `setup`
differ from what it computes.

| Tier | When |
|---|---|
| `verified` | Listed in `data/verified.json` after a person ran it end to end, and no experimental blocker. |
| `ready` | No blocking blocker: it runs once its declared setup is supplied (`template.setupVars`, `template.setupSecrets`, connector credentials). |
| `experimental` | Any of `hard-approximation`, `loop-flattened`, `action-pending-publish` (a patched connector action, or a param a patch adds, not published yet; listed in `data/pending-actions.json`), `unimplemented-action` (not in the published connector registry and no pending patch), `unmapped-node`, `signature-verification` (a digest or signature check that cannot run faithfully, such as an HMAC over a webhook's raw body; the step fails closed), or a value code the converter could not declare as setup: `missing-required-param` (usually content the original passed as a binary file), `http-auth-missing` (for example OAuth 1.0a), `placeholder`, `upstream-literal-id`, `personal-email`, `secret-as-input`. |

`trigger-replaced` and `webhook-registration` are informational: the original
trigger became the Start node, or a provider webhook trigger needs
`cdecli webhook endpoint create` / `cdecli trigger instance upsert` after
import. The legacy `status` field is derived: `ready` for ready/verified, else
`needs-setup`.

### Setup values and workflow secrets

The converter never ships a value a person has to replace
(`scripts/lib/setup.mjs`):

- Author ids, personal emails, placeholders (`YOUR_*`, `<your ...>`,
  `[your-...]`, `*.example` hosts), missing connector ids (Supabase `ref`,
  spreadsheet id, Slack channel, Telegram chat id, ...) and n8n `$env` values
  become **setup values**: an empty `initialContext` key read as `{{key}}`,
  described in `template.setupVars[]` (`key`, `label`, `type`, `example`,
  `usedBy`).
- Credentials become **workflow secrets**: `initialContext.<key> =
  {"$workflowSecret": "KEY"}` plus the header or query parameter the API
  expects (`Authorization: Bearer {{key}}`, `xi-api-key: {{key}}`,
  `?api_key={{key}}`), described in `template.setupSecrets[]` (`key`,
  `label`, `host`, `headerFormat`, `contextKey`, `usedBy`). The host table is
  `HOST_AUTH` in `lib/setup.mjs`; add a host there rather than editing a
  template. Secrets are added in the workflow editor after import (there is no
  cdecli command for them).
- Chat-completion HTTP calls (OpenAI, OpenRouter, Anthropic, Gemini, Mistral,
  DeepSeek, Groq) become `NodeLlmChain` with a connected `NodeChatModel` and
  provider connector credentials; unsupported provider adapters are flagged;
  Apify run-sync, Firecrawl scrape, Slack incoming webhooks, fal.ai queue and
  Cloudinary upload calls run on their connectors.
- Scheduled templates carry `template.activation` (`cdecli cron activate
  <slug>`); import does not start the schedule.
- The default vector store is a Pinecone index with integrated embedding
  (Qdrant, in-memory and Pinecone stores all map to
  `PINECONE_UPSERT_RECORDS_NAMESPACE` / `PINECONE_SEARCH_RECORDS_NAMESPACE`).

`lib/quality.mjs` `scanLiterals` is the detector both the converter (to lift)
and the quality gate (to report leftovers) use, so a literal the converter
misses shows up as a blocker instead of shipping silently.

### Migrating legacy LLM nodes

Inspect with `node scripts/migrate-llm-chain.mjs --dry-run --verbose`, then
run it with `--write`, followed by `npm run index` and `npm test`.
`--check` fails if legacy generation nodes remain. The n8n converter uses
the same migration before writing its final graph.

The saved catalog uses `NodeCdeGenerateObject` and
`NodeCdecliChatCompletion`; it has no standalone `NodeGenerateText`,
`NodeGenerateObject` or `NodeOpenAI` nodes. The migration replaces these
generation steps with `NodeLlmChain` and adds one `NodeChatModel` per chain,
connected from `config` to `llm`. Existing model names and node identities
are preserved, message sockets become prompt sockets, and model settings
move onto Chat Model. Provider choices come from the folded helper metadata,
HTTP conversion notes and model names. This preserves routed models such as
Gemini through OpenRouter and Mistral through Ollama.

The provider registry currently supports `openai`, `openrouter`, `gemini`,
`ollama` and `deepseek`. Other provider settings are
preserved with a manual setup blocker. If the previous conversion omitted a
model ID, the migration creates a declared setup value rather than choosing
a model from a different provider. OpenAI keeps the previous default,
`gpt-4o-mini`. Connect each provider's stored credential in Workflow Configs.

Structured chains use prompt schema mode across providers. Array schemas
receive an object envelope and a Transform that restores the array for later
steps. Legacy shorthand/example schemas are normalized; email/date formats
use syntax patterns because the runtime parser has no format plugins.
These patterns do not check calendar validity or email deliverability.
System-only steps receive a prompt to execute their existing instructions.

### Checking LLM input fields

The converter removes generated prompt helpers when their inputs are guaranteed
text from the immediate upstream node.
Array handling, object serialization, complex expressions, and uncertain
payload shapes keep their helpers. System and user prompt groups are simplified
together so one builder cannot overwrite the other's `last` value. Chat Model
configuration nodes and structured-array adapters remain required.

Run `npm run audit:llm-inputs` to check every LLM Chain, or add `-- --json`
for the full report. The same checks feed the quality gate: a proven missing
input makes a template experimental and adds a setup note. Arbitrary JavaScript
and external API response fields remain unknown until tested with real data.

Dynamic prompt builders receive their source through wired Transform inputs.
The final builder returns text and triggers the LLM directly; the LLM reads
`{{last.transformed}}`. Transform outputs cannot connect to the LLM string
sockets, and imported display labels are not actor names. When both system and
user prompts are dynamic, an Update Context step preserves the earlier system
value before the final user-prompt builder replaces `last.transformed`.
System and user prompt builders receive the same payload;
n8n item expressions read the first item when that payload is a list. Object
prompts are serialized to JSON text. Named references use Yantra's runtime step
names and output sockets.

`data/llm-prompt-fixes.json` records small, reviewed corrections to mistakes in
the upstream prompt itself. `scripts/llm-inputs.test.mjs` covers these fixes,
legacy prompt fields, source wiring, text wrappers, and aggregation names.

### Pending connector patches

`data/pending-actions.json` lists actions that connector patches add or
extend before they are published (ids, params, title, `patch`, and
`patchedFrom`, the published connector version the patch was written
against). While the registry lock pins `patchedFrom` or older:

- a new action is kept in the catalog as `unimplemented`;
- an existing action that only gains params (`newParams`) stays published,
  and the catalog lists those params as `pendingParams`. Only a template that
  sends one of them is affected; templates using the published params are not.

Either way the template reports `action-pending-publish` (tier
`experimental`). After the patch ships: `npm run catalog -- --refresh --only
<connector>` (pins the newer version), `npm run catalog`, `npm run convert`,
`npm run index`, and remove the entry. Keep the title identical to the
published title: a new action is also detected by title.

To register a patch, build its `package.json` in scratch (never in
`~/.cdecli`): `HOME=<scratch> cdecli connector install <id> --force`, apply
only the `package.json` hunk of `first-aid/patches/<id>/*-src.patch` to a copy,
then `npm run catalog -- --import-pkg <dir>` for a connector the catalog does
not know yet, and copy the ids, titles, params (`*` = required) and new params
into `data/pending-actions.json`.

Patches registered this way (all `patchedFrom` the version below):

| connector | version | actions | what they add |
|---|---|---|---|
| `telegram` | 12.1.8 | `TELEGRAM_SEND_DOCUMENT`, `TELEGRAM_SEND_PHOTO` | `document_base64` / `document_file_url` (+ `_filename`, `_mime_type`), same for `photo_*`; only `chat_id` required |
| `jira` | 12.1.10 | `JIRA_ADD_ATTACHMENT` | `content_base64` + `filename` (+ `mime_type`) or `file_url` |
| `yantra-voicebox` | 1.0.8 | `YANTRA_VOICEBOX_TRANSCRIBE` | `audioBase64` + `mimeType` (+ `filename`), or the published `audioUrl` |
| `dropbox` | 12.1.10 | `DROPBOX_UPLOAD_FILE` | `content_base64` or `file_url` besides text `content` |
| `googlesuper` | 12.1.10 | `GOOGLESUPER_EDIT_FILE`, new `GOOGLESUPER_UPLOAD_FILE` | Drive content as `content` / `content_base64` / `file_url` |
| `yantra-storage` | 1.4.1 | new `YANTRA_STORAGE_HTTP_SEND`, `YANTRA_STORAGE_HMAC`, `YANTRA_STORAGE_HASH`, `YANTRA_STORAGE_VERIFY_SIGNATURE` | multipart / form / raw / binary HTTP to public https hosts; digests and signature checks |

### Item loops

`splitInBatches` nodes whose body returns become `NodeLoop`. Version 1/2 use
output 0 for the body; version 3 uses output 1. Return edges are omitted from
the converter's topological order and wired to `NEXT`/`result` after assembly.
Only `onDone`/`results` feed the final continuation or End. Layout ignores the
feedback edges. `loopPolicy: native` means all recorded cycles were converted;
workflows with any unsupported cycles retain `flattened` and their blockers.

Input adapters preserve batches; scalar operations within a larger batch use
nested item loops. Result adapters flatten the returned batch envelopes.
Named loop references read the current item inside the body and collected
results outside it. A batch node without a body return selects its first batch
instead of inventing repetition (including the Zoom template's done self-edge).

Loop merges must preserve the current iteration's completion trigger. Use the
last dependent branch, an exclusive-branch continuation, or a nested loop to
serialize disjoint branches. Invariant side inputs are initialized once before
the loop and saved separately. A data-watching `NodeSync` inside the body can
reuse stale inputs and lose the run id required by `NEXT`.

This item-loop migration covers explicit batch loops. Implicit per-item API/LLM
paths and pagination require their own conversion work; the
presence of an array alone does not justify wrapping an already bulk-safe step.
Loops that retry rejected items but finish the workflow on success also remain
conditional-loop candidates: `NodeLoop` has no successful early-exit port.

### Conditional loops

`scripts/lib/repeat-loops.mjs` finds single-entry conditional cycles after item
feedback is removed. The converter emits `NodeRepeatUntil` and keeps retry state
in a triggered Transform. Each return supplies a boolean `condition` and an
envelope with the payload and selected exit. Only `onDone` dispatches that exit,
restoring the parent run id when the repeat is inside an item loop. Parallel
response/state branches use a nested item loop to join the current attempt.

Every repeat has an attempt limit and an `onError` path that throws. The default
limit is 30; the Pennylane retry retains its five-attempt bound and Seedance uses
its `maxPolls` input (default 120). These inputs remain editable in the graph.
An interval Wait inside a converted cycle uses two checks: false, wait, true.
This preserves its position, including a wait before the first HTTP call, and
supports different waits on different return paths. n8n Wait v1 defaults to one
hour; v1.1 defaults to five seconds. The converter uses the versioned parameters,
not the node's label, to calculate seconds.

HTTP checks preserve full response envelopes when requested. Their adapters
read runtime outputs without connecting a nullable response body, so a 204 can
complete a retry. HTTP/network errors stop unless the original explicitly
requested HTTP error responses for its retry condition. The fal.ai status check
stays an HTTP status check instead of becoming a blocking result-fetch action.

Seven cycles remain flagged: four depend on human approval/form responses, two
search item lists with early exits and service-error returns, and deep research
reads execution history across attempts. Emitting a repeat alone would not
preserve those behaviors. Their `loop-flattened` blockers remain in the catalog.

### Binary files

n8n passes files as `binary` data on each item; on Yantra a file is base64
bytes or a file URL on the step that produced it. The converter finds that
step for every node that reads a file (`binaryOrigin`: it walks back past IF,
Merge, Set, loops, image information, and a write-then-read of the n8n host
disk) and reads it with the `__fileRef` prelude (`FILE_REF`):

| producer | what the consumer gets |
|---|---|
| Drive download | `fileUrl` (the download's `s3url`) |
| HTTP request that downloads a file | `contentBase64`: the request runs on `YANTRA_STORAGE_HTTP_SEND` with `responseType: base64`, and a Transform hands on `{ bodyBase64, filename, mimeType }` |
| OpenAI image / speech | `fileUrl` (the generated image or audio URL) |
| Code that builds `binary` from its own data | `contentBase64` (Code steps keep `binary` on their output) |
| Convert to File | `contentBase64` (text content is base64-encoded) |

Consumers: HTTP multipart / binary bodies (`YANTRA_STORAGE_HTTP_SEND` `files` /
`file`), Telegram send photo / document, Jira attachment, OpenAI transcription
(and Whisper over HTTP, which becomes the platform transcription), Dropbox
upload, Drive upload / update, Read PDF (`pdf-co/PDF_CO_PDF_TO_TEXT` from the
URL, or after a pdf.co base64 upload). A URL origin uses a published param
where the action has one (`audioUrl`, a Telegram photo URL), so those templates
need no patch. When the file enters the run where Yantra has no bytes (an email
attachment, a form upload, the webhook start) or the request goes to a
plain-http / private host that HTTP_SEND refuses, the mapping is still emitted
but stays a `hard-approximation` whose detail says exactly why.

Approximations recorded under `template.conversion.approximate`:

- **Soft** (`soft: true`): documented limits that still run (markdown/HTML transforms, Outlook folder to label, Postgres through the Supabase connector). Not a blocker.
- **Hard** (no `soft`): lossy or incomplete mappings (a file that never reaches Yantra as bytes or a URL, a request to a private host, guessed REST stand-ins, fuzzy action guesses). Blocker `hard-approximation`; an optional `reason` on the entry is appended to the blocker detail.
- **Blocker** (`blocker: "<code>"`): the step maps a known gap to that code (for example `signature-verification`).

Prefer fixing the converter so the same n8n op is exact or soft everywhere, then regenerate. Never make a step pass by faking a value: crypto that cannot run must throw, SQL values go through `SUPABASE_*_ROW` fields or the escaping helpers in `lib/expressions.mjs`, and secrets never ship in a template.

To mark a template verified, run it for real, then add
`{ "path": "<category>/<slug>.json", "verifiedAt": "YYYY-MM-DD", "by": "<name>", "cdecliVersion": "<x.y.z>", "notes": "..." }`
to `data/verified.json` and rebuild the index.

## Fixing a converted template

Most templates here were produced by `scripts/convert-n8n.mjs`. Prefer fixing
the converter (a mapping in `scripts/lib/n8n-mapping.mjs` or a generator in
`scripts/convert-n8n.mjs`) so the fix applies to every template with the same
node, then run `npm run sync` to regenerate. Hand edits to a generated file
are overwritten by the next sync, unless you turn the file into a hand-built
template: set `template.conversion.tool` to `"hand"`, keep
`template.source.path` pointing at the n8n original, fill
`template.comparison` (`n8nSteps`, `yantraSteps`, `foldedHelpers`) and list
what the agent or connector absorbed under `conversion.folded`. The converter
then leaves the file alone and skips the mechanical conversion of that
original. The three showcase templates in the README are built this way; a
hand-built template should be the simplest honest Yantra version of the
automation, not a polished copy of the n8n graph.

## Refreshing from upstream

```bash
npm run sync -- --latest
```

moves the pin in `sources.json` to upstream's current `main`, regenerates all
converted templates, rebuilds the index and validates. Review the diff before
opening the pull request; new n8n node types show up as `experimental` templates
with `TODO(yantra)` stubs (`unmapped-node`), which is the cue to add a mapping.

The converter ignores empty upstream files and converts duplicate workflows
once, preserving their alternate paths as aliases. These are reported separately
from skipped invalid or unsupported files in `.cache/conversion-report.json`
(`ignored`, `aliased`, and `skipped`). An empty file has no workflow to recover;
duplicate aliases point to the existing converted template.

## Updating the connector action catalog

`data/connector-actions.json` is generated by `scripts/connector-catalog.mjs`
and is the only catalog the converter and validator read (never the local
`~/.cdecli` installs, so every machine converts the same way).

- `data/connector-registry.lock.json` pins, per connector, the published
  version and action titles from the CDN registry
  (`https://d3pdzbmtmn6yq3.cloudfront.net/_connectors/registry/<id>.json`).
- An action is published when its title is in that lock
  (`data/connector-action-titles.json` maps ids whose catalog title is the id
  itself). Unpublished actions are dropped unless a template or the converter
  uses them; those stay with `unimplemented: true` and make the template
  `experimental`.

```bash
npm run catalog -- --refresh      # re-pin the lock from the CDN (network), then:
npm run catalog                   # rebuild data/connector-actions.json (offline, deterministic)
npm run catalog -- --refresh --registry ~/.cdecli/registry.json   # pin from a registry snapshot file instead
npm run catalog -- --import-src /path/to/third-party-extensions  # add ids/params for newly published actions
npm run catalog:check             # CI: drift, and any template action missing from the catalog
```

After a refresh, run `npm run convert && npm run index` so templates pick up
newly published actions (their tier improves on its own).

## Blocked n8n node types

These stay as honest `TODO(yantra)` stubs (or HTTP/SQL approximations only where
noted). Do not invent connector mappings until a real Yantra connector exists
with enough actions for the n8n ops in use:

| n8n type | Why blocked |
|---|---|
| `@n8n/n8n-nodes-langchain.vectorStoreQdrant` | `cdecli connector install qdrant --force` is not in the registry (checked 2026-09-25). Converter keeps an approximate `NodeHttpRequest` against Qdrant REST (`/collections/.../points`). Do not invent a connector until that install succeeds. |
| `n8n-nodes-base.googleAnalytics` (report / GA4 runReport) | Maps to `google-analytics/GOOGLE_ANALYTICS_RUN_REPORT` (credential via the connector). The published registry does not ship it yet, so these templates are `experimental` until it does; no access-token run input. |
| `n8n-nodes-base.ssh` | Maps to cdecli `ssh` / `SSH_RUN_COMMAND` (approximate). Templates need a connected SSH credential with an allowlisted host; treat remote shell as privileged. (`executeCommand` still maps to an approximate Transform passthrough + setup for an agent sandbox shell.) |
| `n8n-nodes-base.n8n` / community (magicHour, fiwano, gcf, Perspective, Venafi TLS, cradl, youtubeTranscripter) | No rich connector surface. Converter emits approximate HTTP or Transform stand-ins; set host/API keys in setup notes. Community `pdfMint` maps to cdecli `pdf-co`. |
| `n8n-nodes-base.baserow` (full CRUD) | The published `baserow` connector is list-only; row CRUD exists only in [`first-aid/patches/baserow`](../first-aid/patches/baserow/). The catalog marks those actions `unimplemented`, so templates using them are `experimental` until the patch is published. |
| `n8n-nodes-base.mattermost` (`message.post` and friends) | Stock cdecli `mattermost` is list-resources only. Apply [`first-aid/patches/mattermost`](../first-aid/patches/mattermost/) (`MATTERMOST_CREATE_POST`), then refresh actions. Converter maps `message.post` when patched. |
| `n8n-nodes-base.nocoDb` (`row.create` / update) | Stock lacks row-create/update. Apply [`first-aid/patches/nocodb`](../first-aid/patches/nocodb/); converter maps create/update when patched. |
| `n8n-nodes-base.elasticsearch` | Stock lacks index/update/delete document. Apply [`first-aid/patches/elasticsearch`](../first-aid/patches/elasticsearch/); converter maps those ops when patched. |
| Slack search / GitHub file get / GA runReport | Always the connector actions (`SLACK_SEARCH_MESSAGES`, `GITHUB_GET_REPOSITORY_CONTENT`, `GOOGLE_ANALYTICS_RUN_REPORT`), never a token run input. None is in the published registry yet (`unimplemented`), so the templates are `experimental`. |
| Telegram file download, YouTube search, GCS, n8n API, Perspective, Magic Hour, Fiwano, Venafi, Cradl, Qdrant | No connector action exists, so the HTTP stand-in takes the key as a run input. Blocker `secret-as-input`: pass it from a vault secret, never in chat, and move to a connector when one ships. |
| `n8n-nodes-base.crypto` hmac/hash/sign, Code `crypto.createHmac/createHash` | Crypto `hash` (MD5, SHA-1/256/384/512) and `hmac` (SHA-1/256/384/512) run on `yantra-storage` `YANTRA_STORAGE_HASH` / `YANTRA_STORAGE_HMAC` (pending the yantra-storage patch); the HMAC key is the `HMAC_SECRET` workflow secret, and a Transform sets the digest on the original property. Still blocked (`signature-verification`, the step fails closed, the detail says why): HMAC-MD5 and `sign`, which have no action, and any digest or signature check over the raw request body of a webhook (Meta `x-hub-signature-256`, Shopify HMAC, `rawBody` webhooks), because the Yantra start node passes the body as parsed JSON with no raw bytes. `YANTRA_STORAGE_VERIFY_SIGNATURE` takes those once the webhook trigger exposes the raw body. |
| multipart / form / raw / binary `httpRequest` | `YANTRA_STORAGE_HTTP_SEND` (pending the yantra-storage patch): form fields to `fields`, binary form fields to `files[{ field, contentBase64 \| fileUrl }]`, a binary body to `file`, raw text to `rawBody` + `contentType`; credential headers from workflow secrets as for the HTTP node. Public https hosts only: a self-hosted Gotenberg or Stirling PDF on `http://` or a private host stays `hard-approximation`. |
| `youtubeTranscripter` | Stays a hard-approximate timedtext HTTP stand-in: no connector fetches public YouTube transcripts faithfully (timedtext is unofficial, Data API captions need video ownership, `yantra-youtube-search` captions depend on the backend). |
| `n8n-nodes-base.postgres` | insert/update/select/delete become `SUPABASE_*_ROW` with `fields` / `filters` (the connector escapes values). `executeQuery` with `{{ }}` is built by a params step that escapes every value (`lib/expressions.mjs` `toSafeSqlJs`). All need the Supabase project `ref`. |
| `n8n-nodes-base.supabase` row CRUD | Apply [`first-aid/patches/supabase`](../first-aid/patches/supabase/) after `cdecli connector install supabase --force`. Converter maps create/get/update/delete to `SUPABASE_INSERT_ROW` / `SELECT_ROWS` / `UPDATE_ROW` / `DELETE_ROW`. Missing table, fields, or filter stays hard approximate. Vector insert uses `SUPABASE_INSERT_ROW`. Vector query and update use `SUPABASE_SEARCH_ROWS` when the table name is a simple identifier. A table name that is not a simple identifier stays hard approximate SQL. |
| `n8n-nodes-base.s3` upload | Apply [`first-aid/patches/aws-s3`](../first-aid/patches/aws-s3/) after a force install. Upload maps `Bucket` and `FileKey` and stays soft-approximate for the binary body. |
| `n8n-nodes-base.lemlist` add lead | Apply [`first-aid/patches/lemlist`](../first-aid/patches/lemlist/) after a force install. `lead.create` / `lead.upsert` use `LEMLIST_ADD_LEAD`. |
| `n8n-nodes-base.googleDocs` update | `document.update` is `GOOGLESUPER_INSERT_TEXT_ACTION` (already in the catalog). Get stays `GOOGLESUPER_GET_DOCUMENT_BY_ID`. `document.create` makes an empty Google Doc like n8n: `GOOGLESUPER_CREATE_FILE` with the Docs mime type in the folder. |
| `n8n-nodes-base.airtable` update matched on other columns | `LIST_RECORDS` with a `filterByFormula` built from the matching columns, then `UPDATE_MULTIPLE_RECORDS` for every match (10 per run); no match stops the run. |
| Blank content in the original | A WhatsApp text or Outlook body the author left empty, and an HTTP request with no URL, become declared setup values (`whatsappMessage`, `emailBody`, `<node>Url`). |
| `n8n-nodes-base.mySql` | Still ClickHouse `CLICKHOUSE_EXECUTE_QUERY`. Different dialect, so it stays a hard approximate. |

## Releasing

Consumers (the `yantra-workflow-templates` skill) can pin a release tag
instead of `main`. `scripts/release.mjs` builds the files; it never tags,
commits or publishes.

```bash
npm ci && npm test                                # green first
npm run release -- --version 1.1.0 --since v1.0.0 # or --since HEAD for the last commit
#   writes dist/templates-1.1.0.json (+ .sha256), a CHANGELOG.md entry from the
#   templates.json diff, and package.json "version"
git diff CHANGELOG.md package.json                # review
git add CHANGELOG.md package.json && git commit -m "Release 1.1.0"
git tag v1.1.0 && git push origin main v1.1.0
gh release create v1.1.0 dist/templates-1.1.0.json dist/templates-1.1.0.json.sha256 --notes-file <(sed -n '/^## 1.1.0/,/^## /p' CHANGELOG.md)
```

`dist/` is git-ignored; the bundle travels as a release asset. Raw files at
`https://raw.githubusercontent.com/yantra-app/awesome-workflow-templates/v1.1.0/...`
serve the same content per template.

## Style

- Plain dashes, never em dashes.
- Template names and descriptions describe what the workflow does for the
  user, not which engine runs it.
