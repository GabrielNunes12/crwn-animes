import CategoryAnimeItem from "../category-anime/index";
import { animesCategory } from "../../helper/animesCategoryList";
import "./style.scss";
const DirectoryAnimes = () => {
  return (
    <section className="animes-container">
      {animesCategory.map((category) => {
        return <CategoryAnimeItem key={category.id} animeCategory={category} />;
      })}
    </section>
  );
};

export default DirectoryAnimes;
