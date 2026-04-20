import { describe, expect, it } from 'vitest';
import { main } from './agentbridge.js';

describe('agentbridge CLI dispatcher', () => {
  it('help exits 0', async () => {
    expect(await main(['help'])).toBe(0);
  });

  it('no args prints usage and exits 0', async () => {
    expect(await main([])).toBe(0);
  });

  it('unknown subcommand exits 2', async () => {
    expect(await main(['wat'])).toBe(2);
  });

  it('update --source npm reports not-yet-supported and exits 2', async () => {
    // Note: this depends on update command short-circuiting before touching disk.
    // Since we're not on a real install, even --source local would fail in weird
    // ways — but --source npm returns 2 before any I/O.
    expect(await main(['update', '--source', 'npm'])).toBe(2);
  });
});
