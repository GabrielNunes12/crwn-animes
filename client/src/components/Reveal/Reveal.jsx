import { useReveal } from "../../hooks/useReveal.js";
import styles from "./Reveal.module.css";

/**
 * <Reveal index={i}> fades/slides its content in once when scrolled into view.
 * `index` staggers grids through the --i custom property.
 * `variant="scroll"` uses CSS scroll-driven animations where supported.
 */
export function Reveal({ as: Tag = "div", index = 0, variant = "io", className = "", style, children, ...rest }) {
  const { ref, revealed, mode } = useReveal({ variant });
  return (
    <Tag
      ref={ref}
      className={`${styles.reveal} ${className}`.trim()}
      data-reveal={mode}
      data-revealed={revealed ? "true" : "false"}
      style={{ "--i": Math.min(index, 12), ...style }}
      {...rest}
    >
      {children}
    </Tag>
  );
}
