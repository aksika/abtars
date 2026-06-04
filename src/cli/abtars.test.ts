import { describe, expect, it } from 'vitest';
import { main } from './abtars.js';

describe('abtars CLI dispatcher', () => {
  it('help exits 0', async () => {
    expect(await main(['help'])).toBe(0);
  });

  it('no args prints usage and exits 0', async () => {
    expect(await main([])).toBe(0);
  });

  it('unknown subcommand exits 2', async () => {
    expect(await main(['wat'])).toBe(2);
  });

  it('update --source unknown reports not-yet-supported and exits 2', async () => {
    expect(await main(['update', '--source', 'git'])).toBe(2);
  });
});
