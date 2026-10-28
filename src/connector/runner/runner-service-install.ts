import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const LABEL = 'dev.agent-office.runner';
const UNIT = 'agent-office-runner.service';
const TASK = 'AgentOfficeRunner';
/**
 * Environment the service keeps from the installing shell. Secrets (API tokens) are deliberately not copied into
 * service files: Claude Code reads its own login and the `env` block of ~/.claude/settings.json.
 */
const KEPT_ENV = ['PATH', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'CLAUDE_CONFIG_DIR', 'AGENT_OFFICE_HOME', 'AGENT_OFFICE_PERMISSION_WAIT_SECONDS'];

export type ServicePlan = { file: string; content: string; extraFiles?: Array<{ file: string; content: string }>; activate: string[][]; deactivate: string[][]; restart: string[][]; note: string };

const xml = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const keptEnv = (env: NodeJS.ProcessEnv): Record<string, string> => Object.fromEntries(KEPT_ENV.filter(key => env[key]).map(key => [key, env[key]!]));

/** Service definition for this OS: launchd agent (macOS), systemd user unit (Linux), logon task (Windows). */
export const servicePlan = (platform: NodeJS.Platform, node: string, script: string, home: string, env: Record<string, string>, uid = 0): ServicePlan => {
  const logDir = path.join(home, 'logs');
  if (platform === 'darwin') {
    const file = path.join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
    const vars = Object.entries(env).map(([key, value]) => `      <key>${xml(key)}</key><string>${xml(value)}</string>`).join('\n');
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${LABEL}</string>
    <key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(script)}</string><string>runner</string></array>
    <key>EnvironmentVariables</key>
    <dict>
${vars}
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>10</integer>
    <key>StandardOutPath</key><string>${xml(path.join(logDir, 'runner.log'))}</string>
    <key>StandardErrorPath</key><string>${xml(path.join(logDir, 'runner.log'))}</string>
  </dict>
</plist>
`;
    const domain = `gui/${uid}`;
    return { file, content, activate: [['launchctl', 'bootout', `${domain}/${LABEL}`], ['launchctl', 'bootstrap', domain, file]], deactivate: [['launchctl', 'bootout', `${domain}/${LABEL}`]], restart: [['launchctl', 'kickstart', '-k', `${domain}/${LABEL}`]], note: `Logs: ${path.join(logDir, 'runner.log')}` };
  }
  if (platform === 'win32') {
    const launcher = path.join(home, 'bin', 'runner.cmd'); const hidden = path.join(home, 'bin', 'runner.vbs');
    const sets = Object.entries(env).map(([key, value]) => `set "${key}=${value}"`).join('\r\n');
    const content = `@echo off\r\n${sets}\r\n"${node}" "${script}" runner >> "${path.join(logDir, 'runner.log')}" 2>&1\r\n`;
    return {
      file: launcher, content,
      // wscript runs the launcher without a console window.
      extraFiles: [{ file: hidden, content: `CreateObject("Wscript.Shell").Run """${launcher}""", 0, False\r\n` }],
      activate: [['schtasks', '/Create', '/TN', TASK, '/SC', 'ONLOGON', '/TR', `wscript.exe "${hidden}"`, '/RL', 'LIMITED', '/F'], ['schtasks', '/Run', '/TN', TASK]],
      deactivate: [['schtasks', '/End', '/TN', TASK], ['schtasks', '/Delete', '/TN', TASK, '/F']],
      restart: [['schtasks', '/End', '/TN', TASK], ['schtasks', '/Run', '/TN', TASK]],
      note: `Runs at logon (hidden window). Logs: ${path.join(logDir, 'runner.log')}`,
    };
  }
  const file = path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'systemd', 'user', UNIT);
  const vars = Object.entries(env).map(([key, value]) => `Environment="${key}=${value.replace(/"/g, '\\"')}"`).join('\n');
  const content = `[Unit]
Description=Agent Office runner (headless Claude Code seats)
After=network-online.target

[Service]
ExecStart="${node}" "${script}" runner
${vars}
Restart=always
RestartSec=5
StandardOutput=append:${path.join(logDir, 'runner.log')}
StandardError=append:${path.join(logDir, 'runner.log')}

[Install]
WantedBy=default.target
`;
  return { file, content, activate: [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', '--now', UNIT]], deactivate: [['systemctl', '--user', 'disable', '--now', UNIT]], restart: [['systemctl', '--user', 'restart', UNIT]], note: `To keep it running after logout: loginctl enable-linger ${process.env.USER ?? '$USER'}. Logs: ${path.join(logDir, 'runner.log')}` };
};

const run = (command: string[], tolerate = false): void => {
  try { execFileSync(command[0]!, command.slice(1), { stdio: tolerate ? 'ignore' : 'inherit' }); }
  catch (error) { if (!tolerate) throw error; }
};

const planFor = (script: string, home: string): ServicePlan => servicePlan(process.platform, process.execPath, script, home, keptEnv(process.env), process.getuid?.() ?? 0);

/** Writes the service definition (0600) and starts it now and at every login. */
export const installService = (script: string, home: string): string => {
  const plan = planFor(script, home);
  mkdirSync(path.join(home, 'logs'), { recursive: true }); mkdirSync(path.dirname(plan.file), { recursive: true });
  writeFileSync(plan.file, plan.content, { mode: 0o600 });
  for (const extra of plan.extraFiles ?? []) writeFileSync(extra.file, extra.content, { mode: 0o600 });
  plan.activate.forEach((command, index) => run(command, index === 0 && process.platform === 'darwin'));
  return `Runner service installed (${plan.file}). ${plan.note}\nKept environment: ${Object.keys(keptEnv(process.env)).join(', ') || 'none'} — API tokens are not copied; put them in the "env" block of ~/.claude/settings.json if Claude needs them.`;
};

export const uninstallService = (script: string, home: string): string => {
  const plan = planFor(script, home);
  for (const command of plan.deactivate) run(command, true);
  for (const file of [plan.file, ...(plan.extraFiles ?? []).map(extra => extra.file)]) if (existsSync(file)) rmSync(file);
  return `Runner service removed (${plan.file}).`;
};

/** Restarts an installed runner service so it loads a freshly updated connector; no-op when none is installed. */
export const restartServiceIfInstalled = (script: string, home: string): boolean => {
  const plan = planFor(script, home);
  if (!existsSync(plan.file)) return false;
  for (const command of plan.restart) run(command, true);
  return true;
};
