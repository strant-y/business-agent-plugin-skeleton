CREATE TABLE product (
  id INT PRIMARY KEY,
  name VARCHAR(50)
);

CREATE TABLE order_item (
  id INT PRIMARY KEY,
  product_id INT REFERENCES product(id)
);
