CREATE TABLE customer (
  id INT PRIMARY KEY,
  name VARCHAR(50)
);

CREATE TABLE orders (
  id INT PRIMARY KEY,
  customer_id INT REFERENCES customer(id),
  status VARCHAR(20),
  CHECK (status IN ('DRAFT', 'APPROVED'))
);

CREATE TABLE audit_log (
  id INT PRIMARY KEY,
  event_type VARCHAR(20),
  CHECK (event_type = 'ORDER_UPDATED')
);
