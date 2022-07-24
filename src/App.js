import { Route, Routes } from "react-router-dom";
import Animes from "./routes/animes";
import Home from "./routes/home";
import Login from "./routes/login";
const Shop = () => {
  return <h1> Hii </h1>;
};
const App = () => {
  return (
    <>
      <Routes>
        <Route path="/" exact element={<Home />}>
          <Route index element={<Animes />} />
          <Route path="shop" element={<Shop />} />
          <Route path="login" element={<Login />} />
        </Route>
      </Routes>
    </>
  );
};

export default App;
