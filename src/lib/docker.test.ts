import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DOCKER_IMAGE,
  PROJECT_DOCKER_IMAGE_PREFIX,
  getTaskDockerBadgeLabel,
  getTaskDockerOverlayLabel,
  inferDockerSource,
} from './docker';

describe('docker display labels', () => {
  it('renders project labels from explicit docker source metadata', () => {
    expect(getTaskDockerBadgeLabel('project')).toBe('Docker (project)');
    expect(getTaskDockerOverlayLabel('project')).toBe('project dockerfile');
  });

  it('keeps generic labels for default and custom sources', () => {
    expect(getTaskDockerBadgeLabel('default')).toBe('Docker');
    expect(getTaskDockerBadgeLabel('custom')).toBe('Docker');
    expect(getTaskDockerOverlayLabel('default')).toBe('docker');
    expect(getTaskDockerOverlayLabel('custom')).toBe('docker');
  });
});

describe('inferDockerSource', () => {
  it('returns "default" for the default image', () => {
    expect(inferDockerSource(DEFAULT_DOCKER_IMAGE)).toBe('default');
  });

  it('returns "default" when image is undefined', () => {
    expect(inferDockerSource(undefined)).toBe('default');
  });

  it('returns "project" for any image with the project prefix', () => {
    expect(inferDockerSource(`${PROJECT_DOCKER_IMAGE_PREFIX}abc123`)).toBe('project');
    expect(inferDockerSource(`${PROJECT_DOCKER_IMAGE_PREFIX}unknown`)).toBe('project');
  });

  it('returns "custom" for non-default, non-project images', () => {
    expect(inferDockerSource('my-org/my-agent:v2')).toBe('custom');
    expect(inferDockerSource('parallel-code-agent:nightly')).toBe('custom');
  });
});
