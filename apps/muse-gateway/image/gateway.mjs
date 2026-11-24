// muse-gateway — minimal HTTP gateway for Muse (cloud) -> local network.
//
// Node.js standard library only. No dependencies.
//
// Endpoints:
//   GET  /healthz                 no auth
//   GET  /                        no auth, endpoint list (no secrets)
//   POST /v1/tasks                run one Claude Code task (headless)
//   POST /v1/toolchain            run an allowlisted read-only local tool
//   GET  /v1/secrets/:name       retrieve ONE allowlisted secret by name
//
// Auth: every /v1/* request needs `Authorization: Bearer <token>`, where the
// token is read from /secrets/gateway-token at startup. The gateway token and
// the Anthropic API key are NEVER retrievable through /v1/secrets, even if
// someone adds them to the allowlist.
//
// Secrets: mounted read-only at /secrets, one file per key, populated by an
// ExternalSecret from Doppler (see base/external-secret.yaml). A secret is
// only handed out if its name is in ALLOWED_SECRETS (env, comma-separated).
// Every retrieval is audit-logged (name + time, never the value).
//
// Claude Code: invoked headless as `claude -p --output-format json`.
// Anthropic does not publish an official Claude Code OCI image, so the pod
// image (see image/Dockerfile) installs the npm CLI. Auth is via
// ANTHROPIC_API_KEY from the mounted secret, never via an interactive login.
//
// One task at a time. This is deliberate for v1: Claude Code is heavy, and
// serialising tasks keeps resource use and auditability simple.
'use strict';

const http = require('node:http');
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 8080);
const WORKSPACE = '/workspace';
const SECRETS_DIR = '/secrets';
const CLAUDE_CONFIG_DIR = '/home/agent/.claude';

// Secrets that are never retrievable through the API, whatever the allowlist says.
const SECRET_DENYLIST = new Set(['gateway-token', 'anthropic-api-key']);
const ALLOWED_SECRETS = new Set(
  (process.env.ALLOWED_SECRETS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

let gatewayToken = '';
try {
  gatewayToken = fs.readFileSync(`${SECRETS_DIR}/gateway-token`, 'utf8').trim();
} catch (err) {
  console.error(JSON.stringify({ level: 'error', msg: 'gateway-token not mounted, /v1/* will reject all requests', err: String(err) }));
}

function log(level, msg, extra = {}) {
  console.log(JSON.stringify({ level, msg, time: new Date().toISOString(), ...extra }));
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function isAuthorized(req) {
  if (!gatewayToken) return false;
  const header = req.headers.authorization || '';
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(gatewayToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error('body too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- tasks
let taskRunning = false;

const PERMISSION_MODES = new Set(['plan', 'acceptEdits', 'default']);
// `bypassPermissions` is deliberately excluded in v1.
const DEFAULT_ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'];

function runClaudeTask(body) {
  return new Promise((resolve) => {
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) return resolve({ status: 400, body: { error: 'prompt is required' } });

    const cwd = typeof body.cwd === 'string' && body.cwd ? body.cwd : WORKSPACE;
    if (!cwd.startsWith(WORKSPACE)) {
      return resolve({ status: 400, body: { error: 'cwd must be under /workspace' } });
    }

    const permissionMode =
      typeof body.permissionMode === 'string' && PERMISSION_MODES.has(body.permissionMode)
        ? body.permissionMode
        : 'acceptEdits';
    const allowedTools = Array.isArray(body.allowedTools) && body.allowedTools.length
      ? body.allowedTools.filter((t) => typeof t === 'string')
      : DEFAULT_ALLOWED_TOOLS;
    const timeoutMs = Math.min(
      Math.max(Number(body.timeoutMs) || 600_000, 60_000),
      30 * 60_000,
    );

    const args = [
      '-p', prompt,
      '--output-format', 'json',
      '--permission-mode', permissionMode,
      '--allowedTools', allowedTools.join(','),
    ];
    const started = Date.now();
    const child = spawn('claude', args, {
      cwd,
      timeout: timeoutMs,
      env: {
        ...process.env,
        HOME: '/home/agent',
        CLAUDE_CONFIG_DIR,
        // ANTHROPIC_API_KEY is inherited from the pod env (mounted secret).
        // It is never accepted from the request body.
      },
      killSignal: 'SIGINT',
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      resolve({ status: 502, body: { error: `failed to start claude: ${err.message}` } });
    });
    child.on('close', (code) => {
      const durationMs = Date.now() - started;
      let result = null;
      try { result = JSON.parse(stdout); } catch { /* fall through to raw */ }
      if (result) {
        resolve({ status: code === 0 ? 200 : 502, body: { ...result, duration_ms: durationMs } });
      } else {
        resolve({
          status: code === 0 ? 200 : 502,
          body: { result: stdout, stderr: stderr.slice(0, 2000), duration_ms: durationMs },
        });
      }
    });
  });
}

// ------------------------------------------------------------- toolchain
// Read-only local tools only. No apply / delete / exec into other pods /
// shell passthrough in v1. `args` is passed as an argv array, never a shell
// string. Add write operations only as a deliberate, reviewed change.
const TOOLCHAIN = {
  kubectl: {
    subcommands: new Set(['get', 'describe']),
    validate: (args) => {
      // kubectl <get|describe> ... -n muse-gateway only, no --all-namespaces.
      if (args.includes('--all-namespaces') || args.includes('-A')) return 'cross-namespace kubectl is not allowed in v1';
      const nsIdx = args.indexOf('-n');
      if (nsIdx !== -1 && args[nsIdx + 1] !== 'muse-gateway') return 'kubectl is limited to the muse-gateway namespace in v1';
      if (args.includes('--namespace') && args[args.indexOf('--namespace') + 1] !== 'muse-gateway') {
        return 'kubectl is limited to the muse-gateway namespace in v1';
      }
      return null;
    },
  },
  git: {
    subcommands: new Set(['status', 'log', 'diff']),
    validate: () => null,
  },
  helm: {
    subcommands: new Set(['list', 'status']),
    validate: () => null,
  },
};

function runToolchain(body) {
  return new Promise((resolve) => {
    const tool = body.tool;
    const args = Array.isArray(body.args) ? body.args : [];
    const spec = TOOLCHAIN[tool];
    if (!spec) return resolve({ status: 400, body: { error: `unknown tool: ${String(tool)}` } });
    if (!args.length || !spec.subcommands.has(args[0])) {
      return resolve({ status: 400, body: { error: `allowed ${tool} subcommands: ${[...spec.subcommands].join(', ')}` } });
    }
    if (args.some((a) => typeof a !== 'string' || a.includes('\n') || a.includes(';') || a.includes('|') || a.includes('$('))) {
      return resolve({ status: 400, body: { error: 'invalid argument' } });
    }
    const err = spec.validate(args);
    if (err) return resolve({ status: 403, body: { error: err } });

    execFile(tool, args, { cwd: WORKSPACE, timeout: 60_000, maxBuffer: 1_000_000 }, (error, stdout, stderr) => {
      resolve({
        status: error ? 502 : 200,
        body: { tool, args, stdout: stdout.slice(0, 100_000), stderr: stderr.slice(0, 2000), exit_code: error ? error.code : 0 },
      });
    });
  });
}

// --------------------------------------------------------------- secrets
function getSecret(name) {
  if (!name || typeof name !== 'string') return { status: 400, body: { error: 'secret name required' } };
  if (SECRET_DENYLIST.has(name)) return { status: 403, body: { error: 'that secret is never retrievable through the API' } };
  if (!ALLOWED_SECRETS.has(name)) return { status: 403, body: { error: 'that secret is not in the allowlist' } };
  let value;
  try {
    value = fs.readFileSync(`${SECRETS_DIR}/${name}`, 'utf8').trim();
  } catch {
    return { status: 404, body: { error: 'secret not mounted in the pod' } };
  }
  log('info', 'secret retrieved', { secret: name });
  return { status: 200, body: { name, value } };
}

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;
  log('info', 'request', { method: req.method, path });

  try {
    if (req.method === 'GET' && path === '/healthz') return send(res, 200, { ok: true });
    if (req.method === 'GET' && path === '/') {
      return send(res, 200, {
        service: 'muse-gateway',
        endpoints: ['GET /healthz', 'POST /v1/tasks', 'POST /v1/toolchain', 'GET /v1/secrets/:name'],
      });
    }

    if (!path.startsWith('/v1/')) return send(res, 404, { error: 'not found' });
    if (!isAuthorized(req)) return send(res, 401, { error: 'unauthorized' });

    if (req.method === 'POST' && path === '/v1/tasks') {
      if (taskRunning) return send(res, 409, { error: 'a task is already running; one task at a time in v1' });
      taskRunning = true;
      try {
        const body = await readJson(req);
        const { status, body: out } = await runClaudeTask(body);
        return send(res, status, out);
      } finally {
        taskRunning = false;
      }
    }

    if (req.method === 'POST' && path === '/v1/toolchain') {
      const body = await readJson(req);
      const { status, body: out } = await runToolchain(body);
      return send(res, status, out);
    }

    const secretMatch = req.method === 'GET' && path.match(/^\/v1\/secrets\/([A-Za-z0-9._-]+)$/);
    if (secretMatch) {
      const { status, body: out } = getSecret(secretMatch[1]);
      return send(res, status, out);
    }

    return send(res, 404, { error: 'not found' });
  } catch (err) {
    log('error', 'request failed', { path, err: String(err) });
    return send(res, 500, { error: 'internal error' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  log('info', 'muse-gateway listening', { port: PORT, allowed_secrets: [...ALLOWED_SECRETS] });
});
