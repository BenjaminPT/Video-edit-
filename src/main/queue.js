'use strict';

const { CancelledError } = require('./job');

/**
 * Ограничитель параллельности: не больше `limit` задач одновременно, остальные ждут в очереди.
 * Ожидающая задача выходит из очереди при отмене своего Job.
 */
class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.waiting = [];
  }

  // Возвращает функцию release; её нужно вызвать, когда задача закончилась.
  acquire(job) {
    return new Promise((resolve, reject) => {
      if (job && job.cancelled) {
        reject(new CancelledError());
        return;
      }
      const grant = () => {
        this.active += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active -= 1;
          this.next();
        });
      };
      if (this.active < this.limit) {
        grant();
        return;
      }
      const entry = { grant };
      this.waiting.push(entry);
      if (job) {
        job.onCancel(() => {
          const i = this.waiting.indexOf(entry);
          if (i >= 0) {
            this.waiting.splice(i, 1);
            reject(new CancelledError());
          }
        });
      }
    });
  }

  next() {
    while (this.active < this.limit && this.waiting.length > 0) this.waiting.shift().grant();
  }
}

module.exports = { Semaphore };
