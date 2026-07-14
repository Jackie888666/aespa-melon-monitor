// ==UserScript==
// @name         aespa 8/7 Melon Global 内场回流票监控（iPad/Gear）
// @namespace    https://chatgpt.com/
// @version      1.1.2
// @description  iPad Gear Browser / Tampermonkey 兼容。只读监控 2026-08-07 aespa 首尔场（prodId=213414）的 F1-F16 内场回流票，并通过 Bark 提醒；不自动选座或下单。
// @author       OpenAI
// @homepageURL  https://github.com/Jackie888666/aespa-melon-monitor
// @supportURL   https://github.com/Jackie888666/aespa-melon-monitor/issues
// @updateURL    https://raw.githubusercontent.com/Jackie888666/aespa-melon-monitor/main/aespa-melon-global-floor-monitor.user.js
// @downloadURL  https://raw.githubusercontent.com/Jackie888666/aespa-melon-monitor/main/aespa-melon-global-floor-monitor.user.js
// @match        https://tkglobal.melon.com/performance/index.htm*
// @match        https://tkglobal.melon.com/reservation/popup/onestop.htm*
// @match        https://tkglobal.melon.com/reservation/popup/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_openInTab
// @connect      api.day.app
// ==/UserScript==

(function () {
  "use strict";

  const TARGET = Object.freeze({
    productId: "213414",
    performanceDate: "20260807",
    displayDate: "2026-08-07 19:00 KST",
    eventName: "aespa SYNK : COMPLaeXITY",
    eventUrl:
      "https://tkglobal.melon.com/performance/index.htm?langCd=EN&prodId=213414",
  });

  const API_MARKER = "/tktapi/product/block/summary.json";
  const DEFAULT_SECTIONS = Array.from({ length: 16 }, (_, index) => `F${index + 1}`);
  const MIN_INTERVAL_SECONDS = 20;
  const MAX_INTERVAL_SECONDS = 300;
  const DEFAULT_INTERVAL_SECONDS = 30;
  const SETTINGS = Object.freeze({
    barkUrl: "aespa_melon_bark_url",
    sections: "aespa_melon_floor_sections",
    interval: "aespa_melon_poll_seconds",
  });

  const pageWindow = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const nativeFetch = pageWindow.fetch ? pageWindow.fetch.bind(pageWindow) : null;
  const xhrPrototype = pageWindow.XMLHttpRequest?.prototype;
  const xhrMeta = new WeakMap();

  let lastReplayableRequest = null;
  let pollTimer = null;
  let pollInFlight = false;
  let lastAvailabilitySignature = "";
  let lastSeenAt = "尚未检查";
  let statusElement = null;
  const isPerformancePage = location.pathname.includes("/performance/");
  let currentStatus = isPerformancePage
    ? {
        tone: "waiting",
        text: "脚本已启动（尚未监控）",
        detail: "请点击购票，并进入 8 月 7 日场选座页",
      }
    : {
        tone: "waiting",
        text: "等待 Melon 余票接口",
        detail: "请正常进入 8 月 7 日场选座页",
      };

  function normalizeDigits(value) {
    return String(value ?? "").replace(/\D/g, "");
  }

  function normalizeSection(value) {
    const compact = String(value ?? "")
      .trim()
      .toUpperCase()
      .replace(/[\s_-]+/g, "");
    const match = /^F(?:LOOR)?0*(\d{1,2})$/.exec(compact);
    return match ? `F${Number(match[1])}` : compact;
  }

  function configuredSections() {
    const saved = GM_getValue(SETTINGS.sections, DEFAULT_SECTIONS.join(","));
    const values = String(saved)
      .split(",")
      .map(normalizeSection)
      .filter(Boolean);
    return new Set(values.length ? values : DEFAULT_SECTIONS);
  }

  function configuredIntervalSeconds() {
    const parsed = Number(GM_getValue(SETTINGS.interval, DEFAULT_INTERVAL_SECONDS));
    if (!Number.isFinite(parsed)) return DEFAULT_INTERVAL_SECONDS;
    return Math.min(MAX_INTERVAL_SECONDS, Math.max(MIN_INTERVAL_SECONDS, Math.round(parsed)));
  }

  function safeNow() {
    try {
      return new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Seoul",
        hour12: false,
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(new Date());
    } catch (_error) {
      return new Date().toLocaleTimeString();
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function statusColors(tone) {
    return {
      waiting: ["#5b6473", "#ffffff"],
      active: ["#126b47", "#ffffff"],
      found: ["#c81e1e", "#ffffff"],
      warning: ["#a45a00", "#ffffff"],
      error: ["#7f1d1d", "#ffffff"],
    }[tone] || ["#5b6473", "#ffffff"];
  }

  function renderStatus() {
    if (!document.body) return;
    if (!statusElement) {
      statusElement = document.createElement("div");
      statusElement.id = "aespa-melon-monitor-status";
      statusElement.setAttribute("role", "status");
      statusElement.style.cssText = [
        "position:fixed",
        "right:14px",
        "bottom:14px",
        "z-index:2147483647",
        "max-width:360px",
        "padding:11px 13px",
        "border-radius:10px",
        "box-shadow:0 8px 28px rgba(0,0,0,.25)",
        "font:13px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
        "white-space:normal",
        "pointer-events:auto",
      ].join(";");
      statusElement.addEventListener("click", (event) => {
        if (event.target.closest("[data-aespa-monitor-settings]")) openQuickSettings();
      });
      document.body.appendChild(statusElement);
    }
    const [background, color] = statusColors(currentStatus.tone);
    statusElement.style.background = background;
    statusElement.style.color = color;
    statusElement.innerHTML =
      `<strong>${escapeHtml(currentStatus.text)}</strong>` +
      `<div style="margin-top:3px;opacity:.92">${escapeHtml(currentStatus.detail)}</div>` +
      `<button type="button" data-aespa-monitor-settings ` +
      `style="margin-top:8px;padding:5px 10px;border:1px solid rgba(255,255,255,.7);` +
      `border-radius:7px;background:rgba(255,255,255,.16);color:inherit;font:inherit;` +
      `font-weight:600;cursor:pointer">设置 / 测试</button>`;
  }

  function setStatus(tone, text, detail = "") {
    currentStatus = { tone, text, detail };
    renderStatus();
    console.info(`[aespa 回流票监控] ${text}${detail ? `｜${detail}` : ""}`);
  }

  function startStatusUi() {
    if (document.body) {
      renderStatus();
      return;
    }
    document.addEventListener("DOMContentLoaded", renderStatus, { once: true });
  }

  function isSummaryApi(url) {
    try {
      return new URL(String(url), location.href).pathname.includes(API_MARKER);
    } catch (_error) {
      return String(url).includes(API_MARKER);
    }
  }

  function serializableBody(body) {
    if (body == null) return null;
    if (typeof body === "string") return body;
    if (body instanceof URLSearchParams) return body.toString();
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      const params = new URLSearchParams();
      for (const [key, value] of body.entries()) {
        if (typeof value !== "string") return null;
        params.append(key, value);
      }
      return params.toString();
    }
    return null;
  }

  function safeHeaders(headersLike) {
    const result = {};
    if (!headersLike) return result;
    try {
      const headers = new Headers(headersLike);
      for (const [name, value] of headers.entries()) {
        const lower = name.toLowerCase();
        if (["accept", "content-type", "x-requested-with"].includes(lower)) {
          result[name] = value;
        }
      }
    } catch (_error) {
      // A missing optional header must not break the ticket page.
    }
    return result;
  }

  function requestParams(request) {
    const params = new URLSearchParams();
    try {
      const parsedUrl = new URL(request.url, location.href);
      for (const [key, value] of parsedUrl.searchParams.entries()) params.set(key, value);
    } catch (_error) {
      // The API request body normally contains all target identifiers.
    }
    if (request.body) {
      try {
        for (const [key, value] of new URLSearchParams(request.body).entries()) {
          params.set(key, value);
        }
      } catch (_error) {
        // Ignore an unusual body format; context verification below remains strict.
      }
    }
    return params;
  }

  function visiblePageText() {
    return String(document.body?.innerText || document.documentElement?.textContent || "");
  }

  function classifyTargetRequest(request) {
    const params = requestParams(request);
    const productId = params.get("prodId") || params.get("productId") || "";
    const performanceDate = normalizeDigits(
      params.get("perfDate") || params.get("performanceDate") || "",
    );

    if (productId && productId !== TARGET.productId) return "wrong-product";
    if (performanceDate && performanceDate !== TARGET.performanceDate) return "wrong-date";

    const pageText = visiblePageText();
    const productConfirmed =
      productId === TARGET.productId ||
      (pageText.includes("COMPLaeXITY") && pageText.toLowerCase().includes("aespa"));
    const dateConfirmed =
      performanceDate === TARGET.performanceDate ||
      /2026[.\-/\s]0?8[.\-/\s]0?7/.test(pageText) ||
      /Aug(?:ust)?\s+0?7(?:,|\s)+2026/i.test(pageText);

    return productConfirmed && dateConfirmed ? "target" : "unknown";
  }

  function snapshotFetchRequest(input, init = {}) {
    const inputIsRequest = typeof Request !== "undefined" && input instanceof Request;
    const url = inputIsRequest ? input.url : String(input);
    const method = String(init.method || (inputIsRequest ? input.method : "GET")).toUpperCase();
    const body = serializableBody(init.body);
    const headers = safeHeaders(init.headers || (inputIsRequest ? input.headers : null));
    return { url, method, body, headers };
  }

  function rememberReplayableRequest(request) {
    const targetState = classifyTargetRequest(request);
    if (targetState === "wrong-date") {
      setStatus("warning", "当前不是 8 月 7 日场", "已暂停提醒，请重新选择 8/7 场次");
      return false;
    }
    if (targetState === "wrong-product") return false;
    if (targetState !== "target") {
      setStatus("waiting", "等待活动与场次参数", "必须确认 prodId=213414 且日期为 8/7");
      return false;
    }
    if (request.body == null && request.method !== "GET") {
      setStatus("warning", "已识别 8/7 场次", "当前请求格式不能安全复查，只监听页面自身刷新");
      return true;
    }
    lastReplayableRequest = {
      url: request.url,
      method: request.method,
      body: request.body,
      headers: request.headers || {},
    };
    ensurePollTimer();
    return true;
  }

  function parseApiPayload(rawText) {
    const trimmed = String(rawText || "").trim();
    if (!trimmed) throw new Error("空响应");
    try {
      return JSON.parse(trimmed);
    } catch (_directJsonError) {
      const callbackMatch = /^[^(]+\(([\s\S]*)\)\s*;?\s*$/.exec(trimmed);
      if (!callbackMatch) throw new Error("无法识别余票响应格式");
      return JSON.parse(callbackMatch[1].trim());
    }
  }

  function findSummaryArray(value, depth = 0) {
    if (depth > 6 || value == null || typeof value !== "object") return null;
    if (Array.isArray(value.summary)) return value.summary;
    for (const child of Object.values(value)) {
      const found = findSummaryArray(child, depth + 1);
      if (found) return found;
    }
    return null;
  }

  function matchingSectionName(item, allowedSections) {
    const candidates = [
      item.areaName,
      item.blockName,
      item.sectionName,
      item.floorName,
      item.areaNo,
      item.floorNo,
    ];
    for (const candidate of candidates) {
      const normalized = normalizeSection(candidate);
      if (allowedSections.has(normalized)) return normalized;
    }
    return "";
  }

  function floorAvailability(summary) {
    const allowedSections = configuredSections();
    const totals = new Map();
    for (const item of summary) {
      if (!item || typeof item !== "object") continue;
      const count = Number(
        item.realSeatCntlk ?? item.realSeatCnt ?? item.remainSeatCnt ?? item.seatCnt ?? 0,
      );
      if (!Number.isFinite(count) || count <= 0) continue;
      const section = matchingSectionName(item, allowedSections);
      if (!section) continue;
      totals.set(section, (totals.get(section) || 0) + Math.floor(count));
    }
    return [...totals.entries()]
      .map(([section, count]) => ({ section, count }))
      .sort((a, b) => Number(a.section.slice(1)) - Number(b.section.slice(1)));
  }

  function barkConfiguration() {
    const copiedUrl = String(GM_getValue(SETTINGS.barkUrl, "")).trim();
    if (!copiedUrl) return null;
    const parsed = new URL(copiedUrl);
    if (parsed.protocol !== "https:" || parsed.hostname !== "api.day.app") {
      throw new Error("仅接受 https://api.day.app/你的密钥/ 格式");
    }
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (!parts.length) throw new Error("Bark 地址中缺少设备密钥");
    const deviceKey = parts.at(-1);
    const prefix = parts.length > 1 ? `/${parts.slice(0, -1).join("/")}` : "";
    return {
      endpoint: `${parsed.origin}${prefix}/push`,
      deviceKey,
    };
  }

  function sendBark(title, body, subtitle = "") {
    const config = barkConfiguration();
    if (!config) return Promise.reject(new Error("尚未设置 Bark 地址"));
    const payload = {
      device_key: config.deviceKey,
      title,
      body,
      subtitle,
      group: "aespa 回流票",
      level: "timeSensitive",
      isArchive: "1",
      url: TARGET.eventUrl,
    };
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: config.endpoint,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        data: JSON.stringify(payload),
        timeout: 15000,
        onload(response) {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(`Bark HTTP ${response.status}`));
            return;
          }
          try {
            const result = JSON.parse(response.responseText || "{}");
            if (result.code != null && result.code !== 200) {
              reject(new Error(`Bark 返回代码 ${result.code}`));
              return;
            }
          } catch (_error) {
            // A successful HTTP response is sufficient when no JSON is returned.
          }
          resolve();
        },
        onerror: () => reject(new Error("Bark 网络请求失败")),
        ontimeout: () => reject(new Error("Bark 请求超时")),
      });
    });
  }

  function localNotification(details) {
    const text = details.map((item) => `${item.section}：${item.count} 张`).join("，");
    GM_notification({
      title: "aespa 8/7 内场回流票",
      text,
      timeout: 20000,
      onclick: () => GM_openInTab(TARGET.eventUrl, { active: true, insert: true }),
    });
  }

  async function notifyAvailability(details) {
    localNotification(details);
    const subtitle = details.map((item) => `${item.section} ${item.count}张`).join(" · ");
    const body =
      `${TARGET.displayDate}\n` +
      details.map((item) => `${item.section}：${item.count} 张`).join("\n") +
      "\n请立即返回 Melon Global 手动选座。";
    try {
      await sendBark("aespa 8/7 内场回流票", body, subtitle);
      setStatus("found", "发现内场回流票，Bark 已推送", `${subtitle}｜${safeNow()} KST`);
    } catch (error) {
      setStatus(
        "found",
        "发现内场回流票",
        `${subtitle}｜Bark 未发送：${error.message}`,
      );
    }
  }

  function processSummaryResponse(rawText, source) {
    try {
      const payload = parseApiPayload(rawText);
      const summary = findSummaryArray(payload);
      if (!summary) throw new Error("响应中没有 summary 余票列表");
      const availability = floorAvailability(summary);
      lastSeenAt = `${safeNow()} KST`;
      const signature = availability
        .map((item) => `${item.section}:${item.count}`)
        .join("|");

      if (!availability.length) {
        lastAvailabilitySignature = "";
        setStatus(
          "active",
          "正在监控 8/7 内场",
          `F1–F16 暂无回流｜每 ${configuredIntervalSeconds()} 秒｜${lastSeenAt}`,
        );
        return;
      }

      const detail = availability.map((item) => `${item.section} ${item.count}张`).join(" · ");
      setStatus("found", "发现内场回流票", `${detail}｜来源：${source}`);
      if (signature !== lastAvailabilitySignature) {
        lastAvailabilitySignature = signature;
        void notifyAvailability(availability);
      }
    } catch (error) {
      setStatus("warning", "余票响应解析失败", `${error.message}｜${source}`);
    }
  }

  async function pollOnce() {
    if (!nativeFetch || !lastReplayableRequest || pollInFlight) return;
    pollInFlight = true;
    const request = lastReplayableRequest;
    try {
      const response = await nativeFetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        credentials: "include",
        cache: "no-store",
      });
      if (!response.ok) {
        if ([401, 403].includes(response.status)) {
          throw new Error("选座会话可能已失效，请从活动页重新进入 8/7 选座");
        }
        throw new Error(`Melon API HTTP ${response.status}`);
      }
      processSummaryResponse(await response.text(), "定时复查");
    } catch (error) {
      setStatus("error", "定时复查失败", error.message);
    } finally {
      pollInFlight = false;
    }
  }

  function ensurePollTimer() {
    if (!lastReplayableRequest) return;
    if (pollTimer) clearInterval(pollTimer);
    const seconds = configuredIntervalSeconds();
    pollTimer = setInterval(() => void pollOnce(), seconds * 1000);
  }

  function installFetchObserver() {
    if (!nativeFetch) return;
    pageWindow.fetch = async function (...args) {
      const response = await nativeFetch(...args);
      try {
        const request = snapshotFetchRequest(args[0], args[1] || {});
        if (isSummaryApi(request.url) && rememberReplayableRequest(request)) {
          response
            .clone()
            .text()
            .then((text) => processSummaryResponse(text, "页面请求"))
            .catch((error) => setStatus("warning", "读取页面余票失败", error.message));
        }
      } catch (error) {
        console.warn("[aespa 回流票监控] Fetch 监听异常：", error);
      }
      return response;
    };
  }

  function installXhrObserver() {
    if (!xhrPrototype) return;
    const originalOpen = xhrPrototype.open;
    const originalSetRequestHeader = xhrPrototype.setRequestHeader;
    const originalSend = xhrPrototype.send;

    xhrPrototype.open = function (method, url, ...rest) {
      xhrMeta.set(this, {
        method: String(method || "GET").toUpperCase(),
        url: String(url),
        headers: {},
        body: null,
      });
      return originalOpen.call(this, method, url, ...rest);
    };

    xhrPrototype.setRequestHeader = function (name, value) {
      const meta = xhrMeta.get(this);
      if (meta) {
        const lower = String(name).toLowerCase();
        if (["accept", "content-type", "x-requested-with"].includes(lower)) {
          meta.headers[name] = String(value);
        }
      }
      return originalSetRequestHeader.call(this, name, value);
    };

    xhrPrototype.send = function (body) {
      const meta = xhrMeta.get(this);
      if (meta && isSummaryApi(meta.url)) {
        meta.body = serializableBody(body);
        this.addEventListener(
          "load",
          () => {
            if (this.status < 200 || this.status >= 300) return;
            if (!rememberReplayableRequest(meta)) return;
            try {
              const rawText =
                this.responseType === "" || this.responseType === "text"
                  ? this.responseText
                  : JSON.stringify(this.response);
              processSummaryResponse(rawText, "页面请求");
            } catch (error) {
              setStatus("warning", "读取页面余票失败", error.message);
            }
          },
          { once: true },
        );
      }
      return originalSend.call(this, body);
    };
  }

  function setBarkAddress() {
    const current = String(GM_getValue(SETTINGS.barkUrl, ""));
    const hint = current
      ? "已经保存过 Bark 地址。粘贴新地址可替换；输入 DELETE 可删除。"
      : "粘贴 Bark App 中的完整地址，例如 https://api.day.app/你的密钥/";
    const value = window.prompt(`${hint}\n密钥只保存在当前浏览器，不会写入脚本。`, "");
    if (value == null || !value.trim()) return;
    if (value.trim().toUpperCase() === "DELETE") {
      GM_setValue(SETTINGS.barkUrl, "");
      window.alert("Bark 地址已删除。");
      return;
    }
    try {
      const parsed = new URL(value.trim());
      if (parsed.protocol !== "https:" || parsed.hostname !== "api.day.app") {
        throw new Error("地址必须以 https://api.day.app/ 开头");
      }
      GM_setValue(SETTINGS.barkUrl, value.trim());
      window.alert("Bark 地址已保存在当前浏览器。");
    } catch (error) {
      window.alert(`保存失败：${error.message}`);
    }
  }

  function testBarkPush() {
    sendBark(
      "aespa 回流票监控测试成功",
      "已连接 Bark。之后发现 8 月 7 日 F1–F16 内场回流票会立即提醒。",
      "prodId 213414 · 2026-08-07",
    )
      .then(() => window.alert("测试推送已发送，请检查 iPhone。"))
      .catch((error) => window.alert(`测试失败：${error.message}`));
  }

  function setFloorSections() {
    const current = [...configuredSections()].join(",");
    const value = window.prompt("用英文逗号分隔分区；默认 F1-F16。", current);
    if (value == null) return;
    const sections = value
      .split(",")
      .map(normalizeSection)
      .filter(Boolean);
    if (!sections.length) {
      window.alert("至少保留一个分区。");
      return;
    }
    GM_setValue(SETTINGS.sections, [...new Set(sections)].join(","));
    lastAvailabilitySignature = "";
    window.alert(`已监控：${[...new Set(sections)].join(", ")}`);
  }

  function setPollingInterval() {
    const current = configuredIntervalSeconds();
    const value = window.prompt(
      `输入 ${MIN_INTERVAL_SECONDS}-${MAX_INTERVAL_SECONDS} 秒；建议 30 秒。`,
      String(current),
    );
    if (value == null) return;
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < MIN_INTERVAL_SECONDS || seconds > MAX_INTERVAL_SECONDS) {
      window.alert(`请输入 ${MIN_INTERVAL_SECONDS}-${MAX_INTERVAL_SECONDS} 之间的数字。`);
      return;
    }
    GM_setValue(SETTINGS.interval, Math.round(seconds));
    ensurePollTimer();
    window.alert(`检查间隔已设为 ${Math.round(seconds)} 秒。`);
  }

  function showMonitorStatus() {
    const barkReady = (() => {
      try {
        return barkConfiguration() ? "已设置" : "未设置";
      } catch (_error) {
        return "格式错误";
      }
    })();
    window.alert(
      [
        `活动：${TARGET.eventName}`,
        `场次：${TARGET.displayDate}`,
        `内场：${[...configuredSections()].join(", ")}`,
        `间隔：${configuredIntervalSeconds()} 秒`,
        `Bark：${barkReady}`,
        `最近检查：${lastSeenAt}`,
        `状态：${currentStatus.text} ${currentStatus.detail}`,
      ].join("\n"),
    );
  }

  function openQuickSettings() {
    const choice = window.prompt(
      [
        "aespa 回流票监控设置",
        "1 — 设置 Bark 地址",
        "2 — 测试 Bark 推送",
        "3 — 设置内场分区",
        "4 — 设置检查间隔",
        "5 — 查看监控状态",
        "请输入 1-5：",
      ].join("\n"),
      "1",
    );
    if (choice == null) return;
    const actions = {
      1: setBarkAddress,
      2: testBarkPush,
      3: setFloorSections,
      4: setPollingInterval,
      5: showMonitorStatus,
    };
    const action = actions[String(choice).trim()];
    if (action) action();
    else window.alert("请输入 1、2、3、4 或 5。");
  }

  function registerMenus() {
    GM_registerMenuCommand("设置 Bark 地址", setBarkAddress);
    GM_registerMenuCommand("测试 Bark 推送", testBarkPush);
    GM_registerMenuCommand("设置内场分区", setFloorSections);
    GM_registerMenuCommand("设置检查间隔", setPollingInterval);
    GM_registerMenuCommand("查看监控状态", showMonitorStatus);
  }

  startStatusUi();
  registerMenus();
  installFetchObserver();
  installXhrObserver();
})();
