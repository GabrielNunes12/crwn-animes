import "./style.scss";
const CategoryAnimeItem = ({ animeCategory }) => {
  const { title, imgUrl } = animeCategory;
  return (
    <div className="anime-container">
      <section
        title={`name of the ${title} image`}
        className="background-image"
        style={{
          backgroundImage: `url(${imgUrl})`,
        }}
      ></section>
      <section className="anime-body-container">
        <h2>{title}</h2>
        <p>Shop now!</p>
      </section>
    </div>
  );
};

export default CategoryAnimeItem;
