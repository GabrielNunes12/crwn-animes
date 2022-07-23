import HeaderApp from "../components/header-app";
import { Outlet } from "react-router-dom";
const Home = () => {
  return (
    <>
      <HeaderApp />
      <Outlet />
    </>
  );
};

export default Home;
