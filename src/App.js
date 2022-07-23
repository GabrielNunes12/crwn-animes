import { Route, Routes } from "react-router-dom";
import Animes from "./routes/animes";
import Home from "./routes/home";
const Shop = () => {
  return <h1> Hii </h1>;
};
const App = () => {
  return (
    <>
      <Routes>
        <Route path="/" exact element={<Home />}>
          <Route path="shop" element={<Shop />} />
          <Route path="animes" element={<Animes />} />
        </Route>
      </Routes>
    </>
  );
};

export default App;
