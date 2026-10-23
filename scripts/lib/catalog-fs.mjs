// Shared file-system and vocabulary helpers for the catalog scripts.
//
// One walker, one set of enums and one placeholder list, used by
// convert-n8n, validate, build-index, report-quality, connector-catalog and
// release. Change a rule here and every script sees it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Top-level directories that never hold templates. */
export const SKIP_DIRS = new Set(['.git', '.cache', '.github', 'node_modules', 'scripts', 'data', 'dist']);

/** Legacy `template.conversion.status` values (kept for older consumers). */
export const STATUSES = ['ready', 'needs-setup', 'partial'];

/**
 * Quality tiers, best first.
 *
 *   verified      listed in data/verified.json by a person who ran it end to end
 *   ready         runs once its declared setup is supplied: setup values
 *                 (template.setupVars, written into the Workflow Configs
 *                 initialContext), workflow secrets (template.setupSecrets, added
 *                 in the workflow editor) and connector credentials
 *   experimental  a step does not run as shipped: an approximation, a flattened
 *                 loop, an action not published yet, or a value the converter
 *                 could not turn into a declared setup item
 *
 * There is no separate "needs-setup" tier any more: every value a person has to
 * provide is declared as setup, so a template either runs after setup or it
 * does not.
 */
export const TIERS = ['verified', 'ready', 'experimental'];

/**
 * Blocker codes. `tier` is the best tier a template carrying the blocker can
 * reach; `blocking: false` blockers are informational only (they still land in
 * the setup list).
 *
 * The value codes (missing-required-param ... secret-as-input) only appear when
 * the converter could not declare the value as a setup variable or workflow
 * secret; a declared value is setup, not a blocker.
 */
export const BLOCKERS = {
  'missing-required-param': { tier: 'experimental', blocking: true, label: 'A connector step is missing a required value that is not declared as setup' },
  'http-auth-missing': { tier: 'experimental', blocking: true, label: 'An HTTP step calls an authenticated API without a declared secret' },
  placeholder: { tier: 'experimental', blocking: true, label: 'A placeholder value is not declared as setup' },
  'upstream-literal-id': { tier: 'experimental', blocking: true, label: 'An ID copied from the original author is still in a step' },
  'personal-email': { tier: 'experimental', blocking: true, label: 'A personal email address from the original is still in a step' },
  'secret-as-input': { tier: 'experimental', blocking: true, label: 'A secret travels as a plain value instead of a workflow secret' },
  'signature-verification': { tier: 'experimental', blocking: true, label: 'A digest or signature check cannot run faithfully (no digest action, or a raw webhook body Yantra does not expose)' },
  'webhook-registration': { tier: 'ready', blocking: false, label: 'A provider webhook trigger must be registered after import' },
  'trigger-replaced': { tier: 'ready', blocking: false, label: 'The original trigger runs on demand or via the API on Yantra' },
  'loop-flattened': { tier: 'experimental', blocking: true, label: 'A per-item loop was flattened into one pass' },
  'hard-approximation': { tier: 'experimental', blocking: true, label: 'A step only approximates the original behaviour' },
  'action-pending-publish': { tier: 'experimental', blocking: true, label: 'A connector action, or a param it sends, is patched but not published yet' },
  'unimplemented-action': { tier: 'experimental', blocking: true, label: 'A connector action is not published in the connector registry' },
  'unmapped-node': { tier: 'experimental', blocking: true, label: 'A step has no Yantra equivalent yet (TODO stub)' },
};

/**
 * Connector actions that a connector patch adds or extends and that are
 * waiting to be published (data/pending-actions.json, also read by the catalog
 * build). A template using a pending action, or a pending param of an
 * existing action (`newParams`), is experimental with `action-pending-publish`;
 * once the patch ships and the registry lock pins a version newer than
 * `patchedFrom`, the action is published and the template promotes on the next
 * convert.
 *
 * @returns {Record<string, { title: string, params: string[], patch: string, patchedFrom?: string, newParams?: string[] }>} keyed `connector/ACTION`
 */
export function loadPending(root = ROOT) {
  const f = path.join(root, 'data', 'pending-actions.json');
  if (!fs.existsSync(f)) return {};
  const out = {};
  for (const [c, actions] of Object.entries(JSON.parse(fs.readFileSync(f, 'utf8')).actions || {})) for (const [a, def] of Object.entries(actions)) out[`${c}/${a}`] = def;
  return out;
}
export const PENDING_PUBLISH = Object.fromEntries(Object.entries(loadPending()).map(([k, v]) => [k, v.patch]));

/** Compare dotted numeric versions (`12.1.8` < `12.1.10`); non-numeric parts compare as 0. */
export function compareVersions(a, b) {
  const pa = String(a ?? '').split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b ?? '').split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Is a pending patch still unpublished for this pinned connector version? A
 * patch written against `patchedFrom` ships in a later release, so the patch is
 * pending while the lock pins `patchedFrom` or older (or nothing at all).
 */
export function patchPending(def, lockedVersion) {
  if (!def?.patchedFrom) return true;
  if (!lockedVersion) return true;
  return compareVersions(lockedVersion, def.patchedFrom) <= 0;
}

/** Legacy status derived from a tier, so consumers that read `status` keep working. */
export function statusForTier(tier) {
  return tier === 'ready' || tier === 'verified' ? 'ready' : 'needs-setup';
}

/**
 * Placeholder values that must never ship in a runnable step. Each entry is a
 * regular expression source matched against node input strings.
 */
export const PLACEHOLDER_PATTERNS = [
  '(?<![A-Za-z])YOUR[_-][A-Z0-9_-]+\\b',
  '\\byour[_-](?:api[_-]?key|token|secret|email|domain|id|url|channel|sheet|webhook|company|business|org|site|app|workspace|project|bucket|table|base)[a-z0-9_-]*\\b',
  // RFC 2606 reserved `.example` hosts only ever stand in for the user's own.
  'https?://[^\\s/\'"`]+\\.example(?=[/:\'"`]|$)',
  '<your[^>]{0,40}>',
  '\\[(?:your|insert|YOUR|INSERT)[-_ ][^\\]\\n]{1,40}\\]',
  '\\bCHANGE[-_ ]?ME\\b',
  '\\b(?:INSERT|INSERISCI|INSERIRE|INGRESA|EINFUEGEN)[-_](?:YOUR[-_])?[A-Z0-9]+(?:[-_][A-Z0-9]+)*\\b',
  '\\bchangeme\\b',
  '\\bREPLACE[_-]?(?:ME|WITH[A-Z_]*)\\b',
  '\\bxxxx+\\b',
  '\\b(?:BOT_TOKEN|PROPERTY_ID|N8N_HOST|GCS_ACCESS_TOKEN|SLACK_BOT_TOKEN|PERSPECTIVE_API_KEY|MAGIC_HOUR_API_KEY|FIWANO_HOST|VENAFI_API_KEY|CRADL_API_KEY|QDRANT_HOST|GA_ACCESS_TOKEN|QDRANT_API_KEY)\\b',
  // Converter fallbacks for values the original never set.
  '/(?:OWNER|REPO|PATH|BUCKET|WORKFLOW_ID|AGENT_ID|PROJECT_ID|COLLECTION)(?=[/?]|$)',
  "\\bHOST\\b(?=[/:'\"])",
];
export const PLACEHOLDER_RE = new RegExp(PLACEHOLDER_PATTERNS.map((p) => `(?:${p})`).join('|'));

/** Email domains that are fine to ship (documentation / examples). */
export const SAFE_EMAIL_DOMAINS = /(?:^|\.)(?:example\.(?:com|org|net)|test|invalid|localhost|domain\.com|email\.com|company\.com|yourdomain\.com|yourcompany\.com|acme\.com|[a-z]\.(?:com|org|net))$/i;

/** Every template file, as repository-relative paths, sorted. */
export function listTemplates(root = ROOT) {
  const out = [];
  for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory() || SKIP_DIRS.has(dir.name) || dir.name.startsWith('.')) continue;
    for (const f of fs.readdirSync(path.join(root, dir.name))) {
      if (f.endsWith('.json')) out.push(path.join(dir.name, f));
    }
  }
  return out.sort();
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(path.isAbsolute(file) ? file : path.join(ROOT, file), 'utf8'));
}

/** Stable JSON: object keys sorted recursively (arrays keep their order). */
export function stableStringify(value, indent = 1) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
    return v;
  };
  return JSON.stringify(sort(value), null, indent);
}

export function loadSources(root = ROOT) {
  return readJson(path.join(root, 'sources.json'));
}

export function loadCatalog(root = ROOT) {
  return readJson(path.join(root, 'data', 'connector-actions.json'));
}

/** Manually verified templates: `{ templates: [{ path, verifiedAt, by, notes }] }`. */
export function loadVerified(root = ROOT) {
  const f = path.join(root, 'data', 'verified.json');
  if (!fs.existsSync(f)) return new Map();
  const data = readJson(f);
  return new Map((data.templates || []).map((t) => [t.path, t]));
}
