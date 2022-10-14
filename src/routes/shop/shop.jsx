import ShopData from "../../anime-data.json";
const Shop = () => {
  return (
    <>
      <h1> Shop data: </h1>
      <div>
        {ShopData.map(({ id, name, imageUrl, price }) => (
          <div key={id}>
            <small> {name} </small>
            <img src={imageUrl} alt={name} />
            <small> R$ {price} </small>
          </div>
        ))}
      </div>
    </>
  );
};

export default Shop;
