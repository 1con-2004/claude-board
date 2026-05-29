/* ---- Session Card 渲染 ---- */
(function (root) {

  function ago(iso) {
    if (!iso) return "—";
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 2000) return "刚刚";
    if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
    const m = Math.floor(ms / 60000);
    if (m < 60) return `${m}m`;
    return `${m}m ${Math.floor((ms % 60000) / 1000)}s`;
  }

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function renderCard(session, opts) {
    const sc = session.status || "idle";
    const labelMap = { working: "执行中", interrupt: "等待输入", idle: "空闲", done: "已完成", waiting: "等待中" };
    const statusLabel = labelMap[sc] || sc;
    const filtered = opts && opts.activeFilter !== "all" && session.project !== opts.activeFilter;
    const displayName = session.title || `# ${session.id}`;

    const modelHtml = session.latestModel
      ? `<span class="model-tag" title="${escapeHtml(session.latestModel)}">${escapeHtml(session.latestModel)}</span>` : "";
    const projectHtml = `<span class="project-tag" title="${escapeHtml(session.project)}">${escapeHtml(session.project)}</span>`;
    const promptHtml = session.latestPrompt
      ? `<div class="card-prompt"><span class="prompt-icon">💬</span><span class="prompt-text" title="${escapeHtml(session.latestPrompt)}">${escapeHtml(session.latestPrompt)}</span></div>` : "";
    const flags = [];
    if (session.preventedContinuation) flags.push("⏸ 已暂停");
    if (session.stopReason) flags.push(`<span class="stop-reason">${escapeHtml(session.stopReason)}</span>`);
    const flagsHtml = flags.length ? `<div class="card-flags">${flags.join(" · ")}</div>` : "";

    const summaryHtml = session.summary
      ? `<div class="card-summary" title="${escapeHtml(session.summary)}">${escapeHtml(session.summary)}</div>` : "";

    return `
      <div class="card status-${sc} ${filtered ? "filtered-out" : ""}">
        <div class="card-top">
          <div class="card-title-group">
            <div class="card-title" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</div>
            <div class="card-meta">
              <span class="card-id" title="#${escapeHtml(session.id)}">#${escapeHtml(session.id)}</span>
              ${projectHtml}
              ${modelHtml}
            </div>
          </div>
          <div class="card-aside">
            <span class="activity-time">${escapeHtml(session.lastAgo || ago(session.lastActivityAt))}</span>
            <span class="status-pill ${sc}">
              <span class="pulse-dot"></span>
              ${statusLabel}
            </span>
          </div>
        </div>
        ${promptHtml}
        ${summaryHtml}
        ${flagsHtml}
      </div>
    `;
  }

  root.SessionCard = { renderCard, ago, escapeHtml };

})(typeof globalThis !== "undefined" ? globalThis : this);
