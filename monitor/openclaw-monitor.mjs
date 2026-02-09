#!/usr/bin/env node
// openclaw-monitor.mjs - OpenClaw 서비스 실시간 모니터링 데몬
// Usage: node openclaw-monitor.mjs [check|watchdog|daemon|status]
// watchdog: schtasks용 1회 실행 모드 (PM2 독립, 상태 파일 기반)

import { exec, execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// === Config ===
function loadConfig(dir = __dirname) {
  const localPath = join(dir, 'config.local.json');
  const defaultPath = join(dir, 'config.json');
  const examplePath = join(dir, 'config.example.json');
  const configPath = existsSync(localPath) ? localPath
    : existsSync(defaultPath) ? defaultPath
    : examplePath;
  if (!existsSync(configPath)) {
    console.error('[ERROR] No config file found (config.local.json, config.json, or config.example.json)');
    process.exit(1);
  }
  console.log(`[CONFIG] Loading: ${configPath}`);
  return JSON.parse(readFileSync(configPath, 'utf-8'));
}

let config = {};
let PM2_CWD = join(__dirname, '..');

/** @internal For testing: inject config and reset state */
function _initForTest(testConfig) {
  config = testConfig;
  PM2_CWD = join(__dirname, '..');
  Object.keys(state).forEach(k => {
    state[k] = { status: 'unknown', lastFail: null, lastNotify: null };
  });
  lastEscalation = null;
  escalationCount = 0;
}
const STATE_FILE = join(__dirname, 'monitor-state.json');

// === Persistent State (file-based for watchdog mode) ===
const state = {
  gateway:     { status: 'unknown', lastFail: null, lastNotify: null },
  kakaotalk:   { status: 'unknown', lastFail: null, lastNotify: null },
  bridge:      { status: 'unknown', lastFail: null, lastNotify: null },
  cloudflared: { status: 'unknown', lastFail: null, lastNotify: null }
};

let lastEscalation = null;
let escalationCount = 0;

function loadState() {
  if (!existsSync(STATE_FILE)) return;
  try {
    const saved = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    if (saved.services) {
      for (const [name, s] of Object.entries(saved.services)) {
        if (state[name]) Object.assign(state[name], s);
      }
    }
    if (saved.lastEscalation) lastEscalation = saved.lastEscalation;
    if (saved.escalationCount != null) escalationCount = saved.escalationCount;
  } catch {
    // corrupted state file, start fresh
  }
}

function saveState() {
  const data = {
    services: state,
    lastEscalation,
    escalationCount,
    updatedAt: Date.now()
  };
  try {
    writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
  } catch {
    // state save failed silently
  }
}

// === Utility: exec as promise ===
function run(cmd, timeoutMs = 15000, cwd = undefined) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeoutMs, windowsHide: true, cwd }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
    });
  });
}

function pm2Run(cmd, timeoutMs = 20000) {
  return run(`npx pm2 ${cmd}`, timeoutMs, PM2_CWD);
}

// === PM2 Daemon Health ===

async function checkPm2Daemon() {
  const result = await pm2Run('ping', 10000);
  return result.ok;
}

async function bootstrapPm2() {
  log('RESCUE', 'PM2 daemon dead or empty - bootstrapping all ecosystems...');
  const ecosystems = config.ecosystems || {};
  for (const [label, ecoPath] of Object.entries(ecosystems)) {
    if (!existsSync(ecoPath)) {
      log('RESCUE', `Ecosystem not found: ${ecoPath} (${label})`);
      continue;
    }
    const ecoCwd = dirname(ecoPath);
    log('RESCUE', `Starting ecosystem: ${label} (${ecoPath})`);
    const result = await run(`npx pm2 start "${ecoPath}"`, 30000, ecoCwd);
    if (result.ok) {
      log('RESCUE', `${label}: started successfully`);
    } else {
      log('RESCUE', `${label}: failed - ${result.stderr}`);
    }
  }
  await sleep(3000);
}

// === Notifications ===

async function sendToast(title, message) {
  if (!config.notification?.toast?.enabled) return;
  const silent = config.notification.toast.silent;
  const safeTitle = title.replace(/'/g, "''");
  const safeMsg = message.replace(/'/g, "''");
  const silentFlag = silent ? ' -Silent' : '';
  const ps = `Import-Module BurntToast; New-BurntToastNotification -AppLogo $null -Text '${safeTitle}','${safeMsg}'${silentFlag}`;
  await run(`powershell -NoProfile -Command "${ps}"`, 10000);
}

async function sendNtfy(title, message) {
  const ntfy = config.notification?.ntfy;
  if (!ntfy?.enabled || !ntfy?.topic) return;
  const url = `${ntfy.server}/${ntfy.topic}`;
  const priority = ntfy.priority || 'high';
  const tags = (ntfy.tags || []).join(',');
  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'Title': title,
        'Priority': priority,
        ...(tags ? { 'Tags': tags } : {})
      },
      body: message,
      signal: AbortSignal.timeout(10000)
    });
  } catch {
    // ntfy send failed silently
  }
}

async function notify(title, message) {
  await Promise.all([
    sendToast(title, message),
    sendNtfy(title, message)
  ]);
}

function shouldNotify(serviceName) {
  const s = state[serviceName];
  if (!s.lastNotify) return true;
  const cooldown = (config.notification?.cooldown || 300) * 1000;
  return (Date.now() - s.lastNotify) >= cooldown;
}

// === Health Checks ===

async function checkGateway() {
  const svc = config.services.gateway;
  if (!svc?.enabled) return 'disabled';
  const probeUrl = svc.probeUrl || `http://localhost:${svc.port}/`;
  try {
    const resp = await fetch(probeUrl, { signal: AbortSignal.timeout(5000) });
    // Gateway responds with HTML dashboard or redirect - any HTTP response = alive
    return resp.ok || resp.status < 500 ? 'ok' : 'fail';
  } catch {
    return 'fail';
  }
}

async function checkPm2Process(name) {
  const result = await pm2Run('jlist');
  if (!result.ok) return 'fail';
  try {
    const procs = JSON.parse(result.stdout);
    const proc = procs.find(p => p.name === name);
    if (!proc) return 'not_found';
    const status = proc.pm2_env?.status;
    if (status === 'online') return 'ok';
    return 'fail';
  } catch {
    return 'fail';
  }
}

async function checkKakaotalk() {
  const svc = config.services.kakaotalk;
  if (!svc?.enabled) return 'disabled';
  return checkPm2Process(svc.pm2Name);
}

async function checkBridge() {
  const svc = config.services.bridge;
  if (!svc?.enabled) return 'disabled';
  const pm2Status = await checkPm2Process(svc.pm2Name);
  if (pm2Status !== 'ok') return 'fail';
  if (svc.pingUrl) {
    try {
      const resp = await fetch(svc.pingUrl, { signal: AbortSignal.timeout(5000) });
      const text = await resp.text();
      if (text.trim() === 'pong') return 'ok';
      return 'fail';
    } catch {
      return 'fail';
    }
  }
  return 'ok';
}

async function checkCloudflared() {
  const svc = config.services.cloudflared;
  if (!svc?.enabled) return 'disabled';
  const result = await run('powershell -NoProfile -Command "(Get-Service cloudflared).Status"', 10000);
  if (result.stdout.trim() !== 'Running') return 'fail';
  const tunnelResult = await run(`cloudflared tunnel info ${svc.tunnelId}`, 15000);
  if (tunnelResult.stdout.includes('does not have any active connection')) return 'fail';
  if (tunnelResult.stdout.includes('CONNECTOR')) return 'ok';
  return 'fail';
}

// === Repair ===

async function repairGateway() {
  log('REPAIR', 'Gateway: triggering schtasks...');
  const trigger = await run('schtasks /Run /TN "OpenClaw Gateway"', 10000);
  if (!trigger.ok) {
    log('REPAIR', `schtasks failed, falling back to CLI: ${trigger.stderr}`);
    await run('openclaw gateway start', 30000);
  }
  // Gateway needs a few seconds to boot after schtasks trigger
  for (let i = 0; i < 4; i++) {
    await sleep(2000);
    const status = await checkGateway();
    if (status === 'ok') return 'ok';
  }
  return 'fail';
}

function getEcosystemForService(serviceName) {
  const svc = config.services[serviceName];
  const ecoLabel = svc?.ecosystem;
  if (!ecoLabel || !config.ecosystems?.[ecoLabel]) return null;
  return config.ecosystems[ecoLabel];
}

async function repairPm2(name, port, serviceName) {
  // Kill zombie on port
  if (port) {
    const netstat = await run(`netstat -ano | findstr ":${port}.*LISTENING"`, 5000);
    const match = netstat.stdout.match(/:(\d+)\s+LISTENING\s+(\d+)/);
    if (match) {
      const pid = match[2];
      if (pid && pid !== '0') {
        log('REPAIR', `Killing zombie PID ${pid} on port ${port}...`);
        await run(`powershell -NoProfile -Command "Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue"`, 5000);
        await sleep(1000);
      }
    }
  }

  // Try pm2 restart first
  log('REPAIR', `${name}: pm2 restart...`);
  const restartResult = await pm2Run(`restart ${name}`);

  if (!restartResult.ok || restartResult.stderr.includes('not found')) {
    // Fallback: start via ecosystem file
    const ecoPath = getEcosystemForService(serviceName);
    if (ecoPath && existsSync(ecoPath)) {
      log('REPAIR', `${name}: not in pm2, starting via ecosystem (${ecoPath})...`);
      const ecoCwd = dirname(ecoPath);
      await run(`npx pm2 start "${ecoPath}" --only ${name}`, 30000, ecoCwd);
    } else {
      log('REPAIR', `${name}: no ecosystem path configured, cannot recover`);
    }
  }

  await sleep(3000);
}

async function repairKakaotalk() {
  const svc = config.services.kakaotalk;
  await repairPm2(svc.pm2Name, svc.port, 'kakaotalk');
  return await checkKakaotalk();
}

async function repairBridge() {
  const svc = config.services.bridge;
  await repairPm2(svc.pm2Name, svc.port, 'bridge');
  return await checkBridge();
}

async function repairCloudflared() {
  log('REPAIR', 'Cloudflared: restarting service...');
  await run('powershell -NoProfile -Command "Restart-Service cloudflared -Force"', 15000);
  await sleep(10000);
  return await checkCloudflared();
}

// === Escalation ===

async function escalateToCheckScript() {
  const esc = config.escalation;
  if (!esc?.enabled) return false;

  const cooldownMs = (esc.cooldown || 300) * 1000;
  if (lastEscalation && (Date.now() - lastEscalation) < cooldownMs) {
    log('ESCAL', `Cooldown active (${Math.ceil((cooldownMs - (Date.now() - lastEscalation)) / 1000)}s left)`);
    return false;
  }

  if (escalationCount >= (esc.maxRetries || 2)) {
    log('ESCAL', `Max retries (${esc.maxRetries || 2}) reached, skipping`);
    return false;
  }

  const scriptPath = esc.scriptPath;
  log('ESCAL', `Running check script: ${scriptPath} --repair`);
  lastEscalation = Date.now();
  escalationCount++;

  const result = await run(`bash "${scriptPath}" --repair`, 120000);

  if (result.ok) {
    log('ESCAL', 'Check script completed successfully - services recovered');
    escalationCount = 0;
    return true;
  } else {
    log('ESCAL', 'Check script completed but some services still unhealthy');
    return false;
  }
}

// === Main Check Cycle ===

async function runChecks() {
  const results = {};

  const [gw, kt, br, cf] = await Promise.all([
    checkGateway(),
    checkKakaotalk(),
    checkBridge(),
    checkCloudflared()
  ]);

  results.gateway = gw;
  results.kakaotalk = kt;
  results.bridge = br;
  results.cloudflared = cf;

  let needsEscalation = false;

  for (const [name, newStatus] of Object.entries(results)) {
    if (newStatus === 'disabled') continue;
    const prev = state[name].status;

    if (newStatus === 'fail') {
      if (config.autoRepair) {
        let repaired = 'fail';
        switch (name) {
          case 'gateway': repaired = await repairGateway(); break;
          case 'kakaotalk': repaired = await repairKakaotalk(); break;
          case 'bridge': repaired = await repairBridge(); break;
          case 'cloudflared': repaired = await repairCloudflared(); break;
        }
        if (repaired === 'ok') {
          results[name] = 'ok';
          state[name].status = 'ok';
          if (shouldNotify(name)) {
            await notify('OpenClaw Monitor', `${name} down -> auto-repaired`);
            state[name].lastNotify = Date.now();
          }
          continue;
        }
      }
      state[name].status = 'fail';
      state[name].lastFail = Date.now();
      needsEscalation = true;
    } else if (newStatus === 'ok') {
      if (prev === 'fail' && config.notification?.onRecover) {
        if (shouldNotify(name)) {
          await notify('OpenClaw Recovered', `${name} is back online`);
          state[name].lastNotify = Date.now();
        }
      }
      state[name].status = 'ok';
    }
  }

  if (needsEscalation) {
    const escalated = await escalateToCheckScript();
    if (escalated) {
      const [gw2, kt2, br2, cf2] = await Promise.all([
        checkGateway(), checkKakaotalk(), checkBridge(), checkCloudflared()
      ]);
      const recheck = { gateway: gw2, kakaotalk: kt2, bridge: br2, cloudflared: cf2 };
      for (const [name, newStatus] of Object.entries(recheck)) {
        results[name] = newStatus;
        state[name].status = newStatus;
        if (newStatus === 'ok' && state[name].lastFail) {
          await notify('OpenClaw Monitor', `${name} escalation repair 성공`);
          state[name].lastNotify = Date.now();
        }
      }
    } else {
      const failedServices = Object.entries(results)
        .filter(([_, s]) => s === 'fail')
        .map(([n]) => n);
      if (failedServices.length > 0 && shouldNotify(failedServices[0])) {
        await notify('OpenClaw CRITICAL', `Repair+Escalation failed: ${failedServices.join(', ')}`);
        failedServices.forEach(n => { state[n].lastNotify = Date.now(); });
      }
    }
  }

  const allOk = Object.values(results).every(s => s === 'ok' || s === 'disabled');
  if (allOk) escalationCount = 0;

  return results;
}

// === Formatting ===

function statusIcon(s) {
  if (s === 'ok') return '\u2713';
  if (s === 'fail') return '\u2717';
  if (s === 'disabled') return '-';
  return '?';
}

function formatSummary(results) {
  const allOk = Object.values(results).every(s => s === 'ok' || s === 'disabled');
  const tag = allOk ? 'ALL OK' : 'ALERT ';
  const icons = `GW:${statusIcon(results.gateway)} KT:${statusIcon(results.kakaotalk)} BR:${statusIcon(results.bridge)} CF:${statusIcon(results.cloudflared)}`;
  return `${tag} | ${icons}`;
}

function log(level, msg) {
  const time = new Date().toLocaleTimeString('ko-KR', { hour12: false });
  console.log(`[${time}] ${level.padEnd(6)} | ${msg}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// === CLI Commands ===

async function cmdCheck() {
  log('CHECK', 'Running one-shot health check...');
  console.log('');
  const results = await runChecks();
  console.log('');
  log('RESULT', formatSummary(results));

  console.log('');
  console.log('--- Route Status ---');
  const gwOk = results.gateway === 'ok';
  const ktOk = results.kakaotalk === 'ok';
  const brOk = results.bridge === 'ok';
  const cfOk = results.cloudflared === 'ok';

  if (gwOk && ktOk && cfOk) {
    console.log('[OK]   Route A (Kakao Channel): All healthy');
  } else {
    const issues = [];
    if (!gwOk) issues.push('Gateway');
    if (!ktOk) issues.push('clawdbot-kakaotalk');
    if (!cfOk) issues.push('Cloudflared');
    console.log(`[FAIL] Route A (Kakao Channel): ${issues.join(', ')}`);
  }

  if (gwOk && brOk) {
    console.log('[OK]   Route B (BlueStacks): All healthy');
  } else {
    const issues = [];
    if (!gwOk) issues.push('Gateway');
    if (!brOk) issues.push('memento-bridge');
    console.log(`[FAIL] Route B (BlueStacks): ${issues.join(', ')}`);
  }

  if (gwOk) {
    console.log('[OK]   Route C (Telegram): Gateway healthy');
  } else {
    console.log('[FAIL] Route C (Telegram): Gateway');
  }

  const allOk = gwOk && ktOk && brOk && cfOk;
  console.log('');
  console.log(allOk ? 'ALL SERVICES HEALTHY' : 'SOME SERVICES UNHEALTHY');
  process.exit(allOk ? 0 : 1);
}

async function cmdWatchdog() {
  // schtasks용 1회 실행 모드: PM2 독립, 상태 파일 기반
  loadState();

  // Step 1: PM2 데몬 생존 확인
  const pm2Alive = await checkPm2Daemon();
  if (!pm2Alive) {
    log('RESCUE', 'PM2 daemon is not responding');
    await notify('OpenClaw RESCUE', 'PM2 daemon dead - bootstrapping all services');
    await bootstrapPm2();
  } else {
    // PM2 살아있지만 프로세스 목록이 비었는지 확인
    const jlistResult = await pm2Run('jlist');
    let procCount = 0;
    try {
      const procs = JSON.parse(jlistResult.stdout);
      procCount = procs.length;
    } catch {}
    if (procCount === 0) {
      log('RESCUE', 'PM2 alive but process list empty - bootstrapping...');
      await notify('OpenClaw RESCUE', 'PM2 process list empty - re-registering all services');
      await bootstrapPm2();
    }
  }

  // Step 2: 일반 서비스 점검 + 복구
  const results = await runChecks();
  log('STATUS', `${formatSummary(results)} | mode: watchdog`);

  // Step 3: 상태 저장
  saveState();
}

async function cmdDaemon() {
  const interval = (config.interval || 60) * 1000;
  log('DAEMON', `Starting monitoring (interval: ${config.interval}s, repair: ${config.autoRepair})`);
  log('DAEMON', `Escalation: ${config.escalation?.enabled ? `enabled (cooldown: ${config.escalation.cooldown}s, maxRetries: ${config.escalation.maxRetries})` : 'disabled'}`);
  log('DAEMON', `Notifications - toast: ${config.notification?.toast?.enabled}, ntfy: ${config.notification?.ntfy?.enabled} (${config.notification?.ntfy?.topic})`);
  console.log('');

  const results = await runChecks();
  log('STATUS', `${formatSummary(results)} | next: ${config.interval}s`);

  setInterval(async () => {
    try {
      const results = await runChecks();
      log('STATUS', `${formatSummary(results)} | next: ${config.interval}s`);
    } catch (err) {
      log('ERROR', `Check cycle failed: ${err.message}`);
    }
  }, interval);
}

async function cmdStatus() {
  // schtasks 기반으로 전환됨
  const result = await run('schtasks /Query /TN "OpenClaw-Monitor" /FO LIST', 10000);
  if (result.ok) {
    console.log('=== Scheduled Task: OpenClaw-Monitor ===');
    console.log(result.stdout);
  } else {
    console.log('OpenClaw-Monitor: not registered as scheduled task');
  }

  // 상태 파일 확인
  if (existsSync(STATE_FILE)) {
    const saved = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    const ago = saved.updatedAt ? `${Math.floor((Date.now() - saved.updatedAt) / 1000)}s ago` : 'unknown';
    console.log(`\n=== Last watchdog run: ${ago} ===`);
    for (const [name, s] of Object.entries(saved.services || {})) {
      console.log(`  ${name}: ${s.status}`);
    }
  } else {
    console.log('\nNo state file found (watchdog has not run yet)');
  }
}

// === Exports (for testing) ===
export {
  _initForTest, loadConfig,
  shouldNotify, statusIcon, formatSummary,
  checkGateway, checkPm2Process, checkBridge, checkCloudflared,
  repairGateway, escalateToCheckScript, runChecks,
  state, log, sleep
};

// === Main ===
const _isMain = process.argv[1] && (
  fileURLToPath(import.meta.url).replace(/\\/g, '/') === process.argv[1].replace(/\\/g, '/')
);

if (_isMain) {
  config = loadConfig();

  const cmd = process.argv[2] || 'check';

  switch (cmd) {
    case 'check':    await cmdCheck(); break;
    case 'watchdog': await cmdWatchdog(); break;
    case 'daemon':   await cmdDaemon(); break;
    case 'status':   await cmdStatus(); break;
    default:
      console.log('Usage: node openclaw-monitor.mjs [check|watchdog|daemon|status]');
      console.log('  check    - One-shot health check (default)');
      console.log('  watchdog - Single run: check + repair + save state (for schtasks)');
      console.log('  daemon   - Run as foreground daemon (legacy pm2 mode)');
      console.log('  status   - Show scheduled task & last state');
      process.exit(0);
  }
}
