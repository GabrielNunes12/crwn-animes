import { Link } from "react-router-dom";
import "./style.scss";
const HeaderApp = () => {
  return (
    <>
      <header> Crwn Animes </header>
      <small> E-commerce </small>
      <section className="options">
        <Link to="/shop">Shop</Link>
        <Link to="/">Animes</Link>
        <Link to="/auth">Sign in</Link>
      </section>
    </>
  );
};
export default HeaderApp;
