import type { JSX } from 'solid-js';
import { AgentModelMenu } from '../AgentModelMenu';

export function TourModelMenu(props: { style?: JSX.CSSProperties; class?: string }) {
  return <AgentModelMenu {...props} label="Tour model" />;
}
