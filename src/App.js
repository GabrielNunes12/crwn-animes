import { useContext } from "react";
import { Route, Routes } from "react-router-dom";
import { UserContext } from "./contexts/User.context";
import Animes from "./routes/animes";
import Home from "./routes/home";
import Auth from "./routes/auth";
const Shop = () => {
  return <h1> Hii </h1>;
};
const App = () => {
  const { user } = useContext(UserContext);
  return (
    <>
      <Routes>
        <Route path="/" exact element={<Home />}>
          <Route index element={<Animes />} />
          <Route path="shop" element={<Shop />} />
          <Route path="auth" element={<Auth />} />
        </Route>
      </Routes>
    </>
  );
};

export default App;
