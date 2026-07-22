import { describe, expect, it } from 'vitest';
import * as featureCatalog from '../../../src/features/domain/feature-catalog';

describe('feature catalog domain boundary', () => {
  it('does not export a presentation description resolver', () => {
    expect(featureCatalog).not.toHaveProperty('featureDescription');
  });
});
