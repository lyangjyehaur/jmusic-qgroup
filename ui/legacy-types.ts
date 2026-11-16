import type React from "react";

// Attribute bag at the HTML-to-React boundary. Native controls narrow these
// attributes to their actual element/component before forwarding them.
export type LegacyProps = Omit<React.AllHTMLAttributes<HTMLElement>, "size"> & {
  size?: number;
  [attribute: `data-${string}`]: string | undefined;
};
export type SelectModel = HTMLSelectElement & { __uiSync?: () => void };
export type DisclosureModel = HTMLDivElement & { open?: boolean };
