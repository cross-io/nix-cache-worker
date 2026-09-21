const DEFAULT_CACHE_ORIGIN = "https://cache.example.org";
const DEFAULT_REPOSITORY_URL = "https://github.com/ihciah/nix-cache-worker";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function productFooter(): string {
  return `<footer class="site-footer">Powered by <a href="${escapeHtml(DEFAULT_REPOSITORY_URL)}" target="_blank" rel="noreferrer">NixCacheWorker</a></footer>`;
}

export function adminPage(publicOrigin = DEFAULT_CACHE_ORIGIN): Response {
  const origin = escapeHtml(publicOrigin.replace(/\/+$/, "") || DEFAULT_CACHE_ORIGIN);
  const footer = productFooter();
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Nix Cache Admin</title>
  <style>
    :root { color-scheme: dark; --bg: #101313; --panel: #171b1b; --panel-2: #1d2423; --line: #303937; --text: #edf3ef; --muted: #9ca9a3; --green: #9de2b5; --green-2: #4fbb7b; --red: #f39a98; --amber: #e8c87f; }
    * { box-sizing: border-box; }
    body { margin: 0; background: radial-gradient(circle at 75% -20%, #244037 0, transparent 45%), var(--bg); color: var(--text); font: 14px/1.45 Inter, ui-sans-serif, system-ui, sans-serif; }
    button, input, textarea { font: inherit; }
    button { cursor: pointer; }
    .hidden { display: none !important; }
    .login-view { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 28px; padding: 24px; }
    .login-card { width: min(420px, 100%); background: rgba(23, 27, 27, .94); border: 1px solid var(--line); border-radius: 20px; padding: 32px; box-shadow: 0 24px 80px #0006; }
    .brand { color: var(--green); font-weight: 800; letter-spacing: .18em; font-size: 12px; }
    h1, h2, h3, p { margin-top: 0; }
    h1 { font-size: 30px; line-height: 1.1; margin-bottom: 8px; }
    h2 { font-size: 18px; margin-bottom: 4px; }
    h3 { font-size: 15px; margin-bottom: 4px; }
    .lead, .subtle { color: var(--muted); }
    label { display: block; color: var(--muted); font-size: 12px; margin-bottom: 6px; }
    input, textarea { width: 100%; color: var(--text); background: #0f1212; border: 1px solid var(--line); border-radius: 9px; padding: 9px 10px; outline: none; }
    input:focus, textarea:focus { border-color: var(--green-2); }
    textarea { resize: vertical; }
    .field { margin-bottom: 14px; }
    .button { border: 1px solid var(--line); border-radius: 8px; color: var(--text); background: transparent; padding: 8px 11px; }
    .button:hover { border-color: var(--green-2); }
    .button.primary { background: var(--green-2); border-color: var(--green-2); color: #07130c; font-weight: 700; }
    .button.toggle.active { background: var(--green); border-color: var(--green); color: #07130c; font-weight: 700; }
    .button.danger { color: var(--red); }
    .button.small { padding: 5px 8px; font-size: 12px; }
    .message { min-height: 20px; color: var(--muted); margin: 10px 0; }
    .message.error { color: var(--red); }
    .message.success { color: var(--green); }
    .shell { min-height: 100vh; }
    main { width: min(1500px, 100%); margin: 0 auto; padding: 38px clamp(18px, 4vw, 58px); }
    .topbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 28px; }
    .top-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; justify-content: flex-end; }
    .admin-nav { display: flex; gap: 6px; flex-wrap: wrap; }
    .admin-nav a { text-decoration: none; }
    .eyebrow { color: var(--green); text-transform: uppercase; letter-spacing: .14em; font-size: 11px; font-weight: 700; }
    .connected { color: var(--green); border: 1px solid #3d7554; border-radius: 20px; padding: 6px 11px; font-size: 12px; }
    .site-footer { color: #718078; font-size: 11px; letter-spacing: .025em; line-height: 1.4; text-align: center; }
    .site-footer a { color: #9ab9a4; text-decoration: none; border-bottom: 1px solid transparent; transition: color .15s ease, border-color .15s ease; }
    .site-footer a:hover, .site-footer a:focus-visible { color: var(--green); border-bottom-color: var(--green-2); outline: none; }
    .stats { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; margin-bottom: 18px; }
    .stat, .panel { background: rgba(23, 27, 27, .92); border: 1px solid var(--line); border-radius: 14px; }
    .stat { padding: 16px; }
    .stat-label { color: var(--muted); font-size: 12px; }
    .stat-value { color: var(--green); font-size: 25px; font-weight: 750; margin-top: 7px; }
    .panel { padding: 20px; margin-bottom: 18px; }
    .publisher-panel { background: linear-gradient(145deg, #192722, #151c1b); border-color: #385b4b; }
    .publisher-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .publisher-card { border: 1px solid var(--line); background: rgba(11, 16, 15, .42); border-radius: 11px; padding: 15px; }
    .publisher-card.wide { grid-column: 1 / -1; }
    .publisher-card h3 { display: inline; margin-left: 8px; }
    .publisher-card p { color: var(--muted); margin: 9px 0 0 31px; font-size: 12px; }
    .publisher-step { display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; background: #2e6e50; color: #e9fff0; font-size: 12px; font-weight: 800; vertical-align: middle; }
    .publisher-code { margin: 13px 0 0 31px; padding: 10px 11px; overflow-x: auto; color: #d8f2df; background: #0c1210; border: 1px solid #2e493d; border-radius: 8px; white-space: pre-wrap; word-break: break-word; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .panel-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
    .toolbar, .actions, .form-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .actions { position: relative; }
    .toolbar input { max-width: 330px; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; min-width: 920px; }
    th { color: var(--muted); font-size: 11px; text-align: left; text-transform: uppercase; letter-spacing: .08em; padding: 10px; border-bottom: 1px solid var(--line); }
    td { padding: 12px 10px; border-bottom: 0; vertical-align: top; }
    tbody tr { border-bottom: 1px solid #28302e; }
    .package-row { background: #1b2321; border-bottom-color: #3c5048; }
    .package-row td { font-weight: 700; }
    .package-name { color: var(--green); font-size: 15px; }
    .tag-group-row { background: #202b27; border-bottom-color: #3c5048; }
    .tag-group-row td:first-child { padding-left: 24px; }
    .tag-group-name { color: var(--green); font-weight: 700; }
    .version-row td:first-child { padding-left: 30px; }
    .version-name { font-weight: 700; }
    .tag-list { display: flex; gap: 5px; flex-wrap: wrap; }
    .tag { color: #b9d7c3; background: #263b30; border-radius: 5px; padding: 2px 6px; font-size: 11px; }
    .muted { color: var(--muted); }
    .retention { color: var(--amber); }
    .expired { color: var(--red); }
    .gc-eligible { color: var(--red); font-weight: 700; }
    .persistent { color: var(--green); }
    .retention-editor { position: absolute; z-index: 10; top: calc(100% + 6px); right: 0; display: flex; align-items: center; gap: 6px; padding: 8px; background: #1d2924; border: 1px solid #4c8061; border-radius: 8px; box-shadow: 0 10px 24px rgba(0, 0, 0, .35); white-space: nowrap; }
    .retention-editor input { width: 82px; }
    .file-row td { padding: 6px 10px 10px 52px; color: var(--muted); background: #121817; }
    .file-list { display: grid; gap: 4px; }
    .file-item { display: flex; gap: 10px; align-items: baseline; }
    .file-kind { width: 62px; color: var(--green); font-size: 11px; text-transform: uppercase; }
    .file-key { word-break: break-all; }
    .form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 14px; }
    .full { grid-column: 1 / -1; }
    .rule-editor { border: 1px solid #426053; background: linear-gradient(145deg, #192522, #141b1a); border-radius: 14px; padding: 18px; margin-bottom: 18px; }
    .rule-editor-head, .rule-block-head, .rule-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
    .rule-editor-head { border-bottom: 1px solid var(--line); padding-bottom: 14px; margin-bottom: 16px; }
    .rule-block { border: 1px solid var(--line); background: rgba(11, 16, 15, .38); border-radius: 12px; padding: 15px; margin-top: 12px; }
    .rule-block-head { margin-bottom: 12px; }
    .rule-block-head h3 { display: inline; margin-left: 8px; }
    .rule-block-head p { color: var(--muted); margin: 3px 0 0 30px; font-size: 12px; }
    .step-index { display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; background: #2e6e50; color: #e9fff0; font-size: 12px; font-weight: 800; }
    .condition-list { display: grid; gap: 8px; }
    .condition-row { display: grid; grid-template-columns: minmax(150px, 1.1fr) minmax(100px, .8fr) minmax(150px, 1.45fr) minmax(120px, 1fr) auto auto; align-items: center; gap: 8px; }
    .condition-row input, .condition-row select, .group-row input, .group-row select, .action-card input { min-width: 0; }
    select { width: 100%; color: var(--text); background: #0f1212; border: 1px solid var(--line); border-radius: 9px; padding: 9px 10px; outline: none; }
    select:focus { border-color: var(--green-2); }
    .field-pair { display: flex; gap: 6px; min-width: 0; }
    .field-pair select { flex: 1 1 auto; }
    .field-pair input { flex: 0 1 110px; }
    .not-toggle, .action-toggle { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; white-space: nowrap; }
    .not-toggle input, .action-toggle input { width: auto; accent-color: var(--green-2); }
    .empty-rule { color: var(--muted); border: 1px dashed var(--line); border-radius: 8px; padding: 12px; text-align: center; font-size: 12px; }
    .group-list { display: flex; flex-wrap: wrap; gap: 8px; }
    .group-row { display: flex; align-items: center; gap: 6px; background: #20362d; border: 1px solid #39654e; border-radius: 9px; padding: 5px; }
    .group-row select, .group-row input { width: auto; padding: 6px 8px; }
    .group-row input { max-width: 120px; }
    .group-row .button { border: 0; padding: 5px 7px; }
    .action-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    .action-card { border: 1px solid var(--line); border-radius: 10px; padding: 13px; background: rgba(23, 27, 27, .62); }
    .action-card.disabled { opacity: .58; }
    .action-card p { color: var(--muted); margin: 8px 0 0; font-size: 12px; }
    .action-input { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
    .action-input input { width: 110px; }
    .unit { color: var(--muted); font-size: 12px; }
    .rule-preview { color: #c8e7d0; background: #12251b; border: 1px solid #2f6b4c; border-radius: 9px; padding: 11px 13px; margin-top: 14px; font-size: 13px; }
    .policy-list { display: grid; gap: 10px; margin-top: 18px; }
    .policy-item { border: 1px solid var(--line); background: var(--panel-2); border-radius: 11px; padding: 14px; }
    .policy-item p { color: var(--muted); margin: 5px 0 0; font-size: 12px; }
    .policy-name { color: var(--green); font-weight: 750; font-size: 15px; }
    .policy-rule { color: #d7e5dc; font-size: 13px; margin-top: 10px; line-height: 1.55; }
    .policy-badges { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px; }
    .policy-badge { color: #b9d7c3; background: #263b30; border-radius: 999px; padding: 3px 8px; font-size: 11px; }
    .policy-badge.action { color: #f5d999; background: #463b22; }
    @media (max-width: 1000px) { .stats { grid-template-columns: repeat(3, 1fr); } }
    @media (max-width: 900px) { .condition-row { grid-template-columns: repeat(2, minmax(0, 1fr)); } .condition-row .not-toggle { justify-self: start; } }
    @media (max-width: 900px) { .publisher-grid { grid-template-columns: 1fr; } .publisher-card.wide { grid-column: auto; } }
    @media (max-width: 620px) { main { padding: 24px 14px; } .topbar { display: block; } .top-actions { justify-content: flex-start; margin-top: 14px; } .connected { display: inline-block; } .stats { grid-template-columns: repeat(2, 1fr); } .form-grid, .action-grid { grid-template-columns: 1fr; } .full { grid-column: auto; } .rule-editor-head, .rule-block-head, .rule-card-head { display: block; } .rule-editor-head .actions, .rule-block-head .actions, .rule-card-head .actions { margin-top: 10px; } .condition-row { grid-template-columns: 1fr; } .field-pair { display: grid; grid-template-columns: 1fr 1fr; } .publisher-code { margin-left: 0; } .publisher-card p { margin-left: 0; } }
  </style>
</head>
<body>
  <section class="login-view" id="loginPanel">
    <div class="login-card">
      <div class="brand">NIX CACHE WORKER</div>
      <h1>Operations console</h1>
      <p class="lead">Manage packages, build versions, files, retention, and garbage collection.</p>
      <div class="field"><label for="token">Admin token</label><input id="token" type="password" autocomplete="off" placeholder="Enter the Worker admin token"></div>
      <button class="button primary" id="login" type="button">Open console</button>
      <p class="message" id="loginMessage" aria-live="polite"></p>
      <p class="subtle">The token is kept in this browser tab until the tab is closed.</p>
    </div>
    ${footer}
  </section>

  <div class="shell hidden" id="appShell">
    <main>
      <header class="topbar"><div><h1>Nix Cache Admin</h1></div><div class="top-actions"><nav class="admin-nav" aria-label="Admin sections"><a class="button small" href="#packages">Packages</a><a class="button small" href="#policies">Retention</a><a class="button small" href="#publishing">Publishing</a></nav><div class="connected">Connected</div></div></header>
      <section class="stats" aria-label="Cache overview">
        <div class="stat"><div class="stat-label">Packages</div><div class="stat-value" id="statPackages">—</div></div>
        <div class="stat"><div class="stat-label">Versions</div><div class="stat-value" id="statVersions">—</div></div>
        <div class="stat"><div class="stat-label">Pinned versions</div><div class="stat-value" id="statPinned">—</div></div>
        <div class="stat"><div class="stat-label">Cache objects</div><div class="stat-value" id="statObjects">—</div></div>
        <div class="stat"><div class="stat-label">Indexed bytes</div><div class="stat-value" id="statBytes">—</div></div>
      </section>

      <section class="panel" id="packages">
        <div class="panel-head"><div><h2>Packages and versions</h2><p class="subtle">Every action below targets a build version. Package rows are grouping and inspection only.</p></div><div class="toolbar"><input id="query" placeholder="Search package, version, or tags"><button class="button toggle active" id="groupTags" type="button" aria-pressed="true">Group by tags</button><button class="button" id="refresh" type="button">Refresh</button><button class="button primary" id="gc" type="button">Run GC</button></div></div>
        <p class="message" id="message" aria-live="polite"></p>
        <div class="table-wrap"><table><thead><tr><th>Package / version</th><th>Tags</th><th>Files</th><th>Bytes</th><th>Registered</th><th>Retention</th><th>Actions</th></tr></thead><tbody id="packagesBody"></tbody></table></div>
      </section>

      <section class="panel" id="policies">
        <div class="panel-head"><div><h2>Retention rules</h2><p class="subtle">Build readable where / group by / action rules for automatic garbage collection.</p></div><button class="button primary" id="togglePolicyEditor" type="button">Create rule</button></div>
        <div class="rule-editor hidden" id="policyEditor">
          <div class="rule-editor-head"><div><div class="eyebrow">Rule builder</div><h3 id="policyEditorTitle">Create retention rule</h3><p class="subtle">Conditions are combined with AND. Grouping controls where newest versions are counted.</p></div><button class="button" id="cancelPolicy" type="button">Close</button></div>
          <div class="field full"><label for="policy_name">Rule name</label><input id="policy_name" placeholder="stable-linux-builds"></div>

          <div class="rule-block">
            <div class="rule-block-head"><div><span class="step-index">1</span><h3>When versions match</h3><p>Add conditions only when the rule should be narrower than all versions.</p></div><button class="button small" id="addCondition" type="button">＋ Add condition</button></div>
            <div class="condition-list" id="conditionList"></div>
            <div class="empty-rule" id="conditionEmpty">All active versions match this rule.</div>
          </div>

          <div class="rule-block">
            <div class="rule-block-head"><div><span class="step-index">2</span><h3>Group newest versions by</h3><p>lastN is calculated independently for each group. Leave empty for one global group.</p></div><button class="button small" id="addGroupBy" type="button">＋ Add field</button></div>
            <div class="group-list" id="groupByList"></div>
            <div class="empty-rule" id="groupByEmpty">One group containing every matching version.</div>
          </div>

          <div class="rule-block">
            <div class="rule-block-head"><div><span class="step-index">3</span><h3>Set retention actions</h3><p>Enable any combination. Priority is left to right: earlier actions take precedence over later ones. Pins always override automatic GC.</p></div></div>
            <div class="action-grid">
              <div class="action-card" id="lastNCard"><label class="action-toggle"><input id="enableLastN" type="checkbox"> Keep newest versions</label><div class="action-input"><input id="policy_last_n" type="number" min="0" placeholder="3" disabled><span class="unit">versions per group</span></div><p>Protected versions are never removed by automatic GC.</p></div>
              <div class="action-card" id="capacityCard"><label class="action-toggle"><input id="enableCapacity" type="checkbox"> Allow up to</label><div class="action-input"><input id="policy_capacity" type="number" min="0" placeholder="20" disabled><span class="unit">versions per group</span></div><p>Over-capacity versions may be removed before the duration expires.</p></div>
              <div class="action-card" id="durationCard"><label class="action-toggle"><input id="enableDuration" type="checkbox"> Retain older versions for</label><div class="action-input"><input id="policy_duration" type="number" min="0" placeholder="" disabled><span class="unit">days</span></div><p>Older unprotected versions become eligible after this age.</p></div>
            </div>
          </div>
          <div class="rule-preview" id="policyPreview">Configure an action to preview this rule.</div>
          <div class="form-actions" style="margin-top:14px"><button class="button primary" id="savePolicy" type="button">Create rule</button><button class="button" id="cancelPolicyBottom" type="button">Cancel</button></div>
        </div>
        <div class="policy-list" id="policyList"></div>
      </section>

      <section class="panel" id="settings"><div class="panel-head"><div><h2>Deployment settings</h2><p class="subtle">Cache-info values and default retention are deployment environment variables. Change them with Wrangler and redeploy.</p></div></div></section>
      <section class="panel publisher-panel" id="publishing">
        <div class="panel-head"><div><div class="eyebrow">For publishers</div><h2>CI publishing</h2><p class="subtle">Publish build outputs with the bundled staging direct-upload client. Keep the write token in your CI secret store.</p></div><span class="connected">Write access</span></div>
        <div class="publisher-grid">
          <article class="publisher-card"><span class="publisher-step">1</span><h3>Provide netrc credentials</h3><p>Create a mode-0600 netrc entry in the CI job. The password is the Worker write token and must never be committed.</p><pre class="publisher-code">machine ${origin.replace(/^https?:\/\//, "")} login nix password &lt;WRITE_TOKEN&gt;</pre></article>
          <article class="publisher-card"><span class="publisher-step">2</span><h3>Upload through staging</h3><p>Use <code>bin/nix-cache-upload</code>; NAR payloads must use staging direct upload and cannot be sent with ordinary Worker PUT.</p><pre class="publisher-code">NIX_CACHE_WRITE_TOKEN=&lt;WRITE_TOKEN&gt; bin/nix-cache-upload --to ${origin} --package acme --version ci-123 ./result</pre></article>
          <article class="publisher-card wide"><span class="publisher-step">3</span><h3>Register the build version</h3><p>After uploading NARs and narinfos, send the complete version declaration. <code>narinfoKeys</code> lists uploaded narinfo keys, while <code>tags</code> and <code>retentionDays</code> are optional metadata.</p><pre class="publisher-code">curl -X PUT "${origin}/api/packages/acme/versions/2026.08.18" \
  -H "Authorization: Bearer $WRITE_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "narinfoKeys": ["abc123.narinfo"],
    "tags": { "channel": "stable", "system": "x86_64-linux" },
    "retentionDays": 30
  }'</pre><p>Registration is idempotent. It is a complete declaration: omitted members and tags are removed from that version.</p></article>
        </div>
      </section>
      ${footer}
    </main>
  </div>

  <script>
    const tokenStorageKey = "nix-cache-worker.admin-token";
    let token = "";
    let editingPolicyId = null;
    let packagesData = null;
    let groupByTags = true;
    const $ = (id) => document.getElementById(id);
    const setMessage = (text, type = "") => { const el = $("message"); el.textContent = text; el.className = "message" + (type ? " " + type : ""); };
    const setLoginMessage = (text, type = "") => { const el = $("loginMessage"); el.textContent = text; el.className = "message" + (type ? " " + type : ""); };
    const formatBytes = (value) => { const bytes = Number(value) || 0; if (bytes < 1024) return bytes + " B"; const units = ["KB", "MB", "GB", "TB"]; let size = bytes; let index = -1; do { size /= 1024; index += 1; } while (size >= 1024 && index < units.length - 1); return size.toFixed(size >= 10 ? 0 : 1) + " " + units[index]; };
    const formatDate = (value) => { try { return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(value)); } catch { return value || "—"; } };
    const formatDaysLeft = (value) => value + (value === 1 ? " day left" : " days left");
    const formatRetentionRemaining = (value) => { const seconds = Number(value); if (!Number.isFinite(seconds)) return ""; if (seconds < 0) return "Expired"; if (seconds >= 86400) return formatDaysLeft(Math.ceil(seconds / 86400)); if (seconds >= 3600) return Math.ceil(seconds / 3600) + (Math.ceil(seconds / 3600) === 1 ? " hour left" : " hours left"); if (seconds >= 60) return Math.ceil(seconds / 60) + (Math.ceil(seconds / 60) === 1 ? " minute left" : " minutes left"); return seconds + (seconds === 1 ? " second left" : " seconds left"); };
    const optionalNumber = (value) => value === "" ? null : Number(value);
    function readStoredToken() { try { return window.sessionStorage.getItem(tokenStorageKey) || ""; } catch { return ""; } }
    function storeToken(value) { try { window.sessionStorage.setItem(tokenStorageKey, value); } catch {} }
    function clearStoredToken() { try { window.sessionStorage.removeItem(tokenStorageKey); } catch {} }
    async function api(path, options = {}) { const headers = new Headers(options.headers || {}); headers.set("Authorization", "Bearer " + token); if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json"); const response = await fetch(path, { ...options, headers }); const text = await response.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; } if (!response.ok) throw new Error(data?.error?.message || response.statusText); return data; }
    const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    async function waitForJob(jobId) { for (let attempt = 0; attempt < 20; attempt += 1) { await delay(1000); const job = await api("/api/admin/jobs/" + encodeURIComponent(jobId)); if (job.status === "completed") return job; if (job.status === "failed") throw new Error(job.last_error || "GC job failed"); } return null; }
    function tagsNode(tags) { const list = document.createElement("div"); list.className = "tag-list"; const entries = Object.entries(tags || {}); if (!entries.length) { const empty = document.createElement("span"); empty.className = "muted"; empty.textContent = "No tags"; list.append(empty); } for (const [key, value] of entries) { const tag = document.createElement("span"); tag.className = "tag"; tag.textContent = key + "=" + value; list.append(tag); } return list; }
    function button(label, className, onClick) { const item = document.createElement("button"); item.type = "button"; item.className = "button small " + (className || ""); item.textContent = label; item.onclick = onClick; return item; }
    function cell(value = "—") { const item = document.createElement("td"); item.textContent = value; return item; }
    async function toggleFiles(detailRow, packageName, versionName, toggle) {
      const opening = toggle.textContent === "＋";
      if (!opening) { detailRow.classList.add("hidden"); toggle.textContent = "＋"; return; }
      const td = detailRow.firstElementChild;
      detailRow.classList.remove("hidden");
      if (detailRow.dataset.loaded === "true") { toggle.textContent = "−"; return; }
      toggle.disabled = true;
      toggle.textContent = "…";
      td.textContent = "Loading files…";
      try {
        const data = await api("/api/admin/packages/" + encodeURIComponent(packageName) + "/versions/" + encodeURIComponent(versionName));
        td.replaceChildren();
        const list = document.createElement("div");
        list.className = "file-list";
        for (const file of data.files || []) {
          const item = document.createElement("div");
          item.className = "file-item";
          const kind = document.createElement("span");
          kind.className = "file-kind";
          kind.textContent = file.kind;
          const key = document.createElement("span");
          key.className = "file-key";
          key.textContent = file.key + " · " + formatBytes(file.size) + " · " + (file.state || "missing");
          item.append(kind, key);
          list.append(item);
        }
        if (!list.children.length) list.textContent = "No files";
        td.append(list);
        detailRow.dataset.loaded = "true";
        toggle.textContent = "−";
      } catch (error) {
        detailRow.classList.add("hidden");
        toggle.textContent = "＋";
        setMessage(error.message, "error");
      } finally {
        toggle.disabled = false;
      }
    }
    function sortedTagEntries(tags) { return Object.entries(tags || {}).sort(([left], [right]) => left.localeCompare(right)); }
    function tagGroupKey(tags) { return JSON.stringify(sortedTagEntries(tags)); }
    function tagGroupLabel(tags) {
      const entries = sortedTagEntries(tags);
      return entries.length ? entries.map(([key, value]) => key + "=" + String(value)).join(", ") : "No tags";
    }
    function renderPackages(data) {
      const body = $("packagesBody");
      body.replaceChildren();
      const items = data.items || [];
      if (!items.length) {
        const row = document.createElement("tr");
        const empty = document.createElement("td");
        empty.colSpan = 7;
        empty.className = "muted";
        empty.textContent = "No packages or versions found.";
        row.append(empty);
        body.append(row);
        return;
      }
      for (const [packageIndex, packageItem] of items.entries()) {
        const packageClass = "package-child-" + packageIndex;
        const packageRow = document.createElement("tr");
        packageRow.className = "package-row";
        const packageCell = document.createElement("td");
        const expand = button("＋", "", () => {
          const opening = expand.textContent === "＋";
          if (!opening) {
            for (const child of body.querySelectorAll("." + packageClass)) child.classList.add("hidden");
            for (const toggle of body.querySelectorAll("." + packageClass + " .group-toggle, ." + packageClass + " .version-toggle")) toggle.textContent = "＋";
          } else {
            for (const child of body.querySelectorAll("." + packageClass)) {
              const visible = (!groupByTags && child.classList.contains("version-row")) || (groupByTags && child.classList.contains("tag-group-row"));
              child.classList.toggle("hidden", !visible);
            }
          }
          expand.textContent = opening ? "−" : "＋";
        });
        packageCell.append(expand);
        const packageName = document.createElement("span");
        packageName.className = "package-name";
        packageName.textContent = " " + packageItem.packageName;
        packageCell.append(packageName);
        packageRow.append(packageCell, cell(packageItem.versionCount + " versions"), cell(""), cell(formatBytes(packageItem.bytes)), cell(""), cell(""), cell(""));
        body.append(packageRow);

        const appendVersion = (version, groupClass = "") => {
          const childClasses = [packageClass];
          if (groupClass) childClasses.push(groupClass);
          const versionRow = document.createElement("tr");
          versionRow.className = "version-row " + childClasses.join(" ") + " hidden";
          const nameCell = document.createElement("td");
          let detailRow;
          const versionToggle = button("＋", "version-toggle", () => toggleFiles(detailRow, packageItem.packageName, version.versionName, versionToggle));
          nameCell.append(versionToggle);
          const versionName = document.createElement("span");
          versionName.className = "version-name";
          versionName.textContent = " " + version.versionName;
          nameCell.append(versionName);
          const tags = document.createElement("td");
          tags.append(tagsNode(version.tags));
          versionRow.append(nameCell, tags, cell(String(version.fileCount)), cell(formatBytes(version.bytes)), cell(formatDate(version.registeredAt)));
          const retention = document.createElement("td");
          const capacityExceeded = version.capacityExceeded === true;
          const durationExpired = version.retentionRemainingSeconds !== null
            && version.retentionRemainingSeconds !== undefined
            && Number(version.retentionRemainingSeconds) < 0;
          retention.className = version.retentionState === "persistent" ? "persistent" : (capacityExceeded || durationExpired ? "gc-eligible" : "retention");
          retention.textContent = version.retentionState;
          if (version.retentionRemainingSeconds !== null && version.retentionRemainingSeconds !== undefined) {
            const remainingSeconds = Number(version.retentionRemainingSeconds);
            const remaining = document.createElement("span");
            remaining.className = remainingSeconds < 0 ? "expired" : "";
            remaining.textContent = formatRetentionRemaining(remainingSeconds);
            retention.append(document.createElement("br"), remaining);
          } else if (version.retentionRemainingDays !== null && version.retentionRemainingDays !== undefined) {
            retention.append(document.createElement("br"), document.createTextNode(formatDaysLeft(version.retentionRemainingDays)));
          }
          if (capacityExceeded) {
            const capacityNotice = document.createElement("span");
            capacityNotice.className = "gc-eligible";
            capacityNotice.textContent = "GC eligible · capacity exceeded";
            retention.append(document.createElement("br"), capacityNotice);
          }
          versionRow.append(retention);
          const actions = document.createElement("td");
          actions.className = "actions";
          const extendButton = button("Extend", "", () => {
            const editor = document.createElement("span");
            editor.className = "retention-editor";
            const retentionInput = document.createElement("input");
            retentionInput.type = "number";
            retentionInput.min = "0";
            retentionInput.placeholder = "days";
            retentionInput.value = version.retentionDays == null ? "" : String(version.retentionDays);
            const restore = () => actions.replaceChild(extendButton, editor);
            const confirm = button("Confirm", "primary", async () => {
              confirm.disabled = true;
              try {
                await api("/api/admin/packages/" + encodeURIComponent(packageItem.packageName) + "/versions/" + encodeURIComponent(version.versionName), { method: "PATCH", body: JSON.stringify({ retentionDays: optionalNumber(retentionInput.value) }) });
                setMessage("Updated " + packageItem.packageName + " / " + version.versionName, "success");
                await load();
              } catch (error) {
                confirm.disabled = false;
                setMessage(error.message, "error");
              }
            });
            const cancel = button("Cancel", "", restore);
            editor.append(retentionInput, confirm, cancel);
            actions.replaceChild(editor, extendButton);
            retentionInput.focus();
          });
          actions.append(extendButton);
          actions.append(button(version.pinned ? "Unpin" : "Pin", "", async () => {
            try {
              await api("/api/admin/packages/" + encodeURIComponent(packageItem.packageName) + "/versions/" + encodeURIComponent(version.versionName) + "/pin", { method: version.pinned ? "DELETE" : "PUT" });
              setMessage((version.pinned ? "Unpinned " : "Pinned ") + version.versionName, "success");
              await load();
            } catch (error) {
              setMessage(error.message, "error");
            }
          }));
          actions.append(button("Delete", "danger", async () => {
            const target = packageItem.packageName + " / " + version.versionName;
            if (!confirm("Delete version " + target + "?")) return;
            const reason = prompt("Deletion reason", "manual cleanup");
            if (!reason) return;
            try {
              const result = await api("/api/admin/packages/" + encodeURIComponent(packageItem.packageName) + "/versions/" + encodeURIComponent(version.versionName), { method: "DELETE", body: JSON.stringify({ confirmPackageName: packageItem.packageName, confirmVersionName: version.versionName, reason }) });
              setMessage("Delete job queued · " + result.jobId, "success");
            } catch (error) {
              setMessage(error.message, "error");
            }
          }));
          versionRow.append(actions);
          body.append(versionRow);
          detailRow = document.createElement("tr");
          detailRow.className = "file-row " + childClasses.join(" ") + " hidden";
          const detailCell = document.createElement("td");
          detailCell.colSpan = 7;
          detailCell.textContent = "Loading files…";
          detailRow.append(detailCell);
          body.append(detailRow);
        };

        if (groupByTags) {
          const groups = new Map();
          for (const version of packageItem.versions || []) {
            const label = tagGroupLabel(version.tags);
            const groupKey = tagGroupKey(version.tags);
            const group = groups.get(groupKey);
            if (group) group.versions.push(version);
            else groups.set(groupKey, { label, versions: [version] });
          }
          for (const [groupIndex, group] of Array.from(groups.values()).entries()) {
            const groupClass = "tag-child-" + packageIndex + "-" + groupIndex;
            const groupRow = document.createElement("tr");
            groupRow.className = "tag-group-row " + packageClass + " hidden";
            const groupCell = document.createElement("td");
            const groupExpand = button("＋", "group-toggle", () => {
              const opening = groupExpand.textContent === "＋";
              for (const child of body.querySelectorAll("." + groupClass)) {
                if (opening && child.classList.contains("version-row")) child.classList.remove("hidden");
                else if (!opening) child.classList.add("hidden");
              }
              if (!opening) for (const toggle of body.querySelectorAll("." + groupClass + " .version-toggle")) toggle.textContent = "＋";
              groupExpand.textContent = opening ? "−" : "＋";
            });
            groupCell.append(groupExpand);
            const groupName = document.createElement("span");
            groupName.className = "tag-group-name";
            groupName.textContent = " " + group.label;
            groupCell.append(groupName);
            groupRow.append(groupCell, cell(group.versions.length + " versions"), cell(""), cell(""), cell(""), cell(""), cell(""));
            body.append(groupRow);
            for (const version of group.versions) appendVersion(version, groupClass);
          }
        } else {
          for (const version of packageItem.versions || []) appendVersion(version);
        }
      }
    }
    const fieldOptions = [
      ["pkg_name", "Package name"],
      ["pkg_version", "Package version"],
      ["pkg_tags", "All tags"],
      ["__tag__", "A specific tag value…"],
    ];
    const operatorOptions = [["equals", "equals"], ["starts_with", "starts with"], ["ends_with", "ends with"], ["contains", "contains"]];
    let policyDraft = { conditions: [], groupBy: ["pkg_name"], lastN: null, durationDays: null, capacityVersions: null };

    function renderStats(overview) { $("statPackages").textContent = String(overview.packages || 0); $("statVersions").textContent = String(overview.versions || 0); $("statPinned").textContent = String(overview.pinnedVersions || 0); $("statObjects").textContent = String(overview.cacheObjects || 0); $("statBytes").textContent = formatBytes(overview.indexedBytes); }
    function normalizeCondition(condition) { return { field: condition.field || "pkg_name", operator: condition.operator || "equals", value: condition.value || "", negate: condition.negate === true }; }
    function normalizePolicy(policy) { return { id: policy.id, name: policy.name, conditions: (policy.conditions || []).map(normalizeCondition), groupBy: [...(policy.groupBy || [])], lastN: policy.lastN ?? null, durationDays: policy.durationDays ?? null, capacityVersions: policy.capacityVersions ?? null }; }
    function optionSelect(options, value, className) { const select = document.createElement("select"); if (className) select.className = className; for (const [optionValue, label] of options) { const option = document.createElement("option"); option.value = optionValue; option.textContent = label; option.selected = optionValue === value; select.append(option); } return select; }
    function fieldLabel(field) { if (field === "pkg_name") return "package name"; if (field === "pkg_version") return "package version"; if (field === "pkg_tags") return "all tags"; return "tag " + field.slice("pkg_tag:".length); }
    function operatorLabel(operator) { return ({ equals: "equals", starts_with: "starts with", ends_with: "ends with", contains: "contains" })[operator] || operator; }
    function fieldMode(field) { return field && field.startsWith("pkg_tag:") ? "__tag__" : field; }
    function fieldTagKey(field) { return field && field.startsWith("pkg_tag:") ? field.slice("pkg_tag:".length) : ""; }
    function wireFieldPair(parent, field, onChange) {
      const pair = document.createElement("div");
      pair.className = "field-pair";
      const select = optionSelect(fieldOptions, fieldMode(field), "field-kind");
      const tagKey = document.createElement("input");
      tagKey.className = "tag-key";
      tagKey.placeholder = "tag key";
      tagKey.value = fieldTagKey(field);
      tagKey.maxLength = 64;
      const update = () => { tagKey.classList.toggle("hidden", select.value !== "__tag__"); if (onChange) onChange(); };
      select.onchange = update;
      tagKey.oninput = () => { if (onChange) onChange(); };
      pair.append(select, tagKey);
      parent.append(pair);
      update();
      return pair;
    }
    function readField(pair) { const select = pair.querySelector(".field-kind"); if (!select) return "pkg_name"; if (select.value !== "__tag__") return select.value; const key = pair.querySelector(".tag-key")?.value.trim() || ""; return key ? "pkg_tag:" + key : "pkg_tag:"; }
    function renderConditionRows() {
      const list = $("conditionList");
      list.replaceChildren();
      for (const [index, condition] of policyDraft.conditions.entries()) {
        const row = document.createElement("div");
        row.className = "condition-row";
        wireFieldPair(row, condition.field, renderRulePreview);
        row.append(optionSelect(operatorOptions, condition.operator, "condition-operator"));
        const value = document.createElement("input");
        value.className = "condition-value";
        value.placeholder = "Value";
        value.value = condition.value;
        value.maxLength = 256;
        value.oninput = renderRulePreview;
        row.append(value);
        const not = document.createElement("label");
        not.className = "not-toggle";
        const notInput = document.createElement("input");
        notInput.type = "checkbox";
        notInput.className = "condition-negate";
        notInput.checked = condition.negate;
        notInput.onchange = renderRulePreview;
        not.append(notInput, document.createTextNode("NOT"));
        row.append(not);
        row.append(button("Remove", "danger", () => { policyDraft = readPolicyDraft(); policyDraft.conditions.splice(index, 1); renderConditionRows(); renderRulePreview(); }));
        list.append(row);
      }
      $("conditionEmpty").classList.toggle("hidden", policyDraft.conditions.length > 0);
    }
    function renderGroupByRows() {
      const list = $("groupByList");
      list.replaceChildren();
      for (const [index, field] of policyDraft.groupBy.entries()) {
        const row = document.createElement("div");
        row.className = "group-row";
        wireFieldPair(row, field, renderRulePreview);
        row.append(button("×", "danger", () => { policyDraft = readPolicyDraft(); policyDraft.groupBy.splice(index, 1); renderGroupByRows(); renderRulePreview(); }));
        list.append(row);
      }
      $("groupByEmpty").classList.toggle("hidden", policyDraft.groupBy.length > 0);
    }
    function readPolicyDraft() {
      const conditions = [...document.querySelectorAll("#conditionList .condition-row")].map((row) => ({
        field: readField(row.querySelector(".field-pair")),
        operator: row.querySelector(".condition-operator")?.value || "equals",
        value: row.querySelector(".condition-value")?.value || "",
        negate: Boolean(row.querySelector(".condition-negate")?.checked),
      }));
      const groupBy = [...document.querySelectorAll("#groupByList .field-pair")].map((pair) => readField(pair));
      return {
        conditions,
        groupBy,
        lastN: $("enableLastN").checked ? optionalNumber($("policy_last_n").value) : null,
        durationDays: $("enableDuration").checked ? optionalNumber($("policy_duration").value) : null,
        capacityVersions: $("enableCapacity").checked ? optionalNumber($("policy_capacity").value) : null,
      };
    }
    function setDurationDefault(value) {
      const defaultValue = String(value ?? "").trim() || "7";
      $("policy_duration").placeholder = defaultValue;
    }
    function updateActionCards() {
      const lastNEnabled = $("enableLastN").checked;
      const durationEnabled = $("enableDuration").checked;
      const capacityEnabled = $("enableCapacity").checked;
      $("policy_last_n").disabled = !lastNEnabled;
      $("policy_duration").disabled = !durationEnabled;
      $("policy_capacity").disabled = !capacityEnabled;
      if (durationEnabled && !$("policy_duration").value) $("policy_duration").value = $("policy_duration").placeholder;
      $("lastNCard").classList.toggle("disabled", !lastNEnabled);
      $("durationCard").classList.toggle("disabled", !durationEnabled);
      $("capacityCard").classList.toggle("disabled", !capacityEnabled);
      renderRulePreview();
    }
    function renderRulePreview() {
      const draft = readPolicyDraft();
      const where = draft.conditions.length ? draft.conditions.map((condition) => (condition.negate ? "NOT " : "") + fieldLabel(condition.field) + " " + operatorLabel(condition.operator) + " ‘" + (condition.value || "…") + "’").join(" AND ") : "all active versions";
      const group = draft.groupBy.length ? draft.groupBy.map(fieldLabel).join(" + ") : "one global group";
      const actions = [];
      if (draft.lastN !== null) actions.push("keep newest " + draft.lastN + " per group");
      if (draft.durationDays !== null) actions.push("retain others " + draft.durationDays + " days");
      if (draft.capacityVersions !== null) actions.push("allow up to " + draft.capacityVersions + " versions per group");
      $("policyPreview").textContent = actions.length ? "WHEN " + where + " · GROUP BY " + group + " · " + actions.join(" · ") : "Configure an action to preview this rule.";
    }
    function fillActionInputs(draft) {
      $("enableLastN").checked = draft.lastN !== null;
      $("policy_last_n").value = draft.lastN === null ? "" : String(draft.lastN);
      $("enableDuration").checked = draft.durationDays !== null;
      $("policy_duration").value = draft.durationDays === null ? "" : String(draft.durationDays);
      $("enableCapacity").checked = draft.capacityVersions !== null;
      $("policy_capacity").value = draft.capacityVersions === null ? "" : String(draft.capacityVersions);
      updateActionCards();
    }
    function openPolicyEditor(policy = null) {
      editingPolicyId = policy?.id ?? null;
      policyDraft = policy ? normalizePolicy(policy) : { conditions: [], groupBy: ["pkg_name"], lastN: null, durationDays: null, capacityVersions: null };
      $("policy_name").value = policy?.name || "";
      $("policyEditorTitle").textContent = policy ? "Edit retention rule" : "Create retention rule";
      $("savePolicy").textContent = policy ? "Save rule" : "Create rule";
      $("policyEditor").classList.remove("hidden");
      $("togglePolicyEditor").classList.add("hidden");
      renderConditionRows();
      renderGroupByRows();
      fillActionInputs(policyDraft);
      renderRulePreview();
      $("policy_name").focus();
    }
    function closePolicyEditor() { editingPolicyId = null; $("policyEditor").classList.add("hidden"); $("togglePolicyEditor").classList.remove("hidden"); }
    function policySummary(policy) {
      const where = policy.conditions.length ? policy.conditions.map((condition) => (condition.negate ? "NOT " : "") + fieldLabel(condition.field) + " " + operatorLabel(condition.operator) + " ‘" + condition.value + "’").join(" AND ") : "all active versions";
      const group = policy.groupBy.length ? policy.groupBy.map(fieldLabel).join(" + ") : "one global group";
      return "WHEN " + where + " · GROUP BY " + group;
    }
    function renderPolicies(data) {
      const list = $("policyList");
      list.replaceChildren();
      const policies = (data.items || []).map(normalizePolicy);
      if (!policies.length) { list.textContent = "No retention rules configured. Retention falls back to the configured duration."; return; }
      for (const policy of policies) {
        const item = document.createElement("div");
        item.className = "policy-item";
        const head = document.createElement("div");
        head.className = "rule-card-head";
        const copy = document.createElement("div");
        const name = document.createElement("div");
        name.className = "policy-name";
        name.textContent = policy.name;
        const details = document.createElement("p");
        details.textContent = "Conditions are evaluated against active package versions.";
        copy.append(name, details);
        const actions = document.createElement("div");
        actions.className = "actions";
        actions.append(button("Edit", "", () => openPolicyEditor(policy)));
        actions.append(button("Delete", "danger", async () => { if (!confirm("Delete rule " + policy.name + "?")) return; try { await api("/api/admin/policies/" + policy.id, { method: "DELETE" }); setMessage("Deleted rule " + policy.name, "success"); await load(); } catch (error) { setMessage(error.message, "error"); } }));
        head.append(copy, actions);
        item.append(head);
        const summary = document.createElement("div");
        summary.className = "policy-rule";
        summary.textContent = policySummary(policy);
        item.append(summary);
        const badges = document.createElement("div");
        badges.className = "policy-badges";
        if (policy.lastN !== null) { const badge = document.createElement("span"); badge.className = "policy-badge action"; badge.textContent = "Keep newest " + policy.lastN; badges.append(badge); }
        if (policy.durationDays !== null) { const badge = document.createElement("span"); badge.className = "policy-badge action"; badge.textContent = "Retain " + policy.durationDays + " days"; badges.append(badge); }
        if (policy.capacityVersions !== null) { const badge = document.createElement("span"); badge.className = "policy-badge action"; badge.textContent = "Capacity " + policy.capacityVersions + " / group"; badges.append(badge); }
        item.append(badges);
        list.append(item);
      }
    }
    async function load() { try { const [packages, overview, policies] = await Promise.all([api("/api/admin/packages?q=" + encodeURIComponent($("query").value)), api("/api/admin/overview"), api("/api/admin/policies")]); renderStats(overview); packagesData = packages; renderPackages(packages); renderPolicies(policies); setDurationDefault(String(overview.defaultRetentionDays)); setMessage("Showing " + packages.items.length + " of " + packages.total + " packages", "success"); } catch (error) { setMessage(error.message, "error"); throw error; } }
    async function openConsole(candidate) { token = candidate.trim(); if (!token) return; $("login").disabled = true; try { await api("/api/admin/overview"); storeToken(token); $("token").value = ""; $("loginPanel").classList.add("hidden"); $("appShell").classList.remove("hidden"); await load(); } catch (error) { clearStoredToken(); token = ""; $("loginPanel").classList.remove("hidden"); $("appShell").classList.add("hidden"); setLoginMessage(error.message, "error"); } finally { $("login").disabled = false; } }
    $("login").onclick = () => openConsole($("token").value);
    $("token").onkeydown = (event) => { if (event.key === "Enter") $("login").click(); };
    $("refresh").onclick = () => load(); $("query").onkeydown = (event) => { if (event.key === "Enter") load(); };
    $("gc").onclick = async () => { $("gc").disabled = true; try { const result = await api("/api/admin/gc", { method: "POST" }); setMessage((result.reused ? "GC already scheduled · " : "GC started · ") + result.jobId, "success"); const job = await waitForJob(result.jobId); if (job) { setMessage("GC scan completed · queued deletions may continue", "success"); await load(); } else setMessage("GC is still running; refresh again shortly", "success"); } catch (error) { setMessage(error.message, "error"); } finally { $("gc").disabled = false; } };
    $("savePolicy").onclick = async () => { try { const draft = readPolicyDraft(); const payload = { name: $("policy_name").value.trim(), ...draft }; await api(editingPolicyId == null ? "/api/admin/policies" : "/api/admin/policies/" + editingPolicyId, { method: editingPolicyId == null ? "POST" : "PUT", body: JSON.stringify(payload) }); closePolicyEditor(); setMessage("Retention rule saved", "success"); await load(); } catch (error) { setMessage(error.message, "error"); } };
    $("togglePolicyEditor").onclick = () => openPolicyEditor();
    $("cancelPolicy").onclick = closePolicyEditor;
    $("cancelPolicyBottom").onclick = closePolicyEditor;
    $("addCondition").onclick = () => { policyDraft = readPolicyDraft(); policyDraft.conditions.push({ field: "pkg_name", operator: "equals", value: "", negate: false }); renderConditionRows(); renderRulePreview(); };
    $("addGroupBy").onclick = () => { policyDraft = readPolicyDraft(); policyDraft.groupBy.push("pkg_name"); renderGroupByRows(); renderRulePreview(); };
    $("enableLastN").onchange = updateActionCards;
    $("enableDuration").onchange = updateActionCards;
    $("enableCapacity").onchange = updateActionCards;
    $("policy_last_n").oninput = renderRulePreview;
    $("policy_duration").oninput = renderRulePreview;
    $("policy_capacity").oninput = renderRulePreview;
    $("policy_name").oninput = renderRulePreview;
    function updateGroupToggle() { const control = $("groupTags"); control.classList.toggle("active", groupByTags); control.setAttribute("aria-pressed", String(groupByTags)); }
    $("groupTags").onclick = () => { groupByTags = !groupByTags; updateGroupToggle(); if (packagesData) renderPackages(packagesData); };
    const storedToken = readStoredToken();
    if (storedToken) { $("login").textContent = "Restoring session…"; openConsole(storedToken); }
  </script>
</body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
