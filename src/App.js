import { Route, Routes } from "react-router-dom";
import Animes from "./routes/animes";
import Home from "./routes/home";
import Auth from "./routes/auth";
import Shop from "./routes/shop/shop";
const App = () => {
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
