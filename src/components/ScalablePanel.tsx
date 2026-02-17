import { onMount } from "solid-js";
import { getFontScale, adjustFontScale } from "../store/store";
import type { JSX } from "solid-js";

interface ScalablePanelProps {
  panelId: string;
  children: JSX.Element;
  style?: JSX.CSSProperties;
}

export function ScalablePanel(props: ScalablePanelProps) {
  let ref!: HTMLDivElement;
  onMount(() => {
    ref.addEventListener("wheel", (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      adjustFontScale(props.panelId, e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
  });

  return (
    <div
      ref={ref}
      style={{
        "--font-scale": String(getFontScale(props.panelId)),
        width: "100%",
        height: "100%",
        ...props.style,
      }}
    >
      {props.children}
    </div>
  );
}
