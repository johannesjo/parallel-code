import { createUniqueId, type JSX } from 'solid-js';
import { sectionLabelStyle } from '../lib/theme';
import { sf } from '../lib/fontScale';

/**
 * What to check before merging: an optional lead line such as the verify
 * result, then optional steps such as the review and the change tour, as
 * same-sized boxes one per line. Each step's result opens right below it.
 */
export function FollowUps(props: { children?: JSX.Element; lead?: JSX.Element }) {
  const headingId = createUniqueId();
  return (
    <section
      aria-labelledby={headingId}
      style={{ 'margin-bottom': '28px', 'font-size': sf(13), 'line-height': '1.45' }}
    >
      <h3 id={headingId} style={{ ...sectionLabelStyle, 'font-size': sf(11), margin: '0 0 6px' }}>
        Before you merge
      </h3>
      {props.lead}
      <div class="finish-followups">{props.children}</div>
    </section>
  );
}
