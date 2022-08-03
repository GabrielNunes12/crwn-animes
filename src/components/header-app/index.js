import { useContext } from "react";
import { UserContext } from "../../contexts/User.context";

import { Link } from "react-router-dom";
import "./style.scss";
const HeaderApp = () => {
  const { user } = useContext(UserContext);
  return (
    <>
      <header> Crwn Animes </header>
      <small> E-commerce </small>
      <section className="options">
        <Link to="/shop">Shop</Link>
        <Link to="/">Animes</Link>
        {user ? (
          <Link to="/auth">Sign out</Link>
        ) : (
          <Link to="/auth">Sign in</Link>
        )}
      </section>
    </>
  );
};
export default HeaderApp;
