import { describe, expect, it } from 'vitest';
import { portfolioProjects } from './content';

describe('portfolio metadata', () => {
  it('labels incomplete work instead of claiming shipped implementations', () => {
    expect(portfolioProjects).toHaveLength(3);
    expect(portfolioProjects.every((project) => /PROGRESS|PLANNED/.test(project.tag))).toBe(true);
  });
});
