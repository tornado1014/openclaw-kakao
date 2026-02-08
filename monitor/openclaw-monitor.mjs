#!/usr/bin/env node
// openclaw-monitor.mjs - OpenClaw 서비스 실시간 모니터링 데몬
// Usage: node openclaw-monitor.mjs [check|start|stop|status|daemon]

import { exec, execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// === Config ===
function loadConfig() {
  const localPath = join(__dirname, 'config.local.json');
  const defaultPath = join(__dirname, 'config.json');
  const examplePath = join(__dirname, 'config.example.json');
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

const config = loadConfig();
const PM2_CWD = join(__dirname, '..');

// === State ===
const state = {
  gateway:     { status: 'unknown', lastFail: null, lastNotify: null },
  kakaotalk:   { status: 'unknown', lastFail: null, lastNotify: null },
  bridge:      { status: 'unknown', lastFail: null, lastNotify: null },
  cloudflared: { status: 'unknown', lastFail: null, lastNotify: null }
};

// Escalation tracking
let lastEscalation = null;
let escalationCount = 0;

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
  const result = await run('openclaw gateway status');
  if (result.stdout.includes('RPC probe: ok')) return 'ok';
  return 'fail';
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
  // pm2 status check
  const pm2Status = await checkPm2Process(svc.pm2Name);
  if (pm2Status !== 'ok') return 'fail';
  // ping check
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
  // Check actual tunnel connections
  const tunnelResult = await run(`cloudflared tunnel info ${svc.tunnelId}`, 15000);
  if (tunnelResult.stdout.includes('does not have any active connection')) return 'fail';
  if (tunnelResult.stdout.includes('CONNECTOR')) return 'ok';
  return 'fail';
}

// === Repair ===

async function repairGateway() {
  log('REPAIR', 'Gateway: openclaw gateway start...');
  await run('openclaw gateway start', 30000);
  await sleep(3000);
  return await checkGateway();
}

async function repairPm2(name, port) {
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
  log('REPAIR', `${name}: pm2 restart...`);
  await pm2Run(`restart ${name}`);
  await sleep(3000);
}

async function repairKakaotalk() {
  const svc = config.services.kakaotalk;
  await repairPm2(svc.pm2Name, svc.port);
  return await checkKakaotalk();
}

async function repairBridge() {
  const svc = config.services.bridge;
  await repairPm2(svc.pm2Name, svc.port);
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

  // Cooldown check
  const cooldownMs = (esc.cooldown || 300) * 1000;
  if (lastEscalation && (Date.now() - lastEscalation) < cooldownMs) {
    log('ESCAL', `Cooldown active (${Math.ceil((cooldownMs - (Date.now() - lastEscalation)) / 1000)}s left)`);
    return false;
  }

  // Max retries check
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

  // Run checks in parallel
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

  // Detect state transitions + repair + notify
  for (const [name, newStatus] of Object.entries(results)) {
    if (newStatus === 'disabled') continue;
    const prev = state[name].status;
    const transitioned = prev !== newStatus && prev !== 'unknown';

    if (newStatus === 'fail') {
      // Try auto-repair
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
      // Still failed after basic repair → flag for escalation
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

  // Escalation: basic repair failed → try openclaw-check.sh --repair
  if (needsEscalation) {
    const escalated = await escalateToCheckScript();
    if (escalated) {
      // Escalation succeeded → recheck all services
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
      // Escalation also failed → CRITICAL alert
      const failedServices = Object.entries(results)
        .filter(([_, s]) => s === 'fail')
        .map(([n]) => n);
      if (failedServices.length > 0 && shouldNotify(failedServices[0])) {
        await notify('OpenClaw CRITICAL', `Repair+Escalation failed: ${failedServices.join(', ')}`);
        failedServices.forEach(n => { state[n].lastNotify = Date.now(); });
      }
    }
  }

  // All OK → reset escalation counter
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

  // Detailed output
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

async function cmdDaemon() {
  const interval = (config.interval || 60) * 1000;
  log('DAEMON', `Starting monitoring (interval: ${config.interval}s, repair: ${config.autoRepair})`);
  log('DAEMON', `Escalation: ${config.escalation?.enabled ? `enabled (cooldown: ${config.escalation.cooldown}s, maxRetries: ${config.escalation.maxRetries})` : 'disabled'}`);
  log('DAEMON', `Notifications - toast: ${config.notification?.toast?.enabled}, ntfy: ${config.notification?.ntfy?.enabled} (${config.notification?.ntfy?.topic})`);
  console.log('');

  // Initial check
  const results = await runChecks();
  log('STATUS', `${formatSummary(results)} | next: ${config.interval}s`);

  // Loop
  setInterval(async () => {
    try {
      const results = await runChecks();
      log('STATUS', `${formatSummary(results)} | next: ${config.interval}s`);
    } catch (err) {
      log('ERROR', `Check cycle failed: ${err.message}`);
    }
  }, interval);
}

async function cmdStart() {
  log('START', 'Starting openclaw-monitor via pm2...');
  const ecosystemPath = join(__dirname, 'ecosystem.config.cjs');
  const result = await pm2Run(`start "${ecosystemPath}"`, 30000);
  if (result.ok) {
    console.log(result.stdout);
    log('START', 'Monitor daemon started');
  } else {
    console.error(result.stderr);
    log('ERROR', 'Failed to start monitor daemon');
  }
}

async function cmdStop() {
  log('STOP', 'Stopping openclaw-monitor...');
  const result = await pm2Run('stop openclaw-monitor', 15000);
  if (result.ok) {
    console.log(result.stdout);
    log('STOP', 'Monitor daemon stopped');
  } else {
    console.error(result.stderr);
  }
}

async function cmdStatus() {
  const result = await pm2Run('jlist', 15000);
  if (!result.ok) {
    log('ERROR', 'Cannot read pm2 status');
    return;
  }
  try {
    const procs = JSON.parse(result.stdout);
    const mon = procs.find(p => p.name === 'openclaw-monitor');
    if (mon) {
      const status = mon.pm2_env?.status || 'unknown';
      const uptime = mon.pm2_env?.pm_uptime;
      const restarts = mon.pm2_env?.restart_time || 0;
      const uptimeStr = uptime ? `${Math.floor((Date.now() - uptime) / 60000)}m` : '?';
      console.log(`openclaw-monitor: ${status} (uptime: ${uptimeStr}, restarts: ${restarts})`);
    } else {
      console.log('openclaw-monitor: not registered in pm2');
    }
  } catch {
    log('ERROR', 'Failed to parse pm2 output');
  }
}

// === Main ===
const cmd = process.argv[2] || 'check';

switch (cmd) {
  case 'check':  await cmdCheck(); break;
  case 'daemon': await cmdDaemon(); break;
  case 'start':  await cmdStart(); break;
  case 'stop':   await cmdStop(); break;
  case 'status': await cmdStatus(); break;
  default:
    console.log('Usage: node openclaw-monitor.mjs [check|start|stop|status|daemon]');
    console.log('  check  - One-shot health check (default)');
    console.log('  start  - Start daemon via pm2');
    console.log('  stop   - Stop daemon');
    console.log('  status - Show daemon status');
    console.log('  daemon - Run as foreground daemon (used by pm2)');
    process.exit(0);
}
