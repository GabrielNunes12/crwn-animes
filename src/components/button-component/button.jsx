import { BUTTON_TYPES_CLASSES } from "../../helper/buttonsConfig";
import "./button.scss";

const Button = ({ children, buttonType, ...otherValues }) => {
  return (
    <button
      className={`button-container ${BUTTON_TYPES_CLASSES[buttonType]}}`}
      {...otherValues}
    >
      {children}
    </button>
  );
};

export default Button;
