(function () {
  const {
    connectSnapshotStream,
    copyText,
    escapeHtml,
    fetchSnapshot,
    formatDateTime,
    formatNumber,
    formatShortPath,
    formatStatusLabel,
    onLanguageChange,
    setConnectionState,
    statusTone,
    t
  } = window.SkillUsageCore;

  const state = {
    snapshot: null
  };

  function monitorCard(label, value, detail, tone, options) {
    const config = options || {};
    const kindClass = config.kind ? ` ${config.kind}-card` : "";
    const showStatus = config.showStatus !== false;
    return `
      <article class="monitor-card panel-shell${kindClass}">
        <div class="monitor-card-top">
          <p class="eyebrow">${escapeHtml(label)}</p>
          ${config.copyValue ? `<button class="copy-button quiet" type="button" data-copy="${escapeHtml(config.copyValue)}">${escapeHtml(t("common.copy"))}</button>` : ""}
        </div>
        <strong class="monitor-value">${escapeHtml(value)}</strong>
        <div class="monitor-foot ${showStatus ? "" : "single-line"}">
          ${showStatus ? `<span class="status-pill ${escapeHtml(statusTone(tone))}">${escapeHtml(formatStatusLabel(tone))}</span>` : ""}
          <span>${escapeHtml(detail)}</span>
        </div>
      </article>
    `;
  }

  function bindCopyButtons() {
    document.querySelectorAll("[data-copy]").forEach(function (button) {
      button.addEventListener("click", async function () {
        const copied = await copyText(button.dataset.copy || "");
        const original = button.textContent;
        button.textContent = copied ? t("common.copied") : t("common.copyFailed");
        setTimeout(function () {
          button.textContent = original;
        }, 1200);
      });
    });
  }

  function render(snapshot) {
    state.snapshot = snapshot;
    const monitor = snapshot.monitor || {};
    const runtime = monitor.runtime || {};
    const managed = monitor.managed || {};
    const claude = monitor.claude || {};

    // Top 3 summary cards
    document.getElementById("monitor-overview").innerHTML = [
      // Card 1: Listener status
      monitorCard(
        t("monitor.cards.enabled.label"),
        managed.active ? t("monitor.cards.enabled.valueOn") : t("monitor.cards.enabled.valueOff"),
        managed.active ? t("monitor.cards.enabled.detailOn") : t("monitor.cards.enabled.detailOff"),
        managed.active ? "success" : "idle"
      ),
      // Card 2: Events count
      monitorCard(
        t("monitor.cards.events.label"),
        formatNumber(runtime.emittedEvents || 0),
        runtime.lastMatchedAt ? t("monitor.cards.events.detail", { time: formatDateTime(runtime.lastMatchedAt) }) : t("monitor.cards.events.empty"),
        runtime.lastMatchedAt ? "success" : "idle"
      ),
      // Card 3: Listener PID / recent call
      monitorCard(
        t("monitor.cards.managed.label"),
        managed.active ? `PID ${managed.pid}` : t("monitor.cards.managed.valueOff"),
        managed.active ? t("monitor.cards.managed.detailOn", { dir: formatShortPath(managed.rootDir) }) : t("monitor.cards.managed.detailOff"),
        managed.active ? "running" : "idle"
      )
    ].join("");

    // Path matrix section
    document.getElementById("monitor-matrix").innerHTML = [
      monitorCard(
        t("monitor.cards.codexHome.label"),
        formatShortPath(claude.projectsDir || ""),
        t("monitor.cards.codexHome.detail"),
        "idle",
        { copyValue: claude.projectsDir || "", showStatus: false, kind: "path" }
      ),
      monitorCard(
        t("monitor.cards.sessionsRoot.label"),
        formatShortPath(claude.skillsDir || ""),
        t("monitor.cards.sessionsRoot.detail"),
        "idle",
        { copyValue: claude.skillsDir || "", showStatus: false, kind: "path" }
      ),
      monitorCard(
        t("monitor.cards.stdout.label"),
        formatShortPath(claude.dashboardLog || ""),
        t("monitor.cards.stdout.detail"),
        "idle",
        { copyValue: claude.dashboardLog || "", showStatus: false, kind: "path" }
      ),
      monitorCard(
        t("monitor.cards.stderr.label"),
        formatShortPath(claude.monitorLog || ""),
        t("monitor.cards.stderr.detail"),
        "idle",
        { copyValue: claude.monitorLog || "", showStatus: false, kind: "path" }
      ),
      monitorCard(
        t("monitor.cards.lastMatched.label"),
        runtime.lastMatchedAt ? formatDateTime(runtime.lastMatchedAt) : t("monitor.cards.lastMatched.empty"),
        runtime.lastMatchedAt ? t("monitor.cards.lastMatched.detail", { count: formatNumber(runtime.emittedEvents || 0) }) : "",
        runtime.lastMatchedAt ? "success" : "idle"
      ),
      monitorCard(
        t("monitor.cards.currentPid.label"),
        String(monitor.currentPid || t("common.empty")),
        t("monitor.cards.currentPid.detail", { time: formatDateTime(monitor.currentStartedAt) }),
        "idle"
      )
    ].join("");

    bindCopyButtons();
  }

  fetchSnapshot("12h").then(render).catch(console.error);
  connectSnapshotStream(function () {
    fetchSnapshot("12h").then(render).catch(console.error);
  }, setConnectionState);
  onLanguageChange(function () {
    if (state.snapshot) {
      render(state.snapshot);
    }
  });
})();
