import fs from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { resolveCodexHome } from "../runtime/codex-home.mjs";
import { normalizeHostSource } from "../runtime/host-source.mjs";
import { syncCompanionLedgerSource } from "../runtime/companion-ledger-source.mjs";
import { CompanionArchiveReader } from '../runtime/companion-archive.mjs';
import { UsageLedger } from "./core/usage-ledger.mjs";
import { DshUsageLedger } from './core/dsh-usage-ledger.mjs';
import { readJson, writeJson, assertCompanionData } from "./core/storage.mjs";
assertCompanionData(workerData.dataDir,{claim:true});
import { defaultUsagePreferences, validateUsagePreferences } from "./core/usage-pricing.mjs";
const file = path.join(workerData.dataDir, "usage-preferences.json");
let preferences, ledger, selectedId = "", provider = "*", timer, stopped = false;
let hostSource = normalizeHostSource(workerData.hostSource), sessions = [], history = null;
const archiveReader = new CompanionArchiveReader();
try { preferences = validateUsagePreferences(readJson(file, defaultUsagePreferences())); }
catch { preferences = defaultUsagePreferences(); }
const source = () => preferences.codexHome ? 'codex' : hostSource;
function replace(home, mirror = null) {
  if (ledger?.home === home) return;
  const replacement = mirror
    ? new DshUsageLedger({ dataDir: path.join(workerData.dataDir, 'dsh-ledgers', mirror.accountKey), codexHome: home })
    : new UsageLedger({ dataDir: workerData.dataDir, codexHome: home });
  ledger?.close(); ledger = replacement; selectedId = ""; provider = "*";
}
function open() {
  if (source() === 'codex') {
    archiveReader.reset(); history = null;
    replace(resolveCodexHome(preferences.codexHome ?? workerData.codexHome)); sessions = [];
  } else {
    const mirror = syncCompanionLedgerSource(workerData.dataDir, workerData, Date.now(), { archiveReader });
    replace(mirror.home, mirror); ledger.synchronize(mirror); sessions = mirror.sessions; history = mirror.history;
  }
}
function send(requestId = null, error = null) {
  let snapshot = null;
  try {
    if (ledger) {
      snapshot = ledger.snapshot({ rules: preferences.rules, selectedId, provider });
      snapshot.source = source();
      snapshot.sourceLabel = source() === 'dsh' ? '启用桥接后已观测记录（DSH 数值档案，非平台完整账单）' : '原始 Codex 数据目录';
      if (source() === 'dsh') {
        snapshot.history = history;
        snapshot.scanning ||= Boolean(history?.pending);
        if (history?.gap) snapshot.error = history.message;
      }

    }
  } catch { error = "用量统计暂时不可用，请稍后重试。"; }
  parentPort.postMessage({ requestId, ok: !error, error, preferences, snapshot, source: source() });
}
function scan() {
  try { open(); ledger.scan(); }
  catch (error) {
    if (source() === 'dsh') { ledger?.close(); ledger = null; sessions = []; history = null; archiveReader.reset(); }
    throw error;
  }
}
function tick() {
  if (stopped) return;
  try { scan(); send(); }
  catch { send(null, source() === 'dsh' ? 'DSH 用量投影未连接、已过期或无效；未读取原始日志。' : '用量日志或记账文件暂时不可读，请稍后重试。'); }
}
tick(); timer = setInterval(tick, 1000);
parentPort.on("message", (message) => {
  try {
    if (message.op === "stop") {
      stopped = true; clearInterval(timer); archiveReader.close(); ledger?.close(); parentPort.close(); return;
    }
    if (message.op === 'source') {
      if (!['dsh','codex'].includes(message.value)) throw Error('未知用量来源');
      hostSource = message.value; history = null; archiveReader.reset();
      ledger?.close(); ledger = null; sessions = []; selectedId = ''; provider = '*';
    } else if (message.op === "save") {
      const next = validateUsagePreferences(message.value), changed = next.codexHome !== preferences.codexHome;
      if (next.codexHome) {
        const root = next.codexHome;
        if (root === path.dirname(root) || !fs.statSync(root).isDirectory() ||
            !["sessions", "archived_sessions", "config.toml"].some(name => fs.existsSync(path.join(root, name))))
          throw Error("所选目录里没有找到 Codex 日志或配置，请选择 Codex 数据根目录");
      }
      // Validate a selected original Codex source before persisting preferences.
      let replacement;
      if (changed && (next.codexHome || hostSource === 'codex'))
        replacement = new UsageLedger({ dataDir: workerData.dataDir, codexHome: resolveCodexHome(next.codexHome ?? workerData.codexHome) });
      try { writeJson(file, next); }
      catch (error) { replacement?.close(); throw error; }
      preferences = next;
      if (changed) {
        ledger?.close(); ledger = replacement ?? null; sessions = []; selectedId = ''; provider = '*';
      }
    } else if (message.op === "select") {
      if (typeof message.value?.id !== "string" || message.value.id.length > 200 ||
          typeof message.value?.provider !== "string" || message.value.provider.length > 160) throw Error("对话选择无效");
      selectedId = message.value.id; provider = message.value.provider;
    } else if (message.op !== "refresh") throw Error("未知记账操作");
    scan(); send(message.requestId);
  } catch (error) {
    send(message.requestId, message.op === "save" ? String(error.message) :
      source() === 'dsh' ? 'DSH 用量投影未连接、已过期或无效；未读取原始日志。' : "操作未完成，请稍后重试。");
  }
});
