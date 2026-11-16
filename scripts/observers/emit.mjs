import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Sends only explicitly selected public fields. Does not register tools or add context.
export function emit(event) {
  try {
    const path = process.env.TASKTAP_OBSERVER_CONFIG;
    if (!path) return;
    const config = JSON.parse(readFileSync(path, 'utf8'));
    spawnSync(process.env.TASKTAP_OBSERVER_PYTHON, [process.env.TASKTAP_OBSERVER_SCRIPT,
      'ingest', path.slice(0, path.lastIndexOf('/')), config.token, config.agent, '--normalized'],
    { input: JSON.stringify(event), stdio: ['pipe', 'ignore', 'ignore'], timeout: 3000 });
  } catch { /* Observation never blocks or changes the provider's work. */ }
}
