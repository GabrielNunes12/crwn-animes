import { useEffect, useState } from "react";
import { BUTTON_TYPES_CLASSES } from "../../helper/buttonsConfig";
import "./button.scss";

const Button = ({ children, buttonType, ...otherValues }) => {
  const [color, setColor] = useState(BUTTON_TYPES_CLASSES);
  useEffect(() => {
    setColor(BUTTON_TYPES_CLASSES[buttonType]);
  }, [buttonType]);
  return (
    <button className={`button-container ${color}`} {...otherValues}>
      {children}
    </button>
  );
};

export default Button;
