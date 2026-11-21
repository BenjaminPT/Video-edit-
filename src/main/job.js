'use strict';

const { spawn } = require('child_process');

class CancelledError extends Error {
  constructor() {
    super('Отменено');
    this.name = 'CancelledError';
  }
}

// Одна задача нарезки: следит за дочерними процессами и умеет их остановить.
class Job {
  constructor() {
    this.cancelled = false;
    this.children = new Set();
  }

  throwIfCancelled() {
    if (this.cancelled) throw new CancelledError();
  }

  spawn(cmd, args, options = {}) {
    this.throwIfCancelled();
    const child = spawn(cmd, args, { windowsHide: true, ...options });
    this.children.add(child);
    child.once('close', () => this.children.delete(child));
    return child;
  }

  // Запускает процесс до конца. onStdout / onStderr получают Buffer.
  run(cmd, args, { onStdout, onStderr, env } = {}) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawn(cmd, args, env ? { env: { ...process.env, ...env } } : {});
      } catch (err) {
        reject(err);
        return;
      }
      let stderrTail = '';
      child.stdout.on('data', (d) => onStdout && onStdout(d));
      child.stderr.on('data', (d) => {
        stderrTail = (stderrTail + d.toString()).slice(-4000);
        if (onStderr) onStderr(d);
      });
      child.once('error', reject);
      child.once('close', (code) => {
        if (this.cancelled) reject(new CancelledError());
        else resolve({ code, stderr: stderrTail });
      });
    });
  }

  cancel() {
    this.cancelled = true;
    for (const child of this.children) {
      try {
        child.kill();
      } catch (_) {
        /* уже завершён */
      }
    }
  }
}

module.exports = { Job, CancelledError };
