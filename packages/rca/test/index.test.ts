import { describe, expect, it } from 'vitest';
import { RCA_PACKAGE } from '../src/index';

describe('package entry', () => {
  it('exports the package name', () => {
    expect(RCA_PACKAGE).toBe('@datatrust/rca');
  });
});
